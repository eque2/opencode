import type { McpServer } from "@agentclientprotocol/sdk"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Context, DateTime, Effect, HashMap, Layer, Option, Ref } from "effect"
import * as ACPError from "./error"

export type SelectedModel = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
}

export type KnownMessagePartMetadata = {
  messageId: string
  partId: string
  partType?: Part["type"]
  role?: Message["role"]
  ignored?: boolean
  toolCallId?: string
  metadata?: unknown
}

export type Info = {
  id: string
  cwd: string
  mcpServers: readonly McpServer[]
  createdAt: DateTime.Utc
  model?: SelectedModel
  variant?: string
  modeId?: string
  knownParts: HashMap.HashMap<string, KnownMessagePartMetadata>
}

export type StoreInput = {
  id: string
  cwd: string
  mcpServers?: readonly McpServer[]
  createdAt?: DateTime.Utc
  model?: SelectedModel
  variant?: string
  modeId?: string
}

export type RecordPartMetadataInput = {
  sessionId: string
  messageId: string
  partId: string
  partType?: Part["type"]
  role?: Message["role"]
  ignored?: boolean
  toolCallId?: string
  metadata?: unknown
}

export type PartMetadataLookupInput = {
  sessionId: string
  messageId: string
  partId: string
}

export type Interface = {
  readonly create: (input: StoreInput) => Effect.Effect<Info>
  readonly load: (input: StoreInput) => Effect.Effect<Info>
  readonly list: (cwd?: string) => Effect.Effect<readonly Info[]>
  readonly get: (sessionId: string) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly tryGet: (sessionId: string) => Effect.Effect<Info | undefined>
  readonly remove: (sessionId: string) => Effect.Effect<Option.Option<Info>>
  readonly setModel: (
    sessionId: string,
    model: SelectedModel | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getModel: (sessionId: string) => Effect.Effect<SelectedModel | undefined, ACPError.SessionNotFoundError>
  readonly setVariant: (
    sessionId: string,
    variant: string | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getVariant: (sessionId: string) => Effect.Effect<string | undefined, ACPError.SessionNotFoundError>
  readonly setMode: (
    sessionId: string,
    modeId: string | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getMode: (sessionId: string) => Effect.Effect<string | undefined, ACPError.SessionNotFoundError>
  readonly recordPartMetadata: (
    input: RecordPartMetadataInput,
  ) => Effect.Effect<KnownMessagePartMetadata, ACPError.SessionNotFoundError>
  readonly getPartMetadata: (
    input: PartMetadataLookupInput,
  ) => Effect.Effect<KnownMessagePartMetadata | undefined, ACPError.SessionNotFoundError>
  readonly tryGetPartMetadata: (input: PartMetadataLookupInput) => Effect.Effect<KnownMessagePartMetadata | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ACP/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Ref.make(HashMap.empty<string, Info>())

    const store = Effect.fn("ACP.Session.store")(function* (input: StoreInput) {
      const session = makeSession(input, input.createdAt ?? (yield* DateTime.now))
      yield* Ref.update(sessions, HashMap.set(session.id, session))
      return snapshot(session)
    })

    const find = Effect.fn("ACP.Session.find")(function* (sessionId: string) {
      return Option.map(HashMap.get(yield* Ref.get(sessions), sessionId), snapshot)
    })

    const tryGet = Effect.fn("ACP.Session.tryGet")(function* (sessionId: string) {
      return Option.getOrUndefined(yield* find(sessionId))
    })

    const get = Effect.fn("ACP.Session.get")(function* (sessionId: string) {
      const session = yield* find(sessionId)
      if (Option.isSome(session)) return session.value
      return yield* new ACPError.SessionNotFoundError({ sessionId })
    })

    const update = Effect.fn("ACP.Session.update")(function* (sessionId: string, fn: (session: Info) => Info) {
      const result = yield* Ref.modify(sessions, (state) =>
        Option.match(HashMap.get(state, sessionId), {
          onNone: () => [Option.none<Info>(), state] as const,
          onSome: (session) => {
            const next = fn(session)
            return [Option.some(snapshot(next)), HashMap.set(state, sessionId, next)] as const
          },
        }),
      )
      if (Option.isSome(result)) return result.value
      return yield* new ACPError.SessionNotFoundError({ sessionId })
    })

    const remove = Effect.fn("ACP.Session.remove")(function* (sessionId: string) {
      return yield* Ref.modify(sessions, (state) => [
        Option.map(HashMap.get(state, sessionId), snapshot),
        HashMap.remove(state, sessionId),
      ])
    })

    const setModel: Interface["setModel"] = Effect.fn("ACP.Session.setModel")((sessionId, model) =>
      update(sessionId, (session) => ({ ...session, model })),
    )

    const setVariant: Interface["setVariant"] = Effect.fn("ACP.Session.setVariant")((sessionId, variant) =>
      update(sessionId, (session) => ({ ...session, variant })),
    )

    const setMode: Interface["setMode"] = Effect.fn("ACP.Session.setMode")((sessionId, modeId) =>
      update(sessionId, (session) => ({ ...session, modeId })),
    )

    const recordPartMetadata: Interface["recordPartMetadata"] = Effect.fn("ACP.Session.recordPartMetadata")((input) => {
      const metadata = {
        messageId: input.messageId,
        partId: input.partId,
        partType: input.partType,
        role: input.role,
        ignored: input.ignored,
        toolCallId: input.toolCallId,
        metadata: input.metadata,
      }
      return update(input.sessionId, (session) => ({
        ...session,
        knownParts: HashMap.set(session.knownParts, partMetadataKey(input), metadata),
      })).pipe(Effect.as(metadata))
    })

    return Service.of({
      create: store,
      load: store,
      list: Effect.fn("ACP.Session.list")(function* (cwd?: string) {
        return HashMap.toValues(yield* Ref.get(sessions))
          .filter((session) => !cwd || session.cwd === cwd)
          .map(snapshot)
          .toSorted((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt))
      }),
      get,
      tryGet,
      remove,
      setModel,
      getModel: Effect.fn("ACP.Session.getModel")(function* (sessionId) {
        return (yield* get(sessionId)).model
      }),
      setVariant,
      getVariant: Effect.fn("ACP.Session.getVariant")(function* (sessionId) {
        return (yield* get(sessionId)).variant
      }),
      setMode,
      getMode: Effect.fn("ACP.Session.getMode")(function* (sessionId) {
        return (yield* get(sessionId)).modeId
      }),
      recordPartMetadata,
      getPartMetadata: Effect.fn("ACP.Session.getPartMetadata")(function* (input) {
        return Option.getOrUndefined(HashMap.get((yield* get(input.sessionId)).knownParts, partMetadataKey(input)))
      }),
      tryGetPartMetadata: Effect.fn("ACP.Session.tryGetPartMetadata")(function* (input) {
        const session = yield* find(input.sessionId)
        return Option.getOrUndefined(
          Option.flatMap(session, (current) => HashMap.get(current.knownParts, partMetadataKey(input))),
        )
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

function makeSession(input: StoreInput, createdAt: DateTime.Utc): Info {
  return {
    id: input.id,
    cwd: input.cwd,
    mcpServers: [...(input.mcpServers ?? [])],
    createdAt,
    model: input.model,
    variant: input.variant,
    modeId: input.modeId,
    knownParts: HashMap.empty(),
  }
}

function snapshot(session: Info): Info {
  return {
    ...session,
    mcpServers: [...session.mcpServers],
  }
}

function partMetadataKey(input: { messageId: string; partId: string }) {
  return `${input.messageId}:${input.partId}`
}

export * as ACPSession from "./session"
