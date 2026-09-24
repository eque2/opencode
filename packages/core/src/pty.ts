export * as Pty from "./pty"

import { makeLocationNode } from "./effect/app-node"
import type { Disp, Proc } from "#pty"
import { Context, Effect, Layer, MutableHashMap, Option, Schema, Types } from "effect"
import { Pty } from "@opencode-ai/schema/pty"
import { Config } from "./config"
import { EventV2 } from "./event"
import { Location } from "./location"
import { PtyID } from "./pty/schema"
import { Shell } from "./shell"
import { lazy } from "./util/lazy"

const BUFFER_LIMIT = 1024 * 1024 * 2
// Exited sessions stay observable (status, exit code, retained output) until removed explicitly.
// Cap retention so abandoned terminals do not accumulate unbounded buffers.
const EXITED_LIMIT = 25
const pty = lazy(() => import("#pty"))

// Subscriber callbacks and the native kill run on the synchronous PTY path. A throwing
// callback must not break delivery to the others, so each call reports success as an
// Option instead of throwing.
const attempt = <A extends ReadonlyArray<unknown>>(callback: (...args: A) => void, ...args: A) =>
  Option.isSome(Option.liftThrowable(callback)(...args))

type Subscriber = {
  readonly onData: (chunk: string) => void
  readonly onEnd: (event: { exitCode?: number }) => void
  active: boolean
  detached: boolean
  pending: string[]
  // The end event that arrived before activate(), delivered when the subscriber activates.
  end: Option.Option<{ exitCode?: number }>
}

type Active = {
  info: Info
  process: Proc
  buffer: string
  bufferCursor: number
  cursor: number
  // Keyed by a per-service attach counter, so every attachment has its own entry.
  subscribers: MutableHashMap.MutableHashMap<number, Subscriber>
  listeners: Disp[]
}

export const Info = Pty.Info
export type Info = Types.DeepMutable<typeof Info.Type>

export const CreateInput = Pty.CreateInput

export type CreateInput = Types.DeepMutable<typeof CreateInput.Type>

export const UpdateInput = Pty.UpdateInput

export type UpdateInput = Types.DeepMutable<typeof UpdateInput.Type>

export const Event = Pty.Event

export type AttachInput = {
  // Absolute output cursor to replay from. -1 tails from the current end; omitted replays the full retained buffer.
  readonly cursor?: number
  // Callbacks fire synchronously from the native PTY data path; keep them non-blocking.
  readonly onData: (chunk: string) => void
  // Fired once when the session stops producing output: process exit (exitCode set), removal, or service teardown.
  readonly onEnd: (event: { exitCode?: number }) => void
}

export type Attachment = {
  // Retained output from the requested cursor to the current end.
  readonly replay: string
  // Absolute output cursor after replay.
  readonly cursor: number
  readonly write: (data: string) => void
  // Starts live delivery after the caller has applied replay and cursor metadata.
  readonly activate: () => void
  readonly detach: () => void
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Pty.NotFoundError", {
  ptyID: PtyID,
}) {}

