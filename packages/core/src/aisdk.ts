export * as AISDK from "./aisdk"

import { makeLocationNode } from "./effect/app-node"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Cause, Context, Duration, Effect, Layer, Option, Predicate, Record, Schema, Scope } from "effect"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { State } from "./state"

type SDK = any

export interface SDKEvent {
  readonly model: ModelV2.Info
  readonly package: string
  readonly options: Record<string, any>
  sdk?: SDK
}

export interface LanguageEvent {
  readonly model: ModelV2.Info
  readonly sdk: SDK
  readonly options: Record<string, any>
  language?: LanguageModelV3
}

/** An SSE response body sent no chunk within the configured `chunkTimeout`. */
export class ChunkTimeoutError extends Schema.TaggedError<ChunkTimeoutError>()("AISDK.ChunkTimeoutError", {
  message: Schema.String,
}) {}

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()

  // The timeout aborts the request and cancels the reader with the timeout error as the reason. The
  // cancel is not awaited, so the pending read fails at once.
  const timedOut = Effect.gen(function* () {
    const error = new ChunkTimeoutError({ message: "SSE read timed out" })
    ctl.abort(error)
    yield* Effect.promise(() => reader.cancel(error)).pipe(
      Effect.ignoreCause,
      Effect.forkDetach({ startImmediately: true }),
    )
    return yield* error
  })

  // ReadableStream reports a rejected pull or cancel as the stream error. A reader failure (for example
  // the AbortError of an aborted request) must reach the AI SDK unchanged, so the reader promises run
  // with Effect.promise: a rejection stays a defect, and Effect.runPromise rejects with the original value.
  const pull = (ctrl: ReadableStreamDefaultController<Uint8Array>) =>
    Effect.promise(() => reader.read()).pipe(
      Effect.timeoutOrElse({ duration: Duration.millis(ms), orElse: () => timedOut }),
      Effect.flatMap((part) => Effect.sync(() => (part.done ? ctrl.close() : ctrl.enqueue(part.value)))),
    )

  const cancel = (reason: unknown) =>
    Effect.sync(() => ctl.abort(reason)).pipe(Effect.andThen(Effect.promise(() => reader.cancel(reason))))

  const body = new ReadableStream<Uint8Array>({
    pull: (ctrl) => Effect.runPromise(pull(ctrl)),
    cancel: (reason) => Effect.runPromise(cancel(reason)),
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const isJsonArray = (json: Schema.Json | undefined): json is ReadonlyArray<Schema.Json> => Array.isArray(json)
const isJsonObject = (json: Schema.Json): json is Schema.JsonObject => Predicate.isObject(json)

// A Responses request that is not stored cannot refer to earlier input items by id, so the ids are
// dropped from its input items. Some(text) is the rewritten body; None leaves the body unchanged.
const withoutInputItemIDs = (text: string) =>
  decodeJsonObject(text).pipe(
    Option.flatMap((body) => {
      const input = body.input
      if (body.store === true || !isJsonArray(input)) return Option.none()
      return Option.some(
        encodeJson({
          ...body,
          input: input.map((item) =>
            isJsonObject(item) ? Record.remove<string, Schema.Json, "id">(item, "id") : item,
          ),
        }),
      )
    }),
  )

function prepareOptions(model: ModelV2.Info, pkg: string) {
  const options: Record<string, any> = {
    name: model.providerID,
    ...(model.api.type === "aisdk" ? (model.api.settings ?? {}) : {}),
    ...model.request.body,
  }
  if (model.api.type === "aisdk" && model.api.url) options.baseURL = model.api.url

  const customFetch = options.fetch
  const chunkTimeout = options.chunkTimeout
  delete options.chunkTimeout
  const chunkTimeoutMs =
    typeof chunkTimeout === "number" && chunkTimeout > 0 ? Option.some(chunkTimeout) : Option.none<number>()

  const request = Effect.fnUntraced(function* (input: Parameters<typeof fetch>[0], init: RequestInit | undefined) {
    // Each request gets its own controller, so an SSE chunk timeout aborts only that request.
    const chunk = Option.map(chunkTimeoutMs, (ms) => ({ ms, ctl: new AbortController() }))
    // `options.timeout` is read per request: SDK hooks may change the options after this point.
    const abortSignals = [
      ...Option.toArray(Option.fromNullishOr(init?.signal)),
      ...Option.toArray(Option.map(chunk, (item) => item.ctl.signal)),
      ...(Predicate.isNotNullish(options.timeout) && options.timeout !== false
        ? [AbortSignal.timeout(options.timeout)]
        : []),
    ]
    const opts: RequestInit = { ...init }
    if (abortSignals.length === 1) opts.signal = abortSignals[0]
    if (abortSignals.length > 1) opts.signal = AbortSignal.any(abortSignals)

    if (
      (pkg === "@ai-sdk/openai" || pkg === "@ai-sdk/azure" || pkg === "@ai-sdk/amazon-bedrock/mantle") &&
      Predicate.isString(opts.body) &&
      opts.method === "POST"
    ) {
      const body = withoutInputItemIDs(opts.body)
      if (Option.isSome(body)) opts.body = body.value
    }

    // A rejected fetch stays a defect, so the AI SDK gets the original error (an AbortError, a network
    // TypeError) from Effect.runPromise.
    const res = yield* Effect.promise<Response>(() =>
      (typeof customFetch === "function" ? customFetch : fetch)(input, {
        ...opts,
        timeout: false,
      }),
    )
    return Option.match(chunk, { onNone: () => res, onSome: (item) => wrapSSE(res, item.ms, item.ctl) })
  })

  // The AI SDK calls `fetch` and expects a Promise, so the Effect runs at this boundary.
  options.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Effect.runPromise(request(input, init))

  return options
}

export class InitError extends Schema.TaggedError<InitError>()("AISDK.InitError", {
  providerID: ProviderV2.ID,
  cause: Schema.Defect(),
}) {}

function initError(providerID: ProviderV2.ID) {
  return Effect.catchCause((cause) => Effect.fail(new InitError({ providerID, cause: Cause.squash(cause) })))
}

export interface Interface {
  readonly hook: {
    readonly sdk: (
      callback: (event: SDKEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly language: (
      callback: (event: LanguageEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
  }
  readonly runSDK: (event: SDKEvent) => Effect.Effect<SDKEvent>
  readonly runLanguage: (event: LanguageEvent) => Effect.Effect<LanguageEvent>
  readonly language: (model: ModelV2.Info) => Effect.Effect<LanguageModelV3, InitError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/AISDK") {}

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let sdkHooks: ((event: SDKEvent) => Effect.Effect<void> | void)[] = []
    let languageHooks: ((event: LanguageEvent) => Effect.Effect<void> | void)[] = []
    const languages = new Map<string, LanguageModelV3>()
    const sdks = new Map<string, SDK>()

    const register = <Event>(
      hooks: () => ((event: Event) => Effect.Effect<void> | void)[],
      update: (hooks: ((event: Event) => Effect.Effect<void> | void)[]) => void,
    ) =>
      Effect.fn("AISDK.hook")(function* (callback: (event: Event) => Effect.Effect<void> | void) {
        const scope = yield* Scope.Scope
        let active = true
        update([...hooks(), callback])
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          update(hooks().filter((item) => item !== callback))
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      })

    const run = Effect.fnUntraced(function* <Event>(
      hooks: readonly ((event: Event) => Effect.Effect<void> | void)[],
      event: Event,
    ) {
      for (const hook of hooks) {
        const result = hook(event)
        if (Effect.isEffect(result)) yield* result
      }
      return event
    })

    const service = Service.of({
      hook: {
        sdk: register(
          () => sdkHooks,
          (next) => (sdkHooks = next),
        ),
        language: register(
          () => languageHooks,
          (next) => (languageHooks = next),
        ),
      },
      runSDK: (event) => run(sdkHooks, event),
      runLanguage: (event) => run(languageHooks, event),
      language: Effect.fn("AISDK.language")(function* (model) {
        const key = `${model.providerID}/${model.id}/${model.request.variant ?? "default"}`
        const existing = languages.get(key)
        if (existing) return existing
        if (model.api.type !== "aisdk")
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error(`Unsupported api ${model.api.type}`),
          })

        const options = prepareOptions(model, model.api.package)
        const sdkKey = JSON.stringify({
          providerID: model.providerID,
          api: model.api,
          options,
        })
        const sdk =
          sdks.get(sdkKey) ??
          (yield* service.runSDK({ model, package: model.api.package, options }).pipe(initError(model.providerID))).sdk
        if (!sdk)
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error("No AISDK provider plugin returned an SDK"),
          })
        sdks.set(sdkKey, sdk)
        const result = yield* service.runLanguage({ model, sdk, options }).pipe(initError(model.providerID))
        const language = yield* Effect.sync(() => result.language ?? sdk.languageModel(model.api.id)).pipe(
          initError(model.providerID),
        )
        languages.set(key, language)
        return language
      }),
    })
    return service
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [] })
