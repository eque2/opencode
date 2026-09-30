import path from "path"
import { Telemetry } from "@opencode-ai/core/observability/telemetry"
import { pathToFileURL, fileURLToPath } from "url"
import {
  createMessageConnection,
  NotificationType,
  RequestType,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import { stop } from "./launch"
import { LANGUAGE_EXTENSIONS } from "./language"
import {
  Array as Arr,
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  HashMap,
  MutableHashMap,
  MutableHashSet,
  Option,
  Predicate,
  PubSub,
  Ref,
  Schema,
} from "effect"
import { constVoid } from "effect/Function"
import type * as LSPServer from "./server"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { InstanceContext } from "@/project/instance-context"

const DIAGNOSTICS_DEBOUNCE_MS = 150
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
const DIAGNOSTICS_REQUEST_TIMEOUT = Duration.seconds(3)

const INITIALIZE_TIMEOUT = Duration.seconds(45)

// LSP spec constants
const FILE_CHANGE_CREATED = 1
const FILE_CHANGE_CHANGED = 2
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

export type Diagnostic = VSCodeDiagnostic

export class InitializeError extends Schema.TaggedError<InitializeError>()("LSPInitializeError", {
  serverID: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type DocumentDiagnosticReport = {
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DocumentDiagnosticReport>
}

type WorkspaceDiagnosticReport = {
  items?: {
    uri?: string
    items?: Diagnostic[]
  }[]
}

type DiagnosticEntry = readonly [string, ReadonlyArray<Diagnostic>]

type DiagnosticRequestResult = {
  handled: boolean
  matched: boolean
  byFile: MutableHashMap.MutableHashMap<string, Diagnostic[]>
}

type DiagnosticRequestOutcome = { handled: boolean; matched: boolean }

type CapabilityRegistration = {
  id: string
  method: string
  registerOptions?: {
    identifier?: string
    workspaceDiagnostics?: boolean
  }
}

type ServerCapabilities = {
  textDocumentSync?:
    | number
    | {
        change?: number
      }
  diagnosticProvider?: unknown
  [key: string]: unknown
}

type PushStamp = { at: number; version: Option.Option<number> }

type DiagnosticWaitRequest = { path: string; version: number; after?: number }

// Typed message types let vscode-jsonrpc hand the handlers typed params.
const PublishDiagnostics = new NotificationType<{ uri: string; version?: unknown; diagnostics: Diagnostic[] }>(
  "textDocument/publishDiagnostics",
)
const WorkspaceConfiguration = new RequestType<{ items?: { section?: string }[] }, unknown[], void>(
  "workspace/configuration",
)
const RegisterCapability = new RequestType<{ registrations?: CapabilityRegistration[] }, void, void>(
  "client/registerCapability",
)
const UnregisterCapability = new RequestType<{ unregisterations?: { id: string; method: string }[] }, void, void>(
  "client/unregisterCapability",
)

const unhandled: DiagnosticRequestOutcome = { handled: false, matched: false }

function getSyncKind(capabilities?: ServerCapabilities) {
  const sync = capabilities?.textDocumentSync
  return typeof sync === "number" ? sync : sync?.change
}

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

// Effect's structural hashing compares the key fields of two diagnostics by value.
function dedupeDiagnostics(items: ReadonlyArray<Diagnostic>) {
  const seen = MutableHashSet.empty<unknown>()
  return items.filter((item) => {
    const key = {
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    }
    if (MutableHashSet.has(seen, key)) return false
    MutableHashSet.add(seen, key)
    return true
  })
}

function collectDiagnostics(entries: Iterable<DiagnosticEntry>) {
  const byFile = MutableHashMap.empty<string, Diagnostic[]>()
  for (const [target, items] of entries) {
    MutableHashMap.set(byFile, target, [...Option.getOrElse(MutableHashMap.get(byFile, target), () => []), ...items])
  }
  return byFile
}

function configurationValue(settings: unknown, section?: string) {
  if (!section) return Option.fromNullishOr(settings)
  return section
    .split(".")
    .reduce(
      (acc, key) =>
        Option.flatMap(acc, (value) =>
          Predicate.isObjectOrArray(value) && Predicate.hasProperty(value, key)
            ? Option.fromNullishOr(value[key])
            : Option.none(),
        ),
      Option.fromNullishOr(settings),
    )
}

// TypeScript's built-in LSP pushes diagnostics aggressively on first open.
// We seed the push cache on the very first publish so waitForFreshPush can
// resolve immediately instead of waiting for a second debounced push.
function shouldSeedDiagnosticsOnFirstPush(serverID: string) {
  return serverID === "typescript"
}

type CreateInput = {
  serverID: string
  server: LSPServer.Handle
  root: string
  directory: string
  instance: InstanceContext
}

// The client normalizes paths with FSUtil, which the Promise boundary provides.
const fileSystemLayer = LayerNode.compile(FSUtil.node)

// The Promise-returning client is the contract that src/lsp/lsp.ts and the tests call.
export function create(input: CreateInput) {
  return Effect.runPromise(make(input).pipe(Effect.provide(fileSystemLayer)))
}

const make = Effect.fn("LSPClient.create")(function* (input: CreateInput) {
  const fs = yield* FSUtil.Service
  const getFilePath = (uri: string) =>
    uri.startsWith("file://")
      ? fs.normalizePath(fileURLToPath(uri)).pipe(Effect.map(Option.some))
      : Effect.succeed(Option.none<string>())
  const connection = createMessageConnection(
    new StreamMessageReader(input.server.process.stdout),
    new StreamMessageWriter(input.server.process.stdin),
  )
  // Server stderr goes to Datadog only, one short record per chunk, so the file log does not grow with it. The text
  // travels under `output`, a content key, because language servers print paths and source: the sink omits it by
  // default and sends it only when the content policy is `full`.
  input.server.process.stderr?.on("data", (chunk: Buffer) => {
    Effect.runFork(
      Telemetry.record("Info", "LSP stderr", {
        category: "lsp.stderr",
        serverID: input.serverID,
        bytes: chunk.length,
        output: chunk.toString("utf8").slice(0, 500),
      }),
    )
  })
  // --- Connection state ---

  const pushDiagnostics = MutableHashMap.empty<string, Diagnostic[]>()
  const pullDiagnostics = MutableHashMap.empty<string, Diagnostic[]>()
  const published = MutableHashMap.empty<string, PushStamp>()
  const diagnosticRegistrations = MutableHashMap.empty<string, CapabilityRegistration>()
  const files = MutableHashMap.empty<string, { version: number; text: string }>()
  const registrationChanges = yield* PubSub.unbounded<ReadonlyArray<string>>()
  const pushes = yield* PubSub.unbounded<string>()

  const diagnosticsFor = (store: MutableHashMap.MutableHashMap<string, Diagnostic[]>, filePath: string) =>
    Option.getOrElse(MutableHashMap.get(store, filePath), () => [])
  const mergedDiagnostics = (filePath: string) =>
    dedupeDiagnostics([...diagnosticsFor(pushDiagnostics, filePath), ...diagnosticsFor(pullDiagnostics, filePath)])

  const onPublishDiagnostics = Effect.fnUntraced(function* (params: {
    uri: string
    version?: unknown
    diagnostics: Diagnostic[]
  }) {
    const filePath = yield* getFilePath(params.uri)
    if (Option.isNone(filePath)) return
    MutableHashMap.set(published, filePath.value, {
      at: yield* Clock.currentTimeMillis,
      version: Predicate.isNumber(params.version) ? Option.some(params.version) : Option.none(),
    })
    if (shouldSeedDiagnosticsOnFirstPush(input.serverID) && !MutableHashMap.has(pushDiagnostics, filePath.value)) {
      MutableHashMap.set(pushDiagnostics, filePath.value, params.diagnostics)
      return
    }
    MutableHashMap.set(pushDiagnostics, filePath.value, params.diagnostics)
    yield* PubSub.publish(pushes, filePath.value)
  })

  const emitRegistrationChange = (ids: ReadonlyArray<string>) => {
    if (ids.length) Effect.runFork(PubSub.publish(registrationChanges, ids))
  }

  // --- LSP connection handlers ---
  // vscode-jsonrpc calls these handlers synchronously, so each one forks its Effect work.
  // A handler that returns nothing replies with a JSON-RPC null result.

  connection.onNotification(PublishDiagnostics, (params) => {
    Effect.runFork(onPublishDiagnostics(params))
  })
  connection.onRequest("window/workDoneProgress/create", constVoid)
  connection.onRequest(WorkspaceConfiguration, (params) =>
    (params.items ?? []).map((item) => Option.getOrNull(configurationValue(input.server.initialization, item.section))),
  )
  connection.onRequest(RegisterCapability, (params) => {
    const added = (params.registrations ?? []).filter(
      (registration) => registration.method === "textDocument/diagnostic",
    )
    added.forEach((registration) => MutableHashMap.set(diagnosticRegistrations, registration.id, registration))
    emitRegistrationChange(added.map((registration) => registration.id))
  })
  connection.onRequest(UnregisterCapability, (params) => {
    const removed = (params.unregisterations ?? []).filter(
      (registration) => registration.method === "textDocument/diagnostic",
    )
    removed.forEach((registration) => MutableHashMap.remove(diagnosticRegistrations, registration.id))
    emitRegistrationChange(removed.map((registration) => registration.id))
  })
  connection.onRequest("workspace/workspaceFolders", () => [
    {
      name: "workspace",
      uri: pathToFileURL(input.root).href,
    },
  ])
  connection.onRequest("workspace/diagnostic/refresh", constVoid)
  connection.listen()

  const sendNotification = (method: string, params: object) =>
    Effect.tryPromise(() => connection.sendNotification(method, params))

  // --- Initialize handshake ---

  const initialized = yield* Effect.tryPromise(() =>
    connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
      rootUri: pathToFileURL(input.root).href,
      processId: input.server.process.pid,
      workspaceFolders: [
        {
          name: "workspace",
          uri: pathToFileURL(input.root).href,
        },
      ],
      initializationOptions: {
        ...input.server.initialization,
      },
      capabilities: {
        window: {
          workDoneProgress: true,
        },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
          diagnostics: {
            refreshSupport: false,
          },
        },
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
          },
          diagnostic: {
            dynamicRegistration: true,
            relatedDocumentSupport: true,
          },
          publishDiagnostics: {
            versionSupport: false,
          },
        },
      },
    }),
  ).pipe(
    Effect.timeout(INITIALIZE_TIMEOUT),
    Effect.mapError((cause) => new InitializeError({ serverID: input.serverID, cause })),
  )

  const syncKind = getSyncKind(initialized.capabilities)
  const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider)

  yield* sendNotification("initialized", {})

  if (input.server.initialization) {
    yield* sendNotification("workspace/didChangeConfiguration", {
      settings: input.server.initialization,
    })
  }

  // --- Diagnostic helpers ---

  const mergeResults = (filePath: string, results: ReadonlyArray<DiagnosticRequestResult>) => {
    const handled = results.some((result) => result.handled)
    const matched = results.some((result) => result.matched)
    if (!handled) return unhandled

    const merged = collectDiagnostics(results.flatMap((result) => Arr.fromIterable(result.byFile)))
    if (matched && !MutableHashMap.has(merged, filePath)) MutableHashMap.set(merged, filePath, [])
    MutableHashMap.forEach(merged, (items, target) =>
      MutableHashMap.set(pullDiagnostics, target, dedupeDiagnostics(items)),
    )

    return { handled, matched }
  }

  // A failed or timed-out pull request, or a null report, counts as no report.
  const pullReport = <A>(method: string, params: object) =>
    Effect.tryPromise(() => connection.sendRequest<A | null>(method, params)).pipe(
      Effect.timeout(DIAGNOSTICS_REQUEST_TIMEOUT),
      Effect.option,
      Effect.map((report) => Option.flatMap(report, (value) => Option.fromNullishOr(value))),
    )

  const emptyResult = (): DiagnosticRequestResult => ({
    handled: false,
    matched: false,
    byFile: MutableHashMap.empty<string, Diagnostic[]>(),
  })

  const requestDiagnosticReport = Effect.fnUntraced(function* (filePath: string, identifier?: string) {
    const report = yield* pullReport<DocumentDiagnosticReport>("textDocument/diagnostic", {
      ...(identifier ? { identifier } : {}),
      textDocument: {
        uri: pathToFileURL(filePath).href,
      },
    })
    if (Option.isNone(report)) return emptyResult()

    const direct: DiagnosticEntry[] = Array.isArray(report.value.items) ? [[filePath, report.value.items]] : []
    const related = yield* Effect.forEach(Object.entries(report.value.relatedDocuments ?? {}), ([uri, document]) =>
      getFilePath(uri).pipe(
        Effect.map(
          Option.match({
            onNone: (): DiagnosticEntry[] => [],
            onSome: (relatedPath): DiagnosticEntry[] =>
              Array.isArray(document.items) ? [[relatedPath, document.items]] : [],
          }),
        ),
      ),
    ).pipe(Effect.map(Arr.flatten))
    const entries = [...direct, ...related]

    return {
      handled: entries.length > 0,
      matched: entries.some(([target]) => target === filePath),
      byFile: collectDiagnostics(entries),
    }
  })

  const requestWorkspaceDiagnosticReport = Effect.fnUntraced(function* (filePath: string, identifier?: string) {
    const report = yield* pullReport<WorkspaceDiagnosticReport>("workspace/diagnostic", {
      ...(identifier ? { identifier } : {}),
      previousResultIds: [],
    })
    if (Option.isNone(report)) return emptyResult()

    const entries = yield* Effect.forEach(report.value.items ?? [], (item) =>
      (item.uri ? getFilePath(item.uri) : Effect.succeed(Option.none<string>())).pipe(
        Effect.map(
          Option.match({
            onNone: (): DiagnosticEntry[] => [],
            onSome: (relatedPath): DiagnosticEntry[] => (Array.isArray(item.items) ? [[relatedPath, item.items]] : []),
          }),
        ),
      ),
    ).pipe(Effect.map(Arr.flatten))

    return {
      handled: true,
      matched: entries.some(([target]) => target === filePath),
      byFile: collectDiagnostics(entries),
    }
  })

  const registrations = (workspace: boolean) =>
    Arr.fromIterable(MutableHashMap.values(diagnosticRegistrations)).filter(
      (registration) => (registration.registerOptions?.workspaceDiagnostics === true) === workspace,
    )
  const identifiers = (items: ReadonlyArray<CapabilityRegistration>) =>
    Arr.dedupe(items.flatMap((registration) => registration.registerOptions?.identifier ?? []))

  function documentPullState() {
    const documentRegistrations = registrations(false)
    return {
      documentIdentifiers: identifiers(documentRegistrations),
      supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
    }
  }

  function workspacePullState() {
    const workspaceRegistrations = registrations(true)
    return {
      workspaceIdentifiers: identifiers(workspaceRegistrations),
      supported: workspaceRegistrations.length > 0,
    }
  }

  const hasCurrentFileDiagnostics = (filePath: string, results: ReadonlyArray<DiagnosticRequestResult>) =>
    results.some((result) => diagnosticsFor(result.byFile, filePath).length > 0)

  // Every request keeps merging its report when it completes, even after the wait returns.
  const requestDiagnostics = Effect.fnUntraced(function* (
    filePath: string,
    requests: ReadonlyArray<Effect.Effect<DiagnosticRequestResult>>,
    done: (results: ReadonlyArray<DiagnosticRequestResult>) => boolean,
  ) {
    if (!requests.length) return unhandled

    const results = yield* Ref.make<ReadonlyArray<DiagnosticRequestResult>>([])
    const outcome = yield* Deferred.make<DiagnosticRequestOutcome>()
    yield* Effect.forEach(
      requests,
      (request) =>
        request.pipe(
          Effect.flatMap((result) => Ref.updateAndGet(results, Arr.append(result))),
          Effect.flatMap((all) => {
            const merged = mergeResults(filePath, all)
            if (!done(all) && all.length < requests.length) return Effect.void
            return Deferred.succeed(outcome, merged)
          }),
          Effect.forkDetach,
        ),
      { discard: true },
    )
    return yield* Deferred.await(outcome)
  })

  // LATENCY-CRITICAL: dispatch identifier pulls in parallel and unblock once one
  // batch already produced diagnostics for the current file. Let slower pulls keep
  // merging in the background; do not sequence identifier-by-identifier, and do
  // not add a post-match settle/debounce delay. See PR #23771.
  const requestDocumentDiagnostics = (filePath: string) => {
    const state = documentPullState()
    if (!state.supported) return Effect.succeed(unhandled)
    return requestDiagnostics(
      filePath,
      [
        requestDiagnosticReport(filePath),
        ...state.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
      ],
      (results) => hasCurrentFileDiagnostics(filePath, results),
    )
  }

  const requestFullDiagnostics = (filePath: string) => {
    const documentState = documentPullState()
    const workspaceState = workspacePullState()
    if (!documentState.supported && !workspaceState.supported) return Effect.succeed(unhandled)
    return Effect.all(
      [
        ...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
        ...documentState.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
        ...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
        ...workspaceState.workspaceIdentifiers.map((identifier) =>
          requestWorkspaceDiagnosticReport(filePath, identifier),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map((results) => mergeResults(filePath, results)))
  }

  // Succeeds with true when a diagnostic registration changes within the timeout.
  const waitForRegistrationChange = (timeout: number) =>
    timeout <= 0
      ? Effect.succeed(false)
      : Effect.scoped(PubSub.subscribe(registrationChanges).pipe(Effect.flatMap(PubSub.take), Effect.as(true))).pipe(
          Effect.timeoutOrElse({ duration: Duration.millis(timeout), orElse: () => Effect.succeed(false) }),
        )

  // A push counts when it carries the requested version, or carries no version
  // and arrived after the wait started.
  const freshPush = (request: { path: string; version: number; after: number }) =>
    Option.filter(
      MutableHashMap.get(published, request.path),
      (hit) =>
        Option.exists(hit.version, (version) => version === request.version) ||
        (Option.isNone(hit.version) && hit.at >= request.after),
    )

  const debounceElapsed = (hit: PushStamp) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Effect.sleep(Duration.millis(Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (now - hit.at))))),
    )

  // Settles once the latest fresh push has been quiet for the debounce window.
  // A push for the path that is not fresh keeps the pending debounce running.
  const settlePush = (
    request: { path: string; version: number; after: number },
    subscription: PubSub.Subscription<string>,
    pending: Option.Option<PushStamp>,
  ): Effect.Effect<boolean> => {
    const nextPush = PubSub.take(subscription).pipe(
      Effect.repeat({ until: (pushed) => pushed === request.path }),
      Effect.as(false),
    )
    const step = Option.match(pending, {
      onNone: () => nextPush,
      onSome: (hit) => Effect.raceFirst(debounceElapsed(hit).pipe(Effect.as(true)), nextPush),
    })
    return step.pipe(
      Effect.flatMap((settled) =>
        settled
          ? Effect.succeed(true)
          : settlePush(
              request,
              subscription,
              Option.orElse(freshPush(request), () => pending),
            ),
      ),
    )
  }

  const waitForFreshPush = (
    request: { path: string; version: number; after: number; timeout: number },
    subscription: PubSub.Subscription<string>,
  ) =>
    request.timeout <= 0
      ? Effect.succeed(false)
      : settlePush(request, subscription, freshPush(request)).pipe(
          Effect.timeoutOrElse({ duration: Duration.millis(request.timeout), orElse: () => Effect.succeed(false) }),
        )

  // Pulls diagnostics until a pull satisfies `finished`. Between pulls it waits
  // for a fresh push, which ends the wait, or a registration change, which pulls again.
  const waitForPulledDiagnostics = Effect.fnUntraced(function* (
    request: DiagnosticWaitRequest,
    timeout: number,
    pull: (filePath: string) => Effect.Effect<DiagnosticRequestOutcome>,
    finished: (outcome: DiagnosticRequestOutcome) => boolean,
  ) {
    const startedAt = request.after ?? (yield* Clock.currentTimeMillis)
    const subscription = yield* PubSub.subscribe(pushes)
    const pushWait = yield* waitForFreshPush(
      { path: request.path, version: request.version, after: startedAt, timeout },
      subscription,
    ).pipe(Effect.forkScoped)
    const elapsed = Clock.currentTimeMillis.pipe(Effect.map((now) => now - startedAt))

    while ((yield* elapsed) < timeout) {
      const outcome = yield* pull(request.path)
      if (finished(outcome)) return
      const remaining = timeout - (yield* elapsed)
      if (remaining <= 0) return
      const registrationChanged = yield* Effect.raceFirst(
        Fiber.join(pushWait).pipe(Effect.as(false)),
        waitForRegistrationChange(remaining),
      )
      if (!registrationChanged) return
    }
  }, Effect.scoped)

  // --- Public API ---

  const open = Effect.fn("LSPClient.open")(function* (request: { path: string }) {
    request.path = yield* fs.normalizePath(
      path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
    )
    const filePath = request.path
    const text = yield* fs.readFileString(filePath)
    const extension = path.extname(filePath)
    const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

    const document = MutableHashMap.get(files, filePath)
    if (Option.isSome(document)) {
      // Do not wipe diagnostics on didChange. Some servers (e.g. clangd) only
      // re-emit diagnostics when the content actually changes, so clearing
      // here would lose errors for no-op touchFile calls. Let the server's
      // next push/pull overwrite naturally.
      yield* sendNotification("workspace/didChangeWatchedFiles", {
        changes: [
          {
            uri: pathToFileURL(filePath).href,
            type: FILE_CHANGE_CHANGED,
          },
        ],
      })

      const next = document.value.version + 1
      MutableHashMap.set(files, filePath, { version: next, text })
      yield* sendNotification("textDocument/didChange", {
        textDocument: {
          uri: pathToFileURL(filePath).href,
          version: next,
        },
        contentChanges:
          syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
            ? [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: endPosition(document.value.text),
                  },
                  text,
                },
              ]
            : [{ text }],
      })
      return next
    }

    yield* sendNotification("workspace/didChangeWatchedFiles", {
      changes: [
        {
          uri: pathToFileURL(filePath).href,
          type: FILE_CHANGE_CREATED,
        },
      ],
    })

    MutableHashMap.remove(pushDiagnostics, filePath)
    MutableHashMap.remove(pullDiagnostics, filePath)
    yield* sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(filePath).href,
        languageId,
        version: 0,
        text,
      },
    })
    MutableHashMap.set(files, filePath, { version: 0, text })
    return 0
  })

  const waitForDiagnostics = Effect.fn("LSPClient.waitForDiagnostics")(function* (request: {
    path: string
    version: number
    mode?: "document" | "full"
    after?: number
  }) {
    const normalized = {
      path: yield* fs.normalizePath(
        path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
      ),
      version: request.version,
      after: request.after,
    }
    if (request.mode === "document") {
      yield* waitForPulledDiagnostics(
        normalized,
        DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS,
        requestDocumentDiagnostics,
        (outcome) => outcome.matched,
      )
      return
    }
    yield* waitForPulledDiagnostics(
      normalized,
      DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS,
      requestFullDiagnostics,
      (outcome) => outcome.handled || outcome.matched,
    )
  })

  const shutdown = Effect.fn("LSPClient.shutdown")(function* () {
    connection.end()
    connection.dispose()
    yield* stop(input.server.process)
  })

  return {
    root: input.root,
    get serverID() {
      return input.serverID
    },
    get connection() {
      return connection
    },
    notify: {
      open: (request: { path: string }) => Effect.runPromise(open(request)),
    },
    get diagnostics() {
      const keys = Arr.dedupe([...MutableHashMap.keys(pushDiagnostics), ...MutableHashMap.keys(pullDiagnostics)])
      return HashMap.fromIterable(keys.map((key): [string, Diagnostic[]] => [key, mergedDiagnostics(key)]))
    },
    waitForDiagnostics: (request: { path: string; version: number; mode?: "document" | "full"; after?: number }) =>
      Effect.runPromise(waitForDiagnostics(request)),
    shutdown: () => Effect.runPromise(shutdown()),
  }
})

export * as LSPClient from "./client"
