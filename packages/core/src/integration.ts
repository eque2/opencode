export * as Integration from "./integration"

import { makeLocationNode } from "./effect/app-node"
import {
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Context,
  Duration,
  Effect,
  Exit,
  HashMap,
  Layer,
  MutableHashMap,
  Option,
  Redacted,
  Schedule,
  Schema,
  Scope,
  SynchronizedRef,
  Types,
} from "effect"
import { Integration } from "@opencode-ai/schema/integration"
import { Credential } from "./credential"
import { State } from "./state"
import { EventV2 } from "./event"
import { IntegrationConnection } from "./integration/connection"

export const ID = Integration.ID
export type ID = Integration.ID

export const MethodID = Integration.MethodID
export type MethodID = Integration.MethodID

export const AttemptID = Integration.AttemptID
export type AttemptID = typeof AttemptID.Type

export const When = Integration.When
export type When = Integration.When

export const TextPrompt = Integration.TextPrompt
export type TextPrompt = Integration.TextPrompt

export const SelectPrompt = Integration.SelectPrompt
export type SelectPrompt = Integration.SelectPrompt

export const Prompt = Integration.Prompt
export type Prompt = Integration.Prompt

export const OAuthMethod = Integration.OAuthMethod
export type OAuthMethod = Integration.OAuthMethod

export const KeyMethod = Integration.KeyMethod
export type KeyMethod = Integration.KeyMethod

export const EnvMethod = Integration.EnvMethod
export type EnvMethod = Integration.EnvMethod

export const Method = Integration.Method
export type Method = Integration.Method

export const Info = Integration.Info
export type Info = Integration.Info

export const Inputs = Integration.Inputs
export type Inputs = Integration.Inputs

export type OAuthAuthorization = {
  readonly url: string
  readonly instructions: string
} & (
  | {
      readonly mode: "auto"
      readonly callback: Effect.Effect<Credential.OAuth, unknown>
    }
  | {
      readonly mode: "code"
      readonly callback: (code: string) => Effect.Effect<Credential.OAuth, unknown>
    }
)

export interface OAuthImplementation {
  readonly integrationID: ID
  readonly method: OAuthMethod
  readonly authorize: (inputs: Inputs) => Effect.Effect<OAuthAuthorization, unknown, Scope.Scope>
  readonly refresh?: (credential: Credential.OAuth) => Effect.Effect<Credential.OAuth, unknown>
  readonly label?: (credential: Credential.OAuth) => string | undefined
}

export interface KeyImplementation {
  readonly integrationID: ID
  readonly method: KeyMethod
}

export interface EnvImplementation {
  readonly integrationID: ID
  readonly method: EnvMethod
}

export type Implementation = OAuthImplementation | KeyImplementation | EnvImplementation

export const Attempt = Integration.Attempt
export type Attempt = Integration.Attempt

export const AttemptStatus = Integration.AttemptStatus
export type AttemptStatus = typeof AttemptStatus.Type

export class CodeRequiredError extends Schema.TaggedError<CodeRequiredError>()("Integration.CodeRequired", {
  attemptID: AttemptID,
}) {}

export class AuthorizationError extends Schema.TaggedError<AuthorizationError>()("Integration.Authorization", {
  cause: Schema.Defect(),
}) {}

export type Error = CodeRequiredError | AuthorizationError

export const Event = Integration.Event

export const Ref = Integration.Ref
export type Ref = Integration.Ref

type Entry = {
  ref: Types.DeepMutable<Ref>
  methods: Method[]
  implementations: MutableHashMap.MutableHashMap<MethodID, OAuthImplementation>
}

type Data = {
  integrations: MutableHashMap.MutableHashMap<ID, Entry>
}

export type Draft = {
  list: () => readonly Ref[]
  get: (id: ID) => Ref | undefined
  update: (id: ID, update: (integration: Types.DeepMutable<Ref>) => void) => void
  remove: (id: ID) => void
  method: {
    list: (integrationID: ID) => readonly Method[]
    update: (implementation: Implementation) => void
    remove: (integrationID: ID, method: Method) => void
  }
}

