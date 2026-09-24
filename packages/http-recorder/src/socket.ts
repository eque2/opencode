import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, Exit, Layer, Option, Ref, Scope, Semaphore } from "effect"
import { Socket } from "effect/unstable/socket"
import * as CassetteService from "./cassette.js"
import { canonicalizeJson, decodeJson, encodeJson, safeText } from "./matching.js"
import { makeReplayState, resolveAutoMode } from "./recorder.js"
import { make, type Redactor } from "./redactor.js"
import { webSocketInteractions } from "./schema.js"
import type {
  RecorderOptions,
  WebSocketEvent,
  WebSocketInteraction,
  WebSocketRecorderOptions,
  WebSocketRequest,
} from "./types.js"

interface ActiveReplay {
  readonly interaction: WebSocketInteraction
  readonly progress: Ref.Ref<{ readonly position: number; readonly changed: Deferred.Deferred<void> }>
  readonly writeLock: Semaphore.Semaphore
  readonly closed: Ref.Ref<boolean>
}

interface ActiveRecording {
  readonly events: Array<WebSocketEvent>
  readonly eventLock: Semaphore.Semaphore
  readonly accepting: Ref.Ref<boolean>
  opened: boolean
  valid: boolean
}

type Frame = string | Uint8Array

const encodeEvent = (direction: "client" | "server", message: Frame): WebSocketEvent =>
  typeof message === "string"
    ? { direction, kind: "text", body: message }
    : { direction, kind: "binary", body: Buffer.from(message).toString("base64"), bodyEncoding: "base64" }

const decodeEvent = (event: WebSocketEvent): Frame =>
  event.kind === "text" ? event.body : new Uint8Array(Buffer.from(event.body, "base64"))

const redactEvent = (event: WebSocketEvent, redactor: Redactor): WebSocketEvent => {
  if (event.kind === "binary") return event
  const body =
    event.direction === "client"
      ? redactor.request({ method: "WEBSOCKET", url: "", headers: {}, body: event.body }).body
      : redactor.response({ status: 101, headers: {}, body: event.body }).body
  return { ...event, body }
}

const comparable = (event: WebSocketEvent, asJson: boolean) => {
  if (!asJson || event.kind === "binary") return encodeJson(canonicalizeJson(event))
  const decoded = decodeJson(event.body)
  return encodeJson(
    canonicalizeJson({
      ...event,
      body: decoded._tag === "None" ? event.body : canonicalizeJson(decoded.value),
    }),
  )
}

const assertEvent = (actual: WebSocketEvent, expected: WebSocketEvent | undefined, index: number, asJson: boolean) =>
  Effect.sync(() => {
    if (expected && comparable(actual, asJson) === comparable(expected, asJson)) return
    throw new Error(`WebSocket event ${index + 1}: expected ${safeText(expected)}, received ${safeText(actual)}`)
  })

const replayClosed = () =>
  Effect.fail(
    new Socket.SocketError({
      reason: new Socket.SocketCloseError({ code: 1000 }),
    }),
  )

const replayPull = (state: ActiveReplay): Effect.Effect<readonly [Frame], Socket.SocketError> =>
  Effect.suspend(() =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state.progress)
      const event = state.interaction.events[current.position]
      if (yield* Ref.get(state.closed)) {
        if (!event) return yield* replayClosed()
        return yield* Effect.die(
          new Error(
            `WebSocket closed with unconsumed events: used ${current.position} of ${state.interaction.events.length}`,
          ),
        )
      }
      if (!event) return yield* replayClosed()
      if (event.direction === "client") {
        yield* Deferred.await(current.changed)
        return yield* replayPull(state)
      }
      yield* Ref.set(state.progress, {
        position: current.position + 1,
        changed: yield* Deferred.make<void>(),
      })
      return [decodeEvent(event)] as const
    }),
  )

const openSnapshot = (request: WebSocketRequest, redactor: Redactor) => {
  const snapshot = redactor.request({ method: "GET", url: request.url, headers: request.headers ?? {}, body: "" })
  return { url: snapshot.url, headers: snapshot.headers }
}