export class ExitedError extends Schema.TaggedError<ExitedError>()("Pty.ExitedError", {
  ptyID: PtyID,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: PtyID) => Effect.Effect<void, NotFoundError>
  readonly write: (id: PtyID, data: string) => Effect.Effect<void, NotFoundError>
  readonly attach: (id: PtyID, input: AttachInput) => Effect.Effect<Attachment, NotFoundError | ExitedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Pty") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const sessions = MutableHashMap.empty<PtyID, Active>()
    const exitOrder: PtyID[] = []
    let nextSubscriber = 0

    function notifyEnd(session: Active, event: { exitCode?: number }) {
      for (const subscriber of MutableHashMap.values(session.subscribers)) {
        if (!subscriber.active) {
          subscriber.end = Option.some(event)
          continue
        }
        attempt(subscriber.onEnd, event)
      }
      MutableHashMap.clear(session.subscribers)
    }

    function teardown(session: Active) {
      for (const listener of session.listeners) listener.dispose()
      session.listeners.length = 0
      if (session.info.status === "running") attempt(() => session.process.kill())
      notifyEnd(session, {})
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const session of MutableHashMap.values(sessions)) teardown(session)
        MutableHashMap.clear(sessions)
        exitOrder.length = 0
      }),
    )

    const requireSession = Effect.fn("Pty.requireSession")(function* (id: PtyID) {
      const session = MutableHashMap.get(sessions, id)
      if (Option.isNone(session)) return yield* new NotFoundError({ ptyID: id })
      return session.value
    })

    const removeSession = Effect.fnUntraced(function* (id: PtyID) {
      const found = MutableHashMap.get(sessions, id)
      if (Option.isNone(found)) return
      const session = found.value
      MutableHashMap.remove(sessions, id)
      const index = exitOrder.indexOf(id)
      if (index !== -1) exitOrder.splice(index, 1)
      yield* Effect.logInfo("removing session", { id })
      teardown(session)
      yield* events.publish(Event.Deleted, { id: session.info.id })
    })

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      yield* requireSession(id)
      yield* removeSession(id)
    })

    const list = Effect.fn("Pty.list")(function* () {
      return Array.from(MutableHashMap.values(sessions), (session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      return (yield* requireSession(id)).info
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      const id = PtyID.ascending()
      const command = input.command || Shell.preferred(Config.latest(yield* config.entries(), "shell"))
      const args = Shell.login(command) ? [...(input.args ?? []), "-l"] : [...(input.args ?? [])]
      const cwd = input.cwd || location.directory
      const env = {
        ...process.env,
        ...input.env,
        TERM: "xterm-256color",
        OPENCODE_TERMINAL: "1",
      } as Record<string, string>
      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      yield* Effect.logInfo("creating session", { id, cmd: command, args, cwd })
      const { spawn } = yield* Effect.promise(() => pty())
      const proc = yield* Effect.sync(() => spawn(command, args, { name: "xterm-256color", cwd, env }))
      const info: Info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "running",
        pid: proc.pid,
      }
      const session: Active = {
        info,
        process: proc,
        buffer: "",
        bufferCursor: 0,
        cursor: 0,
        subscribers: MutableHashMap.empty(),
        listeners: [],
      }
      MutableHashMap.set(sessions, id, session)
      session.listeners.push(
        proc.onData((chunk) => {
          session.cursor += chunk.length
          for (const [token, subscriber] of session.subscribers) {
            if (!subscriber.active) {
              subscriber.pending.push(chunk)
              continue
            }
            if (!attempt(subscriber.onData, chunk)) MutableHashMap.remove(session.subscribers, token)
          }
          session.buffer += chunk
          if (session.buffer.length <= BUFFER_LIMIT) return
          const excess = session.buffer.length - BUFFER_LIMIT
          session.buffer = session.buffer.slice(excess)
          session.bufferCursor += excess
        }),
        proc.onExit(({ exitCode }) => {
          if (session.info.status === "exited") return
          session.info.status = "exited"
          session.info.exitCode = exitCode
          notifyEnd(session, { exitCode })
          exitOrder.push(id)
          runFork(
            Effect.gen(function* () {
              yield* Effect.logInfo("session exited", { id, exitCode })
              yield* events.publish(Event.Exited, { id, exitCode })
              while (exitOrder.length > EXITED_LIMIT) {
                const oldest = exitOrder[0]
                if (!oldest) break
                yield* removeSession(oldest)
              }
            }),
          )
        }),
      )
      yield* events.publish(Event.Created, { info })
      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const session = yield* requireSession(id)
      if (input.title) session.info.title = input.title
      if (input.size && session.info.status === "running") session.process.resize(input.size.cols, input.size.rows)
      yield* events.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string) {
      const session = yield* requireSession(id)
      if (session.info.status === "running") session.process.write(data)
    })

    const attach = Effect.fn("Pty.attach")(function* (id: PtyID, input: AttachInput) {
      const session = yield* requireSession(id)
      if (session.info.status !== "running") return yield* new ExitedError({ ptyID: id })
      yield* Effect.logInfo("client attached to session", { id, directory: location.directory })
      const token = nextSubscriber++
      const subscriber: Subscriber = {
        onData: input.onData,
        onEnd: input.onEnd,
        active: false,
        detached: false,
        pending: [],
        end: Option.none(),
      }
      MutableHashMap.set(session.subscribers, token, subscriber)
      const start = session.bufferCursor
      const end = session.cursor
      const from =
        input.cursor === -1
          ? end
          : typeof input.cursor === "number" && Number.isSafeInteger(input.cursor)
            ? Math.max(0, input.cursor)
            : 0
      const replay = (() => {
        if (!session.buffer || from >= end) return ""
        const offset = Math.max(0, from - start)
        if (offset >= session.buffer.length) return ""
        return session.buffer.slice(offset)
      })()
      return {
        replay,
        cursor: end,
        write: (data: string) => {
          if (session.info.status === "running") session.process.write(data)
        },
        activate: () => {
          if (subscriber.active || subscriber.detached) return
          subscriber.active = true
          const flushed = attempt(() => {
            for (const chunk of subscriber.pending) subscriber.onData(chunk)
            subscriber.pending.length = 0
            if (Option.isSome(subscriber.end)) subscriber.onEnd(subscriber.end.value)
          })
          if (!flushed) MutableHashMap.remove(session.subscribers, token)
        },
        detach: () => {
          subscriber.detached = true
          subscriber.pending.length = 0
          subscriber.end = Option.none()
          MutableHashMap.remove(session.subscribers, token)
        },
      }
    })

    return Service.of({ list, get, create, update, remove, write, attach })
  }),
)

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer))

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Location.node, Config.node] })
