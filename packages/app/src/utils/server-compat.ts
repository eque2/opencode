import { Clock, Data, Effect, MutableHashMap, Option, Predicate, Schema } from "effect"
import type { ServerApi } from "./server"
import type { ServerProtocol } from "./server-protocol"
import type { AgentPartInput, FilePartInput, OpencodeClient, Session, TextPartInput } from "@opencode-ai/sdk/v2/client"
import type {
  Project,
  ProjectCurrent,
  SessionApi,
  SessionCommandInput,
  SessionCommandOutput,
  SessionCompactInput,
  SessionCompactOutput,
  SessionInfo,
  SessionPromptInput,
  SessionPromptOutput,
  SessionShellInput,
  SessionShellOutput,
} from "@opencode-ai/client/promise"

type LegacyClient = OpencodeClient
type LegacyFor = (directory?: string) => LegacyClient
type CompatibleSessionApi = Omit<
  SessionApi,
  "prompt" | "command" | "shell" | "compact" | "rename" | "archive" | "remove"
> & {
  prompt: (input: SessionPromptInput & LegacyPrompt) => Promise<SessionPromptOutput>
  command: (input: SessionCommandInput) => Promise<SessionCommandOutput>
  shell: (input: SessionShellInput & LegacyPrompt) => Promise<SessionShellOutput>
  compact: (input: SessionCompactInput & { model?: LegacyPrompt["model"] }) => Promise<SessionCompactOutput>
  rename: (input: Parameters<SessionApi["rename"]>[0] & LegacyLocation) => ReturnType<SessionApi["rename"]>
  // archive: (input: Parameters<SessionApi["archive"]>[0] & LegacyLocation) => ReturnType<SessionApi["archive"]>
  remove: (input: Parameters<SessionApi["remove"]>[0] & LegacyLocation) => ReturnType<SessionApi["remove"]>
}
type CompatiblePermissionApi = Omit<ServerApi["permission"], "reply"> & {
  reply: (
    input: Parameters<ServerApi["permission"]["reply"]>[0] & { location?: { directory?: string } },
  ) => ReturnType<ServerApi["permission"]["reply"]>
}
export type CompatibleApi = Omit<ServerApi, "session" | "permission"> & {
  readonly session: CompatibleSessionApi
  readonly permission: CompatiblePermissionApi
}
type LegacyPrompt = {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  legacyParts?: (TextPartInput | FilePartInput | AgentPartInput)[]
}
type LegacyLocation = { directory?: string }
type CompatibleInput = {
  protocol: Promise<ServerProtocol>
  current: ServerApi
  legacy: LegacyFor
  directory?: string
}

function mime(uri: string) {
  const match = /^data:([^;,]+)/.exec(uri)
  return match?.[1] ?? "application/octet-stream"
}

function sessionInfo(session: Session): SessionInfo {
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID,
    agent: session.agent,
    model: session.model && {
      id: session.model.id,
      providerID: session.model.providerID,
      variant: session.model.variant,
    },
    cost: session.cost ?? 0,
    tokens: session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: session.time,
    title: session.title,
    location: { directory: session.directory, workspaceID: session.workspaceID },
    subpath: session.path,
    revert: session.revert && {
      messageID: session.revert.messageID,
      partID: session.revert.partID,
      snapshot: session.revert.snapshot,
    },
  }
}

/** A V1 SDK request rejected. `cause` holds the original rejection. */
class CompatRequestError extends Data.TaggedError("App.CompatRequestError")<{ readonly cause: unknown }> {}

/** The API that the protocol selected has no method or namespace under the requested name. */
class ApiUnavailableError extends Schema.TaggedError<ApiUnavailableError>()("App.ApiUnavailableError", {
  message: Schema.String,
}) {}

/** A V1 request succeeded, but its response has no data for the requested item. */
class LegacyMissingDataError extends Schema.TaggedError<LegacyMissingDataError>()("App.LegacyMissingDataError", {
  message: Schema.String,
}) {}

/** A V1 session compaction needs a model, and the input has none. */
class CompactModelRequiredError extends Schema.TaggedError<CompactModelRequiredError>()(
  "App.CompactModelRequiredError",
  { message: Schema.String },
) {}

