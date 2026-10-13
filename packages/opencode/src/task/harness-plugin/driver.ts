import type { PluginInput } from "@opencode-ai/plugin"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk"
import { Clock, Duration, Effect, Option, Predicate, Ref, Schema } from "effect"
import type { TaskLimits } from "@/task/limits"
import { HarnessMessages } from "./messages"
import { HarnessRegistry } from "./registry"

// The child sessions of O3, driven only through the SDK client the plugin receives: create (with `parentID`, the
// role's agent and the role's permission rules), prompt, abort, read messages and status. Every call names the
// session's directory, so it runs in that directory's instance. The builder watchdog lives here too.

export type Client = PluginInput["client"]

/** An SDK call failed or returned no data. */
export class SdkError extends Schema.TaggedError<SdkError>()("TaskHarnessSdkError", {
  message: Schema.String,
}) {}

type Reply<T> = { readonly data?: T; readonly error?: unknown }

const describe = (error: unknown) => {
  if (Predicate.hasProperty(error, "data") && Predicate.hasProperty(error.data, "message")) return String(error.data.message)
  if (Predicate.hasProperty(error, "message")) return String(error.message)
  return String(error)
}

/** One SDK call: its data, or an `SdkError` naming the call. Interrupting it aborts the HTTP request. */
const call = <T>(name: string, run: (signal: AbortSignal) => Promise<Reply<T>>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SdkError({ message: `${name}: ${describe(cause)}` }) }).pipe(
    Effect.flatMap((reply) =>
      Option.match(Option.fromNullishOr(reply.data), {
        onNone: () => Effect.fail(new SdkError({ message: `${name}: ${describe(reply.error ?? "no data")}` })),
        onSome: (data: T) => Effect.succeed(data),
      }),
    ),
  )

/** Creates a child session of `parentID` in the instance of `directory`. Returns its id. */
export const create = Effect.fn("HarnessDriver.create")(function* (
  client: Client,
  directory: string,
  input: {
    readonly parentID: string
    readonly title: string
    readonly agent: string
    readonly permission: ReadonlyArray<{ readonly permission: string; readonly pattern: string; readonly action: string }>
  },
) {
  // The server takes `agent` and `permission` on create; the v1 types do not list them, so the body is built first.
  const body = { parentID: input.parentID, title: input.title, agent: input.agent, permission: input.permission }
  const session = yield* call("session.create", (signal) => client.session.create({ body, query: { directory }, signal }))
  return session.id
})

/** One turn: a user message with `text`, then the model loop until it ends. Resolves when the turn has ended. */
export const prompt = (
  client: Client,
  directory: string,
  input: { readonly session: string; readonly agent: string; readonly text: string },
) =>
  call("session.prompt", (signal) =>
    client.session.prompt({
      path: { id: input.session },
      query: { directory },
      body: { agent: input.agent, parts: [{ type: "text", text: input.text }] },
      signal,
    }),
  ).pipe(Effect.asVoid)

/** Aborts the session's turn in its instance. */
export const abort = (client: Client, directory: string, session: string) =>
  call("session.abort", (signal) => client.session.abort({ path: { id: session }, query: { directory }, signal })).pipe(
    Effect.asVoid,
  )

/** The session's messages, oldest first; the latest `limit` when given. */
export const messages = (client: Client, directory: string, session: string, limit?: number) =>
  call("session.messages", (signal) =>
    client.session.messages({
      path: { id: session },
      query: limit === undefined ? { directory } : { directory, limit },
      signal,
    }),
  )

/**
 * Shows a toast in a TUI attached to the directory: the only way the plugin API leaves to tell the user what a
 * `/task` that stopped its own command did. Headless, nobody sees it.
 */
export const toast = (client: Client, directory: string, message: string, variant: "info" | "error") =>
  call("tui.showToast", (signal) =>
    client.tui.showToast({ body: { title: "Task harness o3", message, variant }, query: { directory }, signal }),
  ).pipe(Effect.asVoid)

/** The session's status in its instance; idle when the instance holds none. */
export const status = (client: Client, directory: string, session: string) =>
  call("session.status", (signal) => client.session.status({ query: { directory }, signal })).pipe(
    Effect.map((all): SessionStatus => all[session] ?? { type: "idle" }),
  )

const ATTEMPT = /task-harness attempt=(\d+)/g

const userTexts = (items: ReadonlyArray<{ readonly info: Message; readonly parts: ReadonlyArray<Part> }>) =>
  items
    .filter((item) => item.info.role === "user")
    .flatMap((item) => item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))