const makeRecordingSocket = (
  upstream: Socket.Socket,
  cassette: CassetteService.Interface,
  name: string,
  request: WebSocketRequest,
  options: WebSocketRecorderOptions,
  redactor: Redactor,
) =>
  Effect.gen(function* () {
    const active = yield* Ref.make(Option.none<ActiveRecording>())
    const writeLock = yield* Semaphore.make(1)

    return Socket.make({
      reader: Effect.acquireRelease(
        Effect.gen(function* () {
          const state: ActiveRecording = {
            events: [],
            eventLock: yield* Semaphore.make(1),
            accepting: yield* Ref.make(true),
            opened: false,
            valid: true,
          }
          const occupied = yield* Ref.modify(active, (current) => [
            Option.isSome(current),
            Option.orElseSome(current, () => state),
          ])
          if (occupied) return yield* Effect.die("Concurrent runs of a recorded WebSocket are not supported")
          const reader = yield* upstream.reader.pipe(
            Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Ref.set(active, Option.none()))),
          )
          state.opened = true
          return { reader, state }
        }),
        ({ state }, exit) =>
          writeLock.withPermit(
            state.eventLock.withPermit(
              Effect.gen(function* () {
                yield* Ref.set(state.accepting, false)
                yield* Ref.set(active, Option.none())
                if (!Exit.isSuccess(exit) || !state.opened || !state.valid) return
                yield* cassette
                  .append(
                    name,
                    {
                      transport: "websocket",
                      open: openSnapshot(request, redactor),
                      events: [...state.events],
                    },
                    options.metadata,
                  )
                  .pipe(Effect.orDie)
              }),
            ),
          ),
      ).pipe(
        Effect.map(({ reader, state }) => ({
          pull: reader.pull.pipe(
            Effect.tap((messages) =>
              state.eventLock.withPermit(
                Effect.sync(() => {
                  if (!Ref.getUnsafe(state.accepting)) throw new Error("WebSocket received a frame after closing")
                  for (const message of messages)
                    state.events.push(redactEvent(encodeEvent("server", message), redactor))
                }),
              ),
            ),
            Effect.onError(() => Effect.sync(() => (state.valid = false))),
          ),
          upgrade: reader.upgrade,
        })),
      ),
      writer: upstream.writer.pipe(
        Effect.map((writer) => {
          const writeFrames = (messages: ReadonlyArray<Frame>, send: Effect.Effect<void, Socket.SocketError>) =>
            writeLock.withPermit(
              Effect.gen(function* () {
                const current = yield* Ref.get(active)
                if (Option.isNone(current) || !(yield* Ref.get(current.value.accepting)))
                  return yield* Effect.die("WebSocket writer used without an active socket run")
                const state = current.value
                yield* state.eventLock.withPermit(
                  Effect.sync(() => {
                    for (const message of messages)
                      state.events.push(redactEvent(encodeEvent("client", message), redactor))
                  }),
                )
                return yield* send.pipe(Effect.onError(() => Effect.sync(() => (state.valid = false))))
              }),
            )

          return {
            write: (message) =>
              Socket.isCloseEvent(message) ? writer.write(message) : writeFrames([message], writer.write(message)),
            writeAll: (messages) => writeFrames(messages, writer.writeAll(messages)),
          }
        }),
      ),
    })
  })