type CompatError = CompatRequestError | ApiUnavailableError | LegacyMissingDataError | CompactModelRequiredError

/** The value that a Promise caller receives: the original rejection of a request, or the error itself. */
const rejection = (error: CompatError): unknown => (error._tag === "App.CompatRequestError" ? error.cause : error)

/** Runs one V1 SDK request. A rejection fails with CompatRequestError, which keeps the original value. */
const request = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new CompatRequestError({ cause }) })

/** Calls one method of the selected API. A thenable result is awaited; any other result is returned as it is. */
const invoke = (call: () => unknown) =>
  Effect.try({ try: call, catch: (cause) => new CompatRequestError({ cause }) }).pipe(
    Effect.flatMap((result) => (Predicate.isPromiseLike(result) ? request(() => result) : Effect.succeed(result))),
  )

/** Runs an adapter program at the Promise API edge. A failed request rejects with its original value. */
const run = <A>(program: Effect.Effect<A, CompatError>) => Effect.runPromise(program.pipe(Effect.mapError(rejection)))

export function createCompatibleApi(input: CompatibleInput): CompatibleApi {
  const v1 = createV1Api(input)
  const selected = input.protocol.then((protocol) => (protocol === "v1" ? v1 : input.current))
  return lazyApi(
    request(() => selected),
    input.current,
  )
}

function lazyApi<T extends object>(implementation: Effect.Effect<T, CompatError>, shape: T): T {
  const cache = MutableHashMap.empty<PropertyKey, unknown>()
  return new Proxy(shape, {
    get(target, property, receiver) {
      const sample: unknown = Reflect.get(target, property, receiver)
      if (typeof sample === "function") {
        return (...args: unknown[]) =>
          run(
            Effect.gen(function* () {
              const value = yield* implementation
              const method: unknown = Reflect.get(value, property)
              if (typeof method !== "function") {
                return yield* new ApiUnavailableError({ message: `API method unavailable: ${String(property)}` })
              }
              return yield* invoke(() => Reflect.apply(method, value, args))
            }),
          )
      }
      if (!Predicate.isObjectOrArray(sample)) return sample
      const cached = MutableHashMap.get(cache, property)
      if (Option.isSome(cached)) return cached.value
      const nested = lazyApi(
        Effect.flatMap(implementation, (value) => {
          const result: unknown = Reflect.get(value, property)
          if (!Predicate.isObjectOrArray(result)) {
            return Effect.fail(new ApiUnavailableError({ message: `API namespace unavailable: ${String(property)}` }))
          }
          return Effect.succeed(result)
        }),
        sample,
      )
      MutableHashMap.set(cache, property, nested)
      return nested
    },
  })
}

