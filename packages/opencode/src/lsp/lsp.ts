import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { LSPLaunch } from "./launch"
import { AppProcess } from "@opencode-ai/core/process"
import {
  Array,
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  MutableHashMap,
  MutableHashSet,
  Option,
  Predicate,
  Schema,
  Scope,
} from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LspEvent } from "@opencode-ai/schema/lsp-event"

export const Event = LspEvent

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
}).annotate({ identifier: "Position" })

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

// The id of a language server, such as "typescript" or a configured server name.
const ServerID = Schema.String.pipe(Schema.brand("LSP.ServerID"))

export const Status = Schema.Struct({
  id: ServerID,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }

interface State {
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  broken: MutableHashSet.MutableHashSet<string>
  // One spawn for each root and server; concurrent callers wait for the same result.
  spawning: MutableHashMap.MutableHashMap<string, Deferred.Deferred<Option.Option<LSPClient.Info>>>
  // Spawns run in the instance scope, so a caller that stops waiting does not cancel a spawn.
  scope: Scope.Scope
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

const position = (input: LocInput) => ({
  textDocument: { uri: pathToFileURL(input.file).href },
  position: { line: input.line, character: input.character },
})

// One JSON-RPC request to a server. The type argument declares the response shape.
const request = <A>(client: LSPClient.Info, method: string, params: object) =>
  Effect.tryPromise(() => client.connection.sendRequest<A>(method, params))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service
    const fsu = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* () {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}

        if (!cfg.lsp) {
          yield* Effect.logInfo("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          if (cfg.lsp !== true) {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                yield* Effect.logInfo(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? ((_file, ctx) => Effect.succeed(Option.some(ctx.directory))),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: (root) =>
                  LSPLaunch.spawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...process.env, ...item.env },
                  }).pipe(Effect.map((proc) => Option.some({ process: proc, initialization: item.initialization }))),
              }
            }
          }

          yield* Effect.logInfo("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          clients: [],
          servers,
          broken: MutableHashSet.empty(),
          spawning: MutableHashMap.empty(),
          scope: yield* Scope.Scope,
        }

        yield* Effect.addFinalizer(() =>
          Effect.forEach(s.clients, (client) => Effect.tryPromise(() => client.shutdown()).pipe(Effect.ignore), {
            concurrency: "unbounded",
            discard: true,
          }),
        )

        return s
      }),
    )

    const rootOf = (server: LSPServer.Info, file: string, ctx: InstanceContext) =>
      server.root(file, ctx).pipe(Effect.provideService(FSUtil.Service, fsu))

    const stop = (handle: LSPServer.Handle) => LSPLaunch.stop(handle.process)

    // Starts the server and connects a client. Any failure marks the server broken for this root.
    const schedule = Effect.fnUntraced(function* (
      s: State,
      ctx: InstanceContext,
      server: LSPServer.Info,
      root: string,
      key: string,
    ) {
      const handle = yield* server.spawn(root, ctx, flags).pipe(
        Effect.provideService(FSUtil.Service, fsu),
        Effect.provideService(AppProcess.Service, appProcess),
        Effect.catchCause((cause) =>
          Effect.logWarning("LSP spawn failed", { serverID: server.id, root, cause: Cause.pretty(cause) }).pipe(
            Effect.annotateLogs({ category: "lsp.spawn" }),
            Effect.as(Option.none()),
          ),
        ),
      )
      if (Option.isNone(handle)) {
        MutableHashSet.add(s.broken, key)
        return Option.none<LSPClient.Info>()
      }

      const client = yield* Effect.option(
        Effect.tryPromise(() =>
          LSPClient.create({
            serverID: server.id,
            server: handle.value,
            root,
            directory: ctx.directory,
            instance: ctx,
          }),
        ).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("LSP initialise failed", { serverID: server.id, root, error }).pipe(
              Effect.annotateLogs({ category: "lsp.spawn" }),
            ),
          ),
        ),
      )
      if (Option.isNone(client)) {
        MutableHashSet.add(s.broken, key)
        yield* stop(handle.value)
        return client
      }

      const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
      if (existing) {
        yield* stop(handle.value)
        return Option.some(existing)
      }

      s.clients.push(client.value)
      return client
    })

    // The client of one server for a file, and whether this call created it.
    const clientFor = Effect.fnUntraced(function* (
      s: State,
      ctx: InstanceContext,
      server: LSPServer.Info,
      file: string,
      extension: string,
    ) {
      if (server.extensions.length && !server.extensions.includes(extension)) return Option.none()

      const root = yield* rootOf(server, file, ctx)
      if (Option.isNone(root)) return Option.none()
      const key = root.value + server.id
      if (MutableHashSet.has(s.broken, key)) return Option.none()

      const match = s.clients.find((x) => x.root === root.value && x.serverID === server.id)
      if (match) return Option.some({ client: match, created: false })

      const inflight = MutableHashMap.get(s.spawning, key)
      if (Option.isSome(inflight)) {
        const client = yield* Deferred.await(inflight.value)
        return Option.map(client, (value) => ({ client: value, created: false }))
      }

      const task = yield* Deferred.make<Option.Option<LSPClient.Info>>()
      MutableHashMap.set(s.spawning, key, task)
      yield* schedule(s, ctx, server, root.value, key).pipe(
        Deferred.into(task),
        Effect.ensuring(Effect.sync(() => MutableHashMap.remove(s.spawning, key))),
        Effect.forkIn(s.scope),
      )
      const client = yield* Deferred.await(task)
      return Option.map(client, (value) => ({ client: value, created: true }))
    })

    const getClients = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return []
      const s = yield* InstanceState.get(state)
      const extension = path.parse(file).ext || file
      const found = Array.getSomes(
        yield* Effect.forEach(Object.values(s.servers), (server) => clientFor(s, ctx, server, file, extension)),
      )
      yield* Effect.forEach(
        found.filter((item) => item.created),
        () => events.publish(Event.Updated, {}),
        { discard: true },
      )
      return found.map((item) => item.client)
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Effect.Effect<T>) {
      const clients = yield* getClients(file)
      return yield* Effect.forEach(clients, (client) => fn(client), { concurrency: "unbounded" })
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Effect.Effect<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.forEach(s.clients, (client) => fn(client), { concurrency: "unbounded" })
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return s.clients.map(
        (client): Status => ({
          id: ServerID.make(client.serverID),
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
        }),
      )
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const extension = path.parse(file).ext || file
      const usable = yield* Effect.findFirst(Object.values(s.servers), (server) =>
        Effect.gen(function* () {
          if (server.extensions.length && !server.extensions.includes(extension)) return false
          const root = yield* rootOf(server, file, ctx)
          return Option.isSome(root) && !MutableHashSet.has(s.broken, root.value + server.id)
        }),
      )
      return Option.isSome(usable)
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      yield* Effect.logInfo("touching file", { file: input })
      const clients = yield* getClients(input)
      // A client that cannot open the file or report its diagnostics does not fail the touch.
      yield* Effect.forEach(
        clients,
        (client) =>
          Effect.gen(function* () {
            const after = yield* Clock.currentTimeMillis
            const version = yield* Effect.tryPromise(() => client.notify.open({ path: input }))
            if (!diagnostics) return
            yield* Effect.tryPromise(() =>
              client.waitForDiagnostics({
                path: input,
                version,
                mode: diagnostics,
                after,
              }),
            )
          }),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.ignore)
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll((client) => Effect.sync(() => client.diagnostics))
      for (const result of all) {
        for (const [p, diags] of result) {
          results[p] = [...(results[p] ?? []), ...diags]
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      // A server that fails keeps its place in the response as a null entry.
      return yield* run(input.file, (client) =>
        request<unknown>(client, "textDocument/hover", position(input)).pipe(
          Effect.option,
          Effect.map(Option.getOrNull),
        ),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        request<unknown>(client, "textDocument/definition", position(input)).pipe(Effect.orElseSucceed(() => [])),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        request<unknown>(client, "textDocument/references", {
          ...position(input),
          context: { includeDeclaration: true },
        }).pipe(Effect.orElseSucceed(() => [])),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        request<unknown>(client, "textDocument/implementation", position(input)).pipe(Effect.orElseSucceed(() => [])),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        request<ReadonlyArray<DocumentSymbol | Symbol> | null>(client, "textDocument/documentSymbol", {
          textDocument: { uri },
        }).pipe(Effect.orElseSucceed(() => [])),
      )
      return results.flat().filter(Predicate.isNotNullish)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      const results = yield* runAll((client) =>
        request<ReadonlyArray<Symbol> | null>(client, "workspace/symbol", { query }).pipe(
          Effect.map((result) => (result ?? []).filter((x) => kinds.includes(x.kind)).slice(0, 10)),
          Effect.orElseSucceed((): Symbol[] => []),
        ),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        request<unknown>(client, "textDocument/prepareCallHierarchy", position(input)).pipe(
          Effect.orElseSucceed(() => []),
        ),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, (client) =>
        Effect.gen(function* () {
          const items = yield* request<unknown[] | null>(
            client,
            "textDocument/prepareCallHierarchy",
            position(input),
          ).pipe(Effect.orElseSucceed((): unknown[] => []))
          if (!items?.length) return []
          return yield* request<unknown>(client, direction, { item: items[0] }).pipe(Effect.orElseSucceed(() => []))
        }),
      )
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      init,
      status,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, RuntimeFlags.node, FSUtil.node, AppProcess.node, EventV2Bridge.node],
})

export * as LSP from "./lsp"