/** What a builder session already holds: whether its marker was sent, and the latest attempt line. */
export const builderHistory = Effect.fn("HarnessDriver.builderHistory")(function* (
  client: Client,
  directory: string,
  session: string,
) {
  const texts = userTexts(yield* messages(client, directory, session))
  const attempts = texts.flatMap((text) => [...text.matchAll(ATTEMPT)].map((match) => Number(match[1])))
  return {
    marked: texts.some((text) => text.includes("task-harness role=builder")),
    attempt: attempts.reduce((max, value) => Math.max(max, value), 0),
  }
})

// --- the builder watchdog ---------------------------------------------------------------------------------------

/** A provider retry with one of these messages is a spend cap: no retry can succeed, a human must act. */
export const SPEND_CAP = /insufficient_quota|exceeded your current quota|spend.?cap|billing/i

export type Outcome =
  | { readonly kind: "ended" }
  | { readonly kind: "stall"; readonly reason: string }
  | { readonly kind: "spend-cap"; readonly reason: string }

const POLL = Duration.millis(200)

// The assistant messages of the current turn: created at or after its start.
const turnMessages = Effect.fnUntraced(function* (client: Client, directory: string, session: string, since: number) {
  const items = yield* messages(client, directory, session, 6).pipe(Effect.orElseSucceed(() => []))
  return items.filter((item) => item.info.role === "assistant" && item.info.time.created >= since)
})

/** The spend-cap error that ended the turn, if one did (a provider error that opencode does not retry). */
export const spendCapError = Effect.fn("HarnessDriver.spendCapError")(function* (
  client: Client,
  directory: string,
  session: string,
  since: number,
) {
  const items = yield* turnMessages(client, directory, session, since)
  return Option.firstSomeOf(
    items.map((item) =>
      item.info.role === "assistant" && item.info.error !== undefined && Predicate.hasProperty(item.info.error.data, "message")
        ? Option.filter(Option.some(String(item.info.error.data.message)), (text) => SPEND_CAP.test(text))
        : Option.none(),
    ),
  )
})

/**
 * One builder turn under the watchdog. Every 200 ms it reads the session's status: a provider retry whose message
 * is a spend cap aborts the turn (`spend-cap`); a session busy for two polls in a row with no running tool whose
 * stream has not moved for `limits.streamIdle` is aborted (`stall`). Stream activity is any part update or delta of
 * the session that the `event` hook saw, and any poll where the session is not busy or runs a tool.
 */
export const builderTurn = Effect.fn("HarnessDriver.builderTurn")(function* (
  client: Client,
  input: {
    readonly directory: string
    readonly session: string
    readonly agent: string
    readonly text: string
    readonly limits: TaskLimits.Limits
  },
) {
  const idle = Duration.toMillis(input.limits.streamIdle)
  const { directory, session } = input
  const body = Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const outcome = yield* Ref.make<Outcome>({ kind: "ended" })
    const touch = Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => HarnessRegistry.touch(session, now)))
    yield* touch
    const stop = (next: Outcome) =>
      Ref.set(outcome, next).pipe(Effect.andThen(abort(client, directory, session)), Effect.ignore)
    const watch = Effect.gen(function* () {
      let busy = false
      while (true) {
        yield* Effect.sleep(POLL)
        const current = yield* status(client, directory, session).pipe(Effect.option)
        if (Option.isNone(current)) continue
        if (current.value.type === "retry" && SPEND_CAP.test(current.value.message)) {
          return yield* stop({ kind: "spend-cap", reason: `spend cap: ${HarnessMessages.oneLine(current.value.message)}` })
        }
        const was = busy
        busy = current.value.type === "busy"
        if (!busy || !was) {
          yield* touch
          continue
        }
        const items = yield* turnMessages(client, directory, session, started)
        const running = items.some((item) =>
          item.parts.some((part) => part.type === "tool" && part.state.status === "running"),
        )
        if (running) {
          yield* touch
          continue
        }
        const now = yield* Clock.currentTimeMillis
        const last = Option.getOrElse(HarnessRegistry.lastActivity(session), () => started)
        if (now - last >= idle) {
          return yield* stop({ kind: "stall", reason: `stall: no stream activity for ${Math.round(idle / 1000)} s` })
        }
      }
    })
    yield* watch.pipe(Effect.forkScoped)
    yield* prompt(client, directory, { session, agent: input.agent, text: input.text })
    return { outcome: yield* Ref.get(outcome), started }
  })
  return yield* Effect.scoped(body)
})

export * as HarnessDriver from "./driver"