function createV1Api(input: CompatibleInput): CompatibleApi {
  const directory = (location?: { directory?: string } | null) => location?.directory ?? input.directory
  const legacy = (location?: { directory?: string } | null) => input.legacy(directory(location))
  const located = <T>(data: T, value?: { directory?: string } | null) => ({
    location: {
      directory: directory(value) ?? "",
      project: { id: "", directory: directory(value) ?? "" },
    },
    data,
  })

  return {
    ...input.current,
    session: {
      ...input.current.session,
      list: (
        value?: Parameters<ServerApi["session"]["list"]>[0],
        options?: Parameters<ServerApi["session"]["list"]>[1],
      ) =>
        run(
          Effect.gen(function* () {
            if (!value?.directory && value?.search !== undefined) {
              const result = yield* request(() =>
                legacy().experimental.session.list(
                  {
                    ...(Predicate.isNull(value.parentID) ? { roots: true } : {}),
                    search: value.search,
                    limit: value.limit,
                  },
                  options,
                ),
              )
              return { data: (result.data ?? []).map(sessionInfo), cursor: {} }
            }
            const result = yield* request(() =>
              legacy({ directory: value?.directory }).session.list({
                directory: value?.directory,
                ...(Predicate.isNull(value?.parentID) ? { roots: true } : {}),
                search: value?.search,
                limit: value?.limit,
              }),
            )
            return { data: (result.data ?? []).map(sessionInfo), cursor: {} }
          }),
        ),
      create: (value?: Parameters<ServerApi["session"]["create"]>[0]) =>
        run(
          Effect.gen(function* () {
            const result = yield* request(() =>
              legacy(value?.location).session.create({
                directory: directory(value?.location),
              }),
            )
            if (!result.data) return yield* new LegacyMissingDataError({ message: "Failed to create session" })
            return sessionInfo(result.data)
          }),
        ),
      get: (value: Parameters<ServerApi["session"]["get"]>[0]) =>
        run(
          Effect.gen(function* () {
            const result = yield* request(() => legacy().session.get(value))
            if (!result.data)
              return yield* new LegacyMissingDataError({ message: `Session not found: ${value.sessionID}` })
            return sessionInfo(result.data)
          }),
        ),
      active: () =>
        run(
          request(() => legacy().session.status()).pipe(
            Effect.map((result) =>
              Object.fromEntries(
                Object.entries(result.data ?? {}).flatMap(([sessionID, status]) =>
                  status.type === "idle" ? [] : [[sessionID, { type: "running" as const }]],
                ),
              ),
            ),
          ),
        ),
      rename: (value: Parameters<ServerApi["session"]["rename"]>[0] & LegacyLocation) =>
        run(
          request(() => legacy(value).session.update({ sessionID: value.sessionID, title: value.title })).pipe(
            Effect.asVoid,
          ),
        ),
      // async archive(value: Parameters<ServerApi["session"]["archive"]>[0] & LegacyLocation) {
      //   await legacy(value).session.update({ sessionID: value.sessionID, time: { archived: Date.now() } })
      // },
      remove: (value: Parameters<ServerApi["session"]["remove"]>[0] & LegacyLocation) =>
        run(request(() => legacy(value).session.delete(value)).pipe(Effect.asVoid)),
      fork: (value: Parameters<ServerApi["session"]["fork"]>[0]) =>
        run(
          Effect.gen(function* () {
            const result = yield* request(() => legacy().session.fork(value))
            if (!result.data) return yield* new LegacyMissingDataError({ message: "Failed to fork session" })
            return sessionInfo(result.data)
          }),
        ),
      interrupt: (value: Parameters<ServerApi["session"]["interrupt"]>[0]) =>
        run(request(() => legacy().session.abort(value)).pipe(Effect.asVoid)),
      prompt: (value: SessionPromptInput & LegacyPrompt) =>
        run(
          Effect.gen(function* () {
            yield* request(() =>
              legacy().session.promptAsync({
                sessionID: value.sessionID,
                messageID: Option.getOrUndefined(Option.fromNullishOr(value.id)),
                agent: value.agent,
                model: value.model,
                variant: value.variant,
                parts: value.legacyParts ?? [
                  { type: "text", text: value.text },
                  ...(value.files ?? []).map((file) => ({
                    type: "file" as const,
                    mime: file.mention ? "text/plain" : mime(file.uri),
                    url: file.uri,
                    filename: file.name,
                    ...(file.mention
                      ? {
                          source: {
                            type: "file" as const,
                            text: { value: file.mention.text, start: file.mention.start, end: file.mention.end },
                            path: file.uri,
                          },
                        }
                      : {}),
                  })),
                  ...(value.agents ?? []).map((agent) => ({
                    type: "agent" as const,
                    name: agent.name,
                    ...(agent.mention
                      ? { source: { value: agent.mention.text, start: agent.mention.start, end: agent.mention.end } }
                      : {}),
                  })),
                ],
              }),
            )
            const timeCreated = yield* Clock.currentTimeMillis
            const output: SessionPromptOutput = {
              admittedSeq: 0,
              id: value.id ?? "",
              sessionID: value.sessionID,
              timeCreated,
              type: "user",
              data: { text: value.text },
              delivery: value.delivery ?? "steer",
            }
            return output
          }),
        ),
      command: (value: SessionCommandInput) =>
        run(
          Effect.gen(function* () {
            yield* request(() =>
              legacy().session.command({
                sessionID: value.sessionID,
                messageID: Option.getOrUndefined(Option.fromNullishOr(value.id)),
                command: value.command,
                arguments: value.arguments ?? "",
                agent: Option.getOrUndefined(Option.fromNullishOr(value.agent)),
                ...(value.model ? { model: `${value.model.providerID}/${value.model.id}` } : {}),
                variant: value.model?.variant,
                parts: value.files?.map((file) => ({
                  type: "file" as const,
                  mime: mime(file.uri),
                  url: file.uri,
                  filename: file.name,
                })),
              }),
            )
            const timeCreated = yield* Clock.currentTimeMillis
            const output: SessionCommandOutput = {
              admittedSeq: 0,
              id: value.id ?? "",
              sessionID: value.sessionID,
              timeCreated,
              type: "user",
              data: { text: `/${value.command} ${value.arguments ?? ""}`.trim() },
              delivery: value.delivery ?? "steer",
            }
            return output
          }),
        ),
      shell: (value: SessionShellInput & LegacyPrompt) =>
        run(
          request(() =>
            legacy().session.shell({
              sessionID: value.sessionID,
              command: value.command,
              agent: value.agent,
              model: value.model,
            }),
          ).pipe(Effect.asVoid),
        ),
      compact: (value: SessionCompactInput & { model?: LegacyPrompt["model"] }) =>
        run(
          Effect.gen(function* () {
            const model = value.model
            if (!model)
              return yield* new CompactModelRequiredError({ message: "A model is required to compact a V1 session" })
            yield* request(() =>
              legacy().session.summarize({
                sessionID: value.sessionID,
                providerID: model.providerID,
                modelID: model.modelID,
              }),
            )
            const timeCreated = yield* Clock.currentTimeMillis
            const output: SessionCompactOutput = {
              admittedSeq: 0,
              id: value.id ?? "",
              sessionID: value.sessionID,
              timeCreated,
              type: "compaction",
            }
            return output
          }),
        ),
      revert: {
        stage: (value: Parameters<ServerApi["session"]["revert"]["stage"]>[0]) =>
          run(request(() => legacy().session.revert(value)).pipe(Effect.map(() => ({ messageID: value.messageID })))),
        clear: (value: Parameters<ServerApi["session"]["revert"]["clear"]>[0]) =>
          run(request(() => legacy().session.unrevert(value)).pipe(Effect.asVoid)),
        commit: input.current.session.revert.commit,
      },
    },
    project: {
      ...input.current.project,
      list: () =>
        run(request(() => legacy().project.list()).pipe(Effect.map((result) => (result.data ?? []) as Project[]))),
      current: (value?: Parameters<ServerApi["project"]["current"]>[0]) =>
        run(
          Effect.gen(function* () {
            const result = yield* request(() => legacy(value?.location).project.current())
            if (!result.data) return yield* new LegacyMissingDataError({ message: "Project not found" })
            return { id: result.data.id, directory: result.data.worktree } satisfies ProjectCurrent
          }),
        ),
      // async update(value: Parameters<ServerApi["project"]["update"]>[0]) {
      //   const project = (await legacy().project.list()).data?.find((item) => item.id === value.projectID)
      //   const result = await legacy({ directory: project?.worktree }).project.update({
      //     ...value,
      //     directory: project?.worktree,
      //   })
      //   if (!result.data) throw new Error(`Project not found: ${value.projectID}`)
      //   return result.data as Project
      // },
      directories: (value: Parameters<ServerApi["project"]["directories"]>[0]) =>
        run(
          request(() => legacy(value.location).worktree.list()).pipe(
            Effect.map((result) => (result.data ?? []).map((item) => ({ directory: item }))),
          ),
        ),
    },
    // path: {
    //   ...input.current.path,
    //   async get(value?: Parameters<ServerApi["path"]["get"]>[0]) {
    //     const result = await legacy(value?.location).path.get()
    //     if (!result.data) throw new Error("Path unavailable")
    //     return result.data
    //   },
    // },
    vcs: {
      ...input.current.vcs,
      // async get(value?: Parameters<ServerApi["vcs"]["get"]>[0]) {
      //   const result = await legacy(value?.location).vcs.get()
      //   return located({ branch: result.data?.branch, defaultBranch: result.data?.default_branch }, value?.location)
      // },
      status: (value?: Parameters<ServerApi["vcs"]["status"]>[0]) =>
        run(
          request(() => legacy(value?.location).vcs.status()).pipe(
            Effect.map((result) => located(result.data ?? [], value?.location)),
          ),
        ),
      diff: (value: Parameters<ServerApi["vcs"]["diff"]>[0]) =>
        run(
          request(() =>
            legacy(value.location).vcs.diff({
              mode: value.mode === "working" ? "git" : value.mode,
              context: value.context,
            }),
          ).pipe(
            Effect.map((result) =>
              located(
                (result.data ?? []).map((file) => ({
                  file: file.file,
                  patch: file.patch ?? "",
                  additions: file.additions,
                  deletions: file.deletions,
                  status: file.status ?? "modified",
                })),
                value.location,
              ),
            ),
          ),
        ),
    },
    file: {
      ...input.current.file,
      list: (value?: Parameters<ServerApi["file"]["list"]>[0]) =>
        run(
          request(() => legacy(value?.location).file.list({ path: value?.path ?? "" })).pipe(
            Effect.map((result) => located(result.data ?? [], value?.location)),
          ),
        ),
      find: (value: Parameters<ServerApi["file"]["find"]>[0]) =>
        run(
          request(() =>
            legacy(value.location).find.files({
              query: value.query,
              ...(value.type === undefined ? {} : { dirs: value.type === "directory" ? "true" : "false" }),
              limit: value.limit,
            }),
          ).pipe(
            Effect.map((result) =>
              located(
                (result.data ?? []).map((path) => ({ path, type: value.type ?? "file" })),
                value.location,
              ),
            ),
          ),
        ),
    },
    integration: {
      ...input.current.integration,
      get: (value: Parameters<ServerApi["integration"]["get"]>[0]) =>
        run(
          request(() => legacy(value.location).provider.auth()).pipe(
            Effect.map((result) =>
              located(
                {
                  id: value.integrationID,
                  name: value.integrationID,
                  methods: (result.data?.[value.integrationID] ?? []).map((method, index) =>
                    method.type === "api"
                      ? { type: "key" as const, label: method.label }
                      : { type: "oauth" as const, id: String(index), label: method.label, prompts: method.prompts },
                  ),
                  connections: [],
                },
                value.location,
              ),
            ),
          ),
        ),
      connect: {
        ...input.current.integration.connect,
        key: (value: Parameters<ServerApi["integration"]["connect"]["key"]>[0]) =>
          run(
            Effect.gen(function* () {
              yield* request(() =>
                legacy(value.location).auth.set({
                  providerID: value.integrationID,
                  auth: { type: "api", key: value.key },
                }),
              )
              yield* request(() => legacy(value.location).instance.dispose())
              yield* request(() => input.legacy().instance.dispose())
            }),
          ),
      },
      oauth: {
        ...input.current.integration.oauth,
        connect: (value: Parameters<ServerApi["integration"]["oauth"]["connect"]>[0]) =>
          run(
            Effect.gen(function* () {
              const method = Number(value.methodID)
              const result = yield* request(() =>
                legacy(value.location).provider.oauth.authorize(
                  { providerID: value.integrationID, method, inputs: value.inputs },
                  { throwOnError: true },
                ),
              )
              if (!result.data)
                return yield* new LegacyMissingDataError({ message: "Failed to start OAuth authorization" })
              const now = yield* Clock.currentTimeMillis
              return located(
                {
                  attemptID: `${value.integrationID}:${method}`,
                  url: result.data.url,
                  instructions: result.data.instructions,
                  mode: result.data.method,
                  time: { created: now, expires: now + 10 * 60 * 1000 },
                },
                value.location,
              )
            }),
          ),
        complete: (value: Parameters<ServerApi["integration"]["oauth"]["complete"]>[0]) =>
          run(
            Effect.gen(function* () {
              const method = Number(value.attemptID.split(":").at(-1))
              yield* request(() =>
                legacy(value.location).provider.oauth.callback(
                  { providerID: value.integrationID, method, code: value.code },
                  { throwOnError: true },
                ),
              )
              yield* request(() => legacy(value.location).instance.dispose())
              yield* request(() => input.legacy().instance.dispose())
            }),
          ),
        status: (value: Parameters<ServerApi["integration"]["oauth"]["status"]>[0]) =>
          run(
            Effect.gen(function* () {
              const method = Number(value.attemptID.split(":").at(-1))
              yield* request(() =>
                legacy(value.location).provider.oauth.callback(
                  { providerID: value.integrationID, method },
                  { throwOnError: true },
                ),
              )
              yield* request(() => legacy(value.location).instance.dispose())
              yield* request(() => input.legacy().instance.dispose())
              const now = yield* Clock.currentTimeMillis
              return located({ status: "complete" as const, time: { created: now, expires: now } }, value.location)
            }),
          ),
      },
    },
    pty: {
      ...input.current.pty,
      // async shells(value?: Parameters<ServerApi["pty"]["shells"]>[0]) {
      //   return located((await legacy(value?.location).pty.shells()).data ?? [], value?.location)
      // },
      list: (value?: Parameters<ServerApi["pty"]["list"]>[0]) =>
        run(
          request(() => legacy(value?.location).pty.list()).pipe(
            Effect.map((result) => located(result.data ?? [], value?.location)),
          ),
        ),
      create: (value?: Parameters<ServerApi["pty"]["create"]>[0]) =>
        run(
          Effect.gen(function* () {
            const result = yield* request(() =>
              legacy(value?.location).pty.create({
                command: value?.command,
                ...(value?.args ? { args: [...value.args] } : {}),
                cwd: value?.cwd,
                title: value?.title,
                env: value?.env,
              }),
            )
            if (!result.data) return yield* new LegacyMissingDataError({ message: "Failed to create terminal" })
            return located(result.data, value?.location)
          }),
        ),
      get: (value: Parameters<ServerApi["pty"]["get"]>[0]) =>
        run(
          Effect.gen(function* () {
            const result = yield* request(() => legacy(value.location).pty.get({ ptyID: value.ptyID }))
            if (!result.data)
              return yield* new LegacyMissingDataError({ message: `Terminal not found: ${value.ptyID}` })
            return located(result.data, value.location)
          }),
        ),
      update: (value: Parameters<ServerApi["pty"]["update"]>[0]) =>
        run(
          Effect.gen(function* () {
            const result = yield* request(() =>
              legacy(value.location).pty.update({
                ptyID: value.ptyID,
                title: value.title,
                size: value.size,
              }),
            )
            if (!result.data)
              return yield* new LegacyMissingDataError({ message: `Terminal not found: ${value.ptyID}` })
            return located(result.data, value.location)
          }),
        ),
      remove: (value: Parameters<ServerApi["pty"]["remove"]>[0]) =>
        run(request(() => legacy(value.location).pty.remove({ ptyID: value.ptyID })).pipe(Effect.asVoid)),
      // async connectToken(value: Parameters<ServerApi["pty"]["connectToken"]>[0]) {
      //   const result = await legacy(value.location).pty.connectToken({ ptyID: value.ptyID })
      //   if (!result.data) throw new Error(`Failed to connect terminal: ${value.ptyID}`)
      //   return located(result.data, value.location)
      // },
    },
    permission: {
      ...input.current.permission,
      reply: (value: Parameters<ServerApi["permission"]["reply"]>[0] & { location?: { directory?: string } }) =>
        run(
          request(() =>
            legacy(value.location).permission.respond({
              sessionID: value.sessionID,
              permissionID: value.requestID,
              response: value.reply,
              directory: directory(value.location),
            }),
          ).pipe(Effect.asVoid),
        ),
    },
    question: {
      ...input.current.question,
      reply: (value: Parameters<ServerApi["question"]["reply"]>[0]) =>
        run(
          request(() =>
            legacy().question.reply({
              requestID: value.requestID,
              answers: value.answers.map((answer) => [...answer]),
            }),
          ).pipe(Effect.asVoid),
        ),
      reject: (value: Parameters<ServerApi["question"]["reject"]>[0]) =>
        run(request(() => legacy().question.reject({ requestID: value.requestID })).pipe(Effect.asVoid)),
    },
  }
}