const makeReplaySocket = (
  cassette: CassetteService.Interface,
  name: string,
  request: WebSocketRequest,
  options: WebSocketRecorderOptions,
  redactor: Redactor,
): Effect.Effect<Socket.Socket, never, Scope.Scope> =>
  Effect.gen(function* () {
    const replay = yield* makeReplayState(cassette, name, webSocketInteractions)
    const active = yield* Ref.make(Option.none<ActiveReplay>())

    const reader = Effect.acquireRelease(
      Effect.gen(function* () {
        const claimed = yield* replay
          .claim((interaction, index) =>
            Effect.sync(() => {
              const incoming = openSnapshot(request, redactor)
              if (
                interaction &&
                encodeJson(canonicalizeJson(incoming)) === encodeJson(canonicalizeJson(interaction.open))
              )
                return
              throw new Error(
                `WebSocket open ${index + 1}: expected ${safeText(interaction?.open)}, received ${safeText(incoming)}`,
              )
            }),
          )
          .pipe(Effect.orDie)
        const progress = yield* Ref.make({ position: 0, changed: yield* Deferred.make<void>() })
        const writeLock = yield* Semaphore.make(1)
        const state = {
          interaction: claimed.interaction,
          progress,
          writeLock,
          closed: yield* Ref.make(false),
        }
        const occupied = yield* Ref.modify(active, (current) => [
          Option.isSome(current),
          Option.orElseSome(current, () => state),
        ])
        if (occupied) return yield* Effect.die("Concurrent runs of a replayed WebSocket are not supported")
        return state
      }),
      () => Ref.set(active, Option.none()),
    ).pipe(
      Effect.map((state) => ({
        pull: replayPull(state),
        upgrade: Socket.SocketUpgradeError.unsupported,
      })),
    )
    const write: Socket.Writer["write"] = (message) => {
      return Ref.get(active).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die("WebSocket writer used without an active socket run"),
            onSome: (state) =>
              state.writeLock.withPermit(
                Effect.gen(function* () {
                  const current = yield* Ref.get(state.progress)
                  if (Socket.isCloseEvent(message)) {
                    yield* Ref.set(state.closed, true)
                    yield* Deferred.done(current.changed, Exit.void)
                    if (current.position !== state.interaction.events.length) {
                      yield* Effect.die(
                        new Error(
                          `WebSocket closed with unconsumed events: used ${current.position} of ${state.interaction.events.length}`,
                        ),
                      )
                    }
                    return
                  }
                  const actual = redactEvent(encodeEvent("client", message), redactor)
                  yield* assertEvent(
                    actual,
                    state.interaction.events[current.position],
                    current.position,
                    options.compareClientMessagesAsJson === true,
                  )
                  yield* Ref.set(state.progress, {
                    position: current.position + 1,
                    changed: yield* Deferred.make<void>(),
                  })
                  yield* Deferred.done(current.changed, Exit.void)
                }),
              ),
          }),
        ),
      )
    }

    return Socket.make({
      reader,
      writer: Effect.succeed({
        write,
        writeAll: (messages) =>
          Effect.gen(function* () {
            for (const message of messages) yield* write(message)
          }),
      }),
    })
  })

const recordingLayer = (
  name: string,
  request: WebSocketRequest,
  options: WebSocketRecorderOptions,
  forcedMode?: "record" | "replay",
): Layer.Layer<Socket.Socket, never, Socket.Socket | CassetteService.Service> =>
  Layer.effect(
    Socket.Socket,
    Effect.gen(function* () {
      const upstream = yield* Socket.Socket
      const cassette = yield* CassetteService.Service
      const redactor = make(options.redact)
      if ((forcedMode ?? (yield* resolveAutoMode(cassette, name))) === "record")
        return yield* makeRecordingSocket(upstream, cassette, name, request, options, redactor)
      return yield* makeReplaySocket(cassette, name, request, options, redactor)
    }),
  )

/**
 * Wraps a provided `Socket.Socket` with cassette recording and replay.
 *
 * Supply the ordinary URL-bound Effect socket layer beneath this decorator.
 * The cassette name identifies the connection; recorder configuration does not
 * duplicate the transport URL.
 */
export const socket = (name: string, options: RecorderOptions = {}): Layer.Layer<Socket.Socket, never, Socket.Socket> =>
  provideCassette(recordingLayer(name, { url: "" }, { ...options, compareClientMessagesAsJson: true }), options)

/** @internal */
export const socketLayer = (
  name: string,
  request: WebSocketRequest,
  options: WebSocketRecorderOptions & { readonly mode: "record" | "replay" },
): Layer.Layer<Socket.Socket, never, Socket.Socket> =>
  provideCassette(recordingLayer(name, request, options, options.mode), options)

const provideCassette = (
  layer: Layer.Layer<Socket.Socket, never, Socket.Socket | CassetteService.Service>,
  options: WebSocketRecorderOptions,
) =>
  layer.pipe(
    Layer.provide(CassetteService.fileSystem({ directory: options.directory })),
    Layer.provide(NodeFileSystem.layer),
  )