export interface Interface extends State.Transformable<Draft> {
  /** Registers a scoped transform over the integration registry. */
  /** Returns one integration with its methods and current connections. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Returns all integrations with their methods and current connections. */
  readonly list: () => Effect.Effect<Info[]>
  readonly connection: {
    /** Returns the active connection for one integration. */
    readonly active: (id: ID) => Effect.Effect<IntegrationConnection.Info | undefined>
    /** Resolves a connection into usable credential material. */
    readonly resolve: (
      connection: IntegrationConnection.Info,
    ) => Effect.Effect<Credential.Value | undefined, AuthorizationError>
    /** Runs a key method and stores the resulting credential. */
    readonly key: (input: {
      /** Integration receiving the credential. */
      readonly integrationID: ID
      /** Secret entered by the user. */
      readonly key: string
      /** User-facing label for the stored credential. */
      readonly label?: string
    }) => Effect.Effect<void, AuthorizationError>
    /** Starts a stateful OAuth attempt. */
    readonly oauth: (input: {
      /** Integration being authenticated. */
      readonly integrationID: ID
      /** OAuth method selected by the caller. */
      readonly methodID: MethodID
      /** Answers to the method's optional prompts. */
      readonly inputs: Inputs
      /** User-facing label for the credential created on completion. */
      readonly label?: string
    }) => Effect.Effect<Attempt, AuthorizationError>
    /** Updates a stored credential exposed as a connection. */
    readonly update: (
      credentialID: Credential.ID,
      updates: Partial<Pick<Credential.Info, "label">>,
    ) => Effect.Effect<void>
    /** Removes a stored credential connection. */
    readonly remove: (credentialID: Credential.ID) => Effect.Effect<void>
  }
  readonly attempt: {
    /** Returns the current state of an OAuth attempt. */
    readonly status: (attemptID: AttemptID) => Effect.Effect<AttemptStatus>
    /** Completes the attempt and stores its credential. */
    readonly complete: (input: {
      /** Opaque handle returned by `oauth`. */
      readonly attemptID: AttemptID
      /** Authorization code required by attempts in code mode. */
      readonly code?: string
    }) => Effect.Effect<void, CodeRequiredError | AuthorizationError>
    /** Cancels an attempt and releases its resources. */
    readonly cancel: (attemptID: AttemptID) => Effect.Effect<void>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Integration") {}

const attemptLifetime = Duration.toMillis(Duration.minutes(10))
const terminalRetention = Duration.toMillis(Duration.minutes(1))
const scrubInterval = Duration.seconds(30)

type AttemptTime = { created: number; expires: number }
type PendingAttempt = {
  status: "pending"
  completing: boolean
  authorization: OAuthAuthorization
  integrationID: ID
  methodID: MethodID
  label?: string
  scope: Scope.Closeable
  time: AttemptTime
}
type TerminalAttempt = {
  status: "complete" | "failed" | "expired"
  message?: string
  removeAt: number
  time: AttemptTime
}
type AttemptEntry = PendingAttempt | TerminalAttempt
type Attempts = HashMap.HashMap<AttemptID, AttemptEntry>

const isPending = (attempt: AttemptEntry): attempt is PendingAttempt => attempt.status === "pending"

// Reads an env-method secret. The ambient ConfigProvider copies process.env once per
// process, so each read uses a fresh env provider and sees variables set at run time.
// An empty value counts as missing, as it did with the old truthiness check.
const envSecret = (name: string) =>
  Config.option(Config.Redacted(name)).parse(ConfigProvider.fromEnv()).pipe(Effect.orDie)

const isOAuthImplementation = (implementation: Implementation): implementation is OAuthImplementation =>
  implementation.method.type === "oauth"

// Returns the registry entry for an integration, creating an empty one on first use.
const entryOf = (data: Data, id: ID): Entry =>
  Option.getOrElse(MutableHashMap.get(data.integrations, id), () => {
    const created: Entry = { ref: { id, name: id }, methods: [], implementations: MutableHashMap.empty() }
    MutableHashMap.set(data.integrations, id, created)
    return created
  })

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const attempts = SynchronizedRef.makeUnsafe(HashMap.empty<AttemptID, AttemptEntry>())
    const state = State.create<Data, Draft>({
      initial: () => ({ integrations: MutableHashMap.empty<ID, Entry>() }),
      draft: (draft) => ({
        list: () => Array.from(MutableHashMap.values(draft.integrations), (entry) => entry.ref),
        get: (id) =>
          Option.getOrUndefined(Option.map(MutableHashMap.get(draft.integrations, id), (entry) => entry.ref)),
        update: (id, update) => {
          const current = entryOf(draft, id)
          update(current.ref)
          current.ref.id = id
        },
        remove: (id) => {
          MutableHashMap.remove(draft.integrations, id)
        },
        method: {
          list: (integrationID) =>
            Option.match(MutableHashMap.get(draft.integrations, integrationID), {
              onNone: () => [],
              onSome: (entry) => entry.methods,
            }),
          update: (implementation) => {
            const current = entryOf(draft, implementation.integrationID)
            const index = current.methods.findIndex((method) => {
              if (method.type !== implementation.method.type) return false
              if (method.type !== "oauth" || implementation.method.type !== "oauth") return true
              return method.id === implementation.method.id
            })
            if (index === -1) current.methods.push(implementation.method)
            else current.methods[index] = implementation.method
            if (isOAuthImplementation(implementation)) {
              MutableHashMap.set(current.implementations, implementation.method.id, implementation)
            }
          },
          remove: (integrationID, method) => {
            const entry = MutableHashMap.get(draft.integrations, integrationID)
            if (Option.isNone(entry)) return
            const current = entry.value
            const index = current.methods.findIndex((candidate) => {
              if (candidate.type !== method.type) return false
              if (candidate.type !== "oauth" || method.type !== "oauth") return true
              return candidate.id === method.id
            })
            if (index !== -1) current.methods.splice(index, 1)
            if (method.type === "oauth") MutableHashMap.remove(current.implementations, method.id)
          },
        },
      }),
      finalize: () => events.publish(Event.Updated, {}).pipe(Effect.asVoid),
    })

    const implementationOf = (integrationID: ID, methodID: MethodID) =>
      MutableHashMap.get(state.get().integrations, integrationID).pipe(
        Option.flatMap((entry) => MutableHashMap.get(entry.implementations, methodID)),
      )

    const resolveConnections = Effect.fnUntraced(function* (
      methods: readonly Method[],
      saved: readonly Credential.Info[],
    ) {
      const credentials = saved
        .map((credential) => ({
          type: "credential" as const,
          id: credential.id,
          label: credential.label,
        }))
        .toReversed()
      const names = methods.filter((method) => method.type === "env").flatMap((method) => method.names)
      const env = yield* Effect.forEach(names, (name) =>
        envSecret(name).pipe(Effect.map((secret) => (Option.isSome(secret) ? [{ type: "env" as const, name }] : []))),
      )
      return [...credentials, ...env.flat()]
    })

    const project = (entry: Entry, connections: IntegrationConnection.Info[]) =>
      new Info({
        id: entry.ref.id,
        name: entry.ref.name,
        methods: entry.methods,
        connections,
      })

    const authorize = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new AuthorizationError({ cause })))

    const close = (attemptScope: Scope.Closeable) =>
      Scope.close(attemptScope, Exit.void).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

    const message = (cause: Cause.Cause<unknown>) => {
      const error = Cause.squash(cause)
      return error instanceof Error ? error.message : String(error)
    }

    const settle = Effect.fnUntraced(function* (attemptID: AttemptID, exit: Exit.Exit<Credential.OAuth, unknown>) {
      const now = yield* Clock.currentTimeMillis
      const settled = yield* SynchronizedRef.modify(
        attempts,
        (current): readonly [Option.Option<PendingAttempt>, Attempts] => {
          const attempt = HashMap.get(current, attemptID).pipe(Option.filter(isPending))
          if (Option.isNone(attempt)) return [attempt, current]
          const time = attempt.value.time
          const terminal: TerminalAttempt = Exit.isSuccess(exit)
            ? { status: "complete", time, removeAt: now + terminalRetention }
            : { status: "failed", message: message(exit.cause), time, removeAt: now + terminalRetention }
          return [attempt, HashMap.set(current, attemptID, terminal)]
        },
      )
      if (Option.isNone(settled)) return
      const result = settled.value
      if (Exit.isSuccess(exit)) {
        const implementation = implementationOf(result.integrationID, result.methodID)
        yield* credentials.create({
          integrationID: result.integrationID,
          label:
            result.label ??
            Option.getOrUndefined(Option.flatMapNullishOr(implementation, (item) => item.label?.(exit.value))),
          value: exit.value,
        })
        yield* events.publish(Event.ConnectionUpdated, { integrationID: result.integrationID })
        yield* events.publish(Event.Updated, {})
      }
      yield* close(result.scope)
    })

    const scrub = Effect.fnUntraced(function* () {
      const now = yield* Clock.currentTimeMillis
      const expired = yield* SynchronizedRef.modify(attempts, (current) => {
        const isExpired = (attempt: AttemptEntry): attempt is PendingAttempt =>
          isPending(attempt) && attempt.time.expires <= now
        const scopes = Array.from(HashMap.values(current)).flatMap((attempt) =>
          isExpired(attempt) ? [attempt.scope] : [],
        )
        // Expire pending attempts past their lifetime, then drop terminal attempts past retention.
        const next = HashMap.filter(
          HashMap.map(
            current,
            (attempt): AttemptEntry =>
              isExpired(attempt)
                ? { status: "expired", time: attempt.time, removeAt: now + terminalRetention }
                : attempt,
          ),
          (attempt) => isPending(attempt) || attempt.removeAt > now,
        )
        return [scopes, next]
      })
      yield* Effect.forEach(expired, close, { discard: true })
    })

    yield* scrub().pipe(Effect.repeat(Schedule.spaced(scrubInterval)), Effect.forkIn(scope))

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("Integration.get")(function* (id) {
        const entry = MutableHashMap.get(state.get().integrations, id)
        if (Option.isNone(entry)) return undefined
        return project(entry.value, yield* resolveConnections(entry.value.methods, yield* credentials.list(id)))
      }),
      list: Effect.fn("Integration.list")(function* () {
        const saved = Map.groupBy(yield* credentials.all(), (credential) => credential.integrationID)
        const infos = yield* Effect.forEach(MutableHashMap.values(state.get().integrations), (entry) =>
          resolveConnections(entry.methods, saved.get(entry.ref.id) ?? []).pipe(
            Effect.map((connections) => project(entry, connections)),
          ),
        )
        return infos.toSorted((a, b) => a.name.localeCompare(b.name))
      }),
      connection: {
        active: Effect.fn("Integration.connection.active")(function* (id) {
          const methods = Option.match(MutableHashMap.get(state.get().integrations, id), {
            onNone: () => [],
            onSome: (entry) => entry.methods,
          })
          return (yield* resolveConnections(methods, yield* credentials.list(id)))[0]
        }),
        resolve: Effect.fn("Integration.connection.resolve")(function* (connection) {
          if (connection.type === "env") {
            const secret = yield* envSecret(connection.name)
            return Option.getOrUndefined(
              Option.map(secret, (key) => Credential.Key.make({ type: "key", key: Redacted.value(key) })),
            )
          }
          const credential = yield* credentials.get(connection.id)
          if (!credential) return undefined
          if (credential.value.type === "key") return credential.value
          const refresh = Option.flatMapNullishOr(
            implementationOf(credential.integrationID, credential.value.methodID),
            (implementation) => implementation.refresh,
          )
          if (Option.isNone(refresh)) return credential.value
          const now = yield* Clock.currentTimeMillis
          if (credential.value.expires > now + Duration.toMillis(Duration.minutes(5))) return credential.value
          // Every plugin OAuth refresh (OpenAI, OpenCode, ...) runs here, so one span and one log cover them all.
          const attributes = {
            integrationID: credential.integrationID,
            methodID: credential.value.methodID,
            connectionID: credential.id,
          }
          const value = yield* authorize(refresh.value(credential.value)).pipe(
            Effect.withSpan("Integration.refresh", { attributes }),
          )
          yield* credentials.update(credential.id, { value })
          yield* Effect.logInfo("OAuth token refreshed", attributes).pipe(
            Effect.annotateLogs({ category: "auth.refresh" }),
          )
          return value
        }),
        key: Effect.fn("Integration.connection.key")(function* (input) {
          const method = Option.exists(MutableHashMap.get(state.get().integrations, input.integrationID), (entry) =>
            entry.methods.some((method) => method.type === "key"),
          )
          if (!method) return yield* Effect.die(`Key method not found: ${input.integrationID}`)
          yield* credentials.create({
            integrationID: input.integrationID,
            label: input.label,
            value: Credential.Key.make({ type: "key", key: input.key }),
          })
          yield* events.publish(Event.ConnectionUpdated, { integrationID: input.integrationID })
          return yield* events.publish(Event.Updated, {}).pipe(Effect.asVoid)
        }),
        oauth: Effect.fn("Integration.connection.oauth")(function* (input) {
          const method = implementationOf(input.integrationID, input.methodID)
          if (Option.isNone(method)) {
            return yield* Effect.die(`OAuth method not found: ${input.integrationID}/${input.methodID}`)
          }
          const attemptScope = yield* Scope.fork(scope)
          const authorization = yield* authorize(method.value.authorize(input.inputs)).pipe(
            Scope.provide(attemptScope),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(attemptScope, exit) : Effect.void)),
          )
          const id = AttemptID.create()
          const created = yield* Clock.currentTimeMillis
          const time = { created, expires: created + attemptLifetime }
          yield* SynchronizedRef.update(attempts, (current) =>
            HashMap.set(current, id, {
              status: "pending",
              completing: authorization.mode === "auto",
              authorization,
              integrationID: input.integrationID,
              methodID: input.methodID,
              label: input.label,
              scope: attemptScope,
              time,
            }),
          )
          if (authorization.mode === "auto") {
            yield* authorization.callback.pipe(
              Effect.exit,
              Effect.flatMap((exit) => settle(id, exit)),
              Effect.forkIn(attemptScope, { startImmediately: true }),
            )
          }
          return new Attempt({
            attemptID: id,
            url: authorization.url,
            instructions: authorization.instructions,
            mode: authorization.mode,
            time,
          })
        }),
        update: Effect.fn("Integration.connection.update")(function* (credentialID, updates) {
          const credential = yield* credentials.get(credentialID)
          yield* credentials.update(credentialID, updates)
          if (credential) {
            yield* events.publish(Event.ConnectionUpdated, { integrationID: credential.integrationID })
          }
          yield* events.publish(Event.Updated, {})
        }),
        remove: Effect.fn("Integration.connection.remove")(function* (credentialID) {
          const credential = yield* credentials.get(credentialID)
          yield* credentials.remove(credentialID)
          if (credential) {
            yield* events.publish(Event.ConnectionUpdated, { integrationID: credential.integrationID })
          }
          yield* events.publish(Event.Updated, {})
        }),
      },
      attempt: {
        status: Effect.fn("Integration.attempt.status")(function* (attemptID) {
          const found = HashMap.get(yield* SynchronizedRef.get(attempts), attemptID)
          if (Option.isNone(found)) return yield* Effect.die(`OAuth attempt not found: ${attemptID}`)
          const attempt = found.value
          if (attempt.status === "failed") {
            return { status: attempt.status, message: attempt.message ?? "Authorization failed", time: attempt.time }
          }
          return { status: attempt.status, time: attempt.time }
        }),
        complete: Effect.fn("Integration.attempt.complete")(function* (input) {
          const found = yield* SynchronizedRef.modify(
            attempts,
            (current): readonly [Option.Option<AttemptEntry>, Attempts] => {
              const match = HashMap.get(current, input.attemptID)
              if (Option.isNone(match)) return [match, current]
              const pending = match.value
              if (pending.status !== "pending" || pending.completing) return [match, current]
              if (pending.authorization.mode === "code" && input.code === undefined) return [match, current]
              return [match, HashMap.set(current, input.attemptID, { ...pending, completing: true })]
            },
          )
          if (Option.isNone(found)) return yield* Effect.die(`OAuth attempt not found: ${input.attemptID}`)
          const attempt = found.value
          if (attempt.status !== "pending") return yield* Effect.void
          const authorization = attempt.authorization
          // A code-mode callback needs the code; without it there is no callback to run.
          const callback =
            authorization.mode === "auto"
              ? Option.some(authorization.callback)
              : Option.map(Option.fromUndefinedOr(input.code), (code) =>
                  Effect.suspend(() => authorization.callback(code)),
                )
          if (Option.isNone(callback)) return yield* new CodeRequiredError({ attemptID: input.attemptID })
          if (attempt.completing) return yield* Effect.die(`OAuth attempt already completing: ${input.attemptID}`)
          const exit = yield* authorize(callback.value).pipe(Effect.exit)
          yield* settle(input.attemptID, exit)
          return yield* Exit.asVoid(exit)
        }),
        cancel: Effect.fn("Integration.attempt.cancel")(function* (attemptID) {
          const attempt = yield* SynchronizedRef.modify(attempts, (current) => {
            const match = HashMap.get(current, attemptID).pipe(Option.filter(isPending))
            return [match, Option.isSome(match) ? HashMap.remove(current, attemptID) : current]
          })
          if (Option.isSome(attempt)) yield* Scope.close(attempt.value.scope, Exit.void)
        }),
      },
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [Credential.node, EventV2.node] })
