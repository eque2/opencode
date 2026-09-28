import { Effect, MutableHashMap, MutableHashSet, Option, Schema } from "effect"

type Definition = {
  [method: string]: (input: any) => any
}

// Messages cross the worker boundary as JSON text, so every payload is a JSON value. A payload
// key is absent when JSON.stringify dropped an undefined value (a method without input or result).
const RpcRequest = Schema.Struct({
  type: Schema.Literal("rpc.request"),
  method: Schema.String,
  input: Schema.optionalKey(Schema.Json),
  id: Schema.Number,
}).annotate({ identifier: "RpcRequest", description: "A method call from the client to the worker" })

const RpcResult = Schema.Struct({
  type: Schema.Literal("rpc.result"),
  result: Schema.optionalKey(Schema.Json),
  id: Schema.Number,
}).annotate({ identifier: "RpcResult", description: "The result of one method call, matched by id" })

const RpcEvent = Schema.Struct({
  type: Schema.Literal("rpc.event"),
  event: Schema.String,
  data: Schema.optionalKey(Schema.Json),
}).annotate({ identifier: "RpcEvent", description: "An event that the worker emits to the client" })

// Text that is not an RPC message for this side is ignored.
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(RpcRequest))
const decodeClientMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([RpcResult, RpcEvent])))

// A payload that JSON cannot encode (a cycle, a bigint) throws, as JSON.stringify did.
const encodeMessage = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

// Each worker method is an Effect; `run` executes the reply on the worker's runtime.
export function listen<R>(
  rpc: { [method: string]: (input: any) => Effect.Effect<unknown, never, R> },
  run: (effect: Effect.Effect<void, never, R>) => unknown,
) {
  onmessage = (evt) => {
    const request = decodeRequest(evt.data)
    if (Option.isNone(request)) return
    run(
      rpc[request.value.method](request.value.input).pipe(
        Effect.flatMap((result) =>
          Effect.sync(() => postMessage(encodeMessage({ type: "rpc.result", result, id: request.value.id }))),
        ),
      ),
    )
  }
}

export function emit(event: string, data: unknown) {
  postMessage(encodeMessage({ type: "rpc.event", event, data }))
}

// Events maps each event name the worker emits to the type of its data.
export function client<T extends Definition, Events extends Record<string, unknown> = Record<string, unknown>>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent) => any) | null
}) {
  const pending = MutableHashMap.empty<number, (result: any) => void>()
  const listeners = MutableHashMap.empty<string, MutableHashSet.MutableHashSet<(data: any) => void>>()
  let id = 0
  target.onmessage = (evt) => {
    const message = decodeClientMessage(evt.data)
    if (Option.isNone(message)) return
    const parsed = message.value
    if (parsed.type === "rpc.result") {
      const resolve = MutableHashMap.get(pending, parsed.id)
      if (Option.isSome(resolve)) {
        resolve.value(parsed.result)
        MutableHashMap.remove(pending, parsed.id)
      }
      return
    }
    const handlers = MutableHashMap.get(listeners, parsed.event)
    if (Option.isNone(handlers)) return
    for (const handler of handlers.value) {
      handler(parsed.data)
    }
  }
  return {
    // A method without input takes no argument. An interrupted call (a timeout) drops its pending reply.
    call<Method extends keyof T>(method: Method, ...input: Parameters<T[Method]>) {
      return Effect.callback<ReturnType<T[Method]>>((resume) => {
        const requestId = id++
        MutableHashMap.set(pending, requestId, (result) => resume(Effect.succeed(result)))
        target.postMessage(encodeMessage({ type: "rpc.request", method, input: input[0], id: requestId }))
        return Effect.sync(() => {
          MutableHashMap.remove(pending, requestId)
        })
      })
    },
    on<Event extends keyof Events & string>(event: Event, handler: (data: Events[Event]) => void) {
      const handlers = Option.getOrElse(MutableHashMap.get(listeners, event), () => {
        const created = MutableHashSet.empty<(data: any) => void>()
        MutableHashMap.set(listeners, event, created)
        return created
      })
      MutableHashSet.add(handlers, handler)
      return () => {
        MutableHashSet.remove(handlers, handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
