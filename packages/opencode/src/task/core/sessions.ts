import { Clock, Duration, Effect, Option, Predicate, Ref, Stream } from "effect"
import type { EventV2 } from "@opencode-ai/core/event"
import type { Database } from "@opencode-ai/core/database/database"
import type { BackgroundJob } from "@/background/job"
import type { InstanceStore } from "@/project/instance-store"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionStatus } from "@/session/status"
import type { BlendModel } from "@/task/blend/model"
import type { TaskLimits } from "@/task/limits"
import type { Ops } from "./ops"

// The child sessions of the harness: their protocol messages (harness contract, section 4), their creation and
// prompting in their own instance, and the builder watchdog. Runner, permission and agent state are per instance,
// so a child is created, prompted and cancelled inside the same `InstanceStore.provide`.

/** The opencode services the harness uses, resolved once per `/task`. */
export interface Env {
  readonly sessions: Session.Interface
  readonly status: SessionStatus.Interface
  readonly instances: InstanceStore.Interface
  readonly events: EventV2.Interface
  readonly background: BackgroundJob.Interface
  readonly db: Database.Interface["db"]
  readonly ops: Ops
}

export type Model = Parameters<Ops["prompt"]>[0]["model"]

// --- messages -----------------------------------------------------------------------------------------------------

/** One line of text: a reason or an obligation text may span lines, a protocol line may not. */
export const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " | ").trim()

export interface Reopen {
  readonly id: string
  readonly reason: string
}

const section = (title: string, lines: ReadonlyArray<string>) => (lines.length === 0 ? [] : ["", `## ${title}`, ...lines])

/** The rules every builder message ends with. */
const rules = (task: BlendModel.Task, spec: BlendModel.Spec) => [
  "",
  "## Rules",
  "- Work only in the current directory: it is this task's own git worktree. Do not commit; the harness commits.",
  `- Title every test with the id of the obligation it proves, in brackets, for example \`[${task.id}.c1] …\`. Never use another task's id.`,
  "- Change only the files under Touches, plus test files (under `test/`, or named `*.test.*` or `*.spec.*`).",
  ...task.gates.map((gate) => `- The gate ${gate} must pass: \`${spec.gates[gate]?.command ?? gate}\`.`),
  "- Run the tests and the gates. When the task is done, call `task_ready` once and end your turn: the harness then runs the proofs.",
]

/**
 * A builder attempt: the marker (first message of the session only), the attempt line, one `reopen` line per
 * reopened obligation (attempt 2 on), then the task, its obligations and the rules.
 */
export const builderMessage = (input: {
  readonly first: boolean
  readonly attempt: number
  readonly reopen: ReadonlyArray<Reopen>
  readonly task: BlendModel.Task
  readonly spec: BlendModel.Spec
}) => {
  const { task, spec } = input
  const obligations = spec.obligations.filter((obligation) => obligation.task === task.id)
  return [
    ...(input.first ? [`task-harness role=builder task=${task.id}`] : []),
    `task-harness attempt=${input.attempt}`,
    ...(input.attempt > 1 ? input.reopen.map((item) => `reopen ${item.id}: ${oneLine(item.reason)}`) : []),
    "",
    `# Task ${task.id}: ${task.title}`,
    ...section("Goal", [task.goal]),
    ...section("Approach", task.approach ? [task.approach] : []),
    ...section(
      "Touches",
      task.touches.map((touch) => `- \`${touch.path}\` (${touch.change}): ${oneLine(touch.what)}`),
    ),
    ...section(
      "Refs",
      task.refs.map((ref) => `- ${ref}: ${oneLine(spec.refs[ref] ?? "")}`),
    ),
    ...section(
      "Not here",
      task.notHere.map((item) => `- ${oneLine(item.what)} (owned by ${item.owner})`),
    ),
    ...section("Hint", task.hint ? [task.hint] : []),
    ...section(
      "Obligations",
      obligations.map((obligation) => `- ${obligation.id}: ${oneLine(obligation.text)}`),
    ),
    ...rules(task, spec),
  ].join("\n")
}

/** Resumes a builder turn that a stall or a crash cut: no attempt line, so the attempt goes on. */
export const continueMessage =
  "Continue the task from where you stopped. When it is done, call task_ready once and end your turn."

/** Sent when a builder turn ended without `task_ready`; no attempt line. */
export const nudgeMessage = "Call task_ready when the task is done."

/** A verifier, reviewer or scenario judge round: the marker, one `judge` line per id, then the instructions. */
export const judgeMessage = (input: {
  readonly role: "verifier" | "reviewer"
  readonly kind: "task" | "scenario"
  readonly unit: string
  readonly judge: ReadonlyArray<{ readonly id: string; readonly text: string }>
  readonly about: ReadonlyArray<string>
}) =>
  [
    `task-harness role=${input.role} ${input.kind}=${input.unit}`,
    ...input.judge.map((item) => `judge ${item.id}: ${oneLine(item.text)}`),
    "",
    ...input.about,
    "",
    "Inspect the code in the current directory and run `bun test`. A unit is trusted only when the code and a passing",
    "test titled with its id in brackets prove exactly its text. Call `verdict` once with one entry for every id above",
    '({ id, verdict: "trusted" | "rejected", reason }), give a reason for each rejection, then stop.',
  ].join("\n")

// --- child sessions -----------------------------------------------------------------------------------------------

/** Creates a child session of the root session in the instance of `directory`. */
export const create = (
  env: Env,
  directory: string,
  input: { readonly parentID: SessionID; readonly title: string; readonly agent: string },
) => env.instances.provide({ directory }, env.sessions.create(input))

/** One turn in the instance of `directory`: a user message, then the model loop until it ends. */
export const prompt = (
  env: Env,
  directory: string,
  input: { readonly session: SessionID; readonly agent: string; readonly model: Model; readonly text: string },
) =>
  env.instances.provide(
    { directory },
    env.ops.prompt({
      sessionID: input.session,
      agent: input.agent,
      model: input.model,
      parts: [{ type: "text", text: input.text }],
    }),
  )

/** Cancels the session's turn in its own instance. */
export const cancel = (env: Env, directory: string, session: SessionID) =>
  env.instances.provide({ directory }, env.ops.cancel(session))

const ATTEMPT = /task-harness attempt=(\d+)/g

/** What a builder session already holds: whether its marker was sent, and the latest attempt line. */
export const builderHistory = Effect.fn("TaskSessions.builderHistory")(function* (env: Env, session: SessionID) {
  const messages = yield* env.sessions.messages({ sessionID: session }).pipe(Effect.orElseSucceed(() => []))
  const texts = messages
    .filter((message) => message.info.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
  const attempts = texts.flatMap((text) => [...text.matchAll(ATTEMPT)].map((match) => Number(match[1])))
  return {
    marked: texts.some((text) => text.includes("task-harness role=builder")),
    attempt: attempts.reduce((max, value) => Math.max(max, value), 0),
  }
})

// --- the builder watchdog ---------------------------------------------------------------------------------------------

/** A provider retry with one of these messages is a spend cap: no retry can succeed, a human must act. */
export const SPEND_CAP = /insufficient_quota|exceeded your current quota|spend.?cap|billing/i

export type Outcome =
  | { readonly kind: "ended" }
  | { readonly kind: "stall"; readonly reason: string }
  | { readonly kind: "spend-cap"; readonly reason: string }

const POLL = Duration.millis(200)

const errorMessage = (error: unknown) => {
  if (!Predicate.hasProperty(error, "data") || !Predicate.hasProperty(error.data, "message")) return Option.none()
  return Predicate.isString(error.data.message) ? Option.some(error.data.message) : Option.none()
}

// The assistant messages of the current turn: created at or after its start.
const turnMessages = Effect.fnUntraced(function* (env: Env, session: SessionID, since: number) {
  const messages = yield* env.sessions.messages({ sessionID: session, limit: 6 }).pipe(Effect.orElseSucceed(() => []))
  return messages.filter((message) => message.info.role === "assistant" && message.info.time.created >= since)
})

/** The spend-cap error that ended the turn, if one did (a provider error that opencode does not retry). */
export const spendCapError = Effect.fn("TaskSessions.spendCapError")(function* (
  env: Env,
  session: SessionID,
  since: number,
) {
  const messages = yield* turnMessages(env, session, since)
  return Option.firstSomeOf(
    messages.map((message) =>
      Option.filter(
        message.info.role === "assistant" ? errorMessage(message.info.error) : Option.none(),
        (text) => SPEND_CAP.test(text),
      ),
    ),
  )
})

/**
 * One builder turn under the watchdog, in the worktree's instance. Every 200 ms it reads the session: a provider
 * retry whose message is a spend cap cancels the turn (`spend-cap`); a busy session with no running tool whose
 * stream has not moved for `limits.streamIdle` is cut (`stall`). Stream activity is any part update or delta of the
 * session, and any change of its status.
 */
export const builderTurn = Effect.fn("TaskSessions.builderTurn")(function* (
  env: Env,
  input: {
    readonly directory: string
    readonly session: SessionID
    readonly agent: string
    readonly model: Model
    readonly text: string
    readonly limits: TaskLimits.Limits
  },
) {
  const idle = Duration.toMillis(input.limits.streamIdle)
  const body = Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const activity = yield* Ref.make(started)
    const outcome = yield* Ref.make<Outcome>({ kind: "ended" })
    const touch = Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(activity, now))
    const own = (event: { readonly data: { readonly sessionID: string } }) => event.data.sessionID === input.session
    yield* Stream.merge(
      env.events.subscribe(MessageV2.Event.PartDelta).pipe(Stream.filter(own)),
      env.events.subscribe(MessageV2.Event.PartUpdated).pipe(Stream.filter(own)),
    ).pipe(
      Stream.runForEach(() => touch),
      Effect.forkScoped,
    )
    const stop = (next: Outcome) =>
      Effect.gen(function* () {
        yield* Ref.set(outcome, next)
        yield* env.ops.cancel(input.session)
      })
    const watch = Effect.gen(function* () {
      const busy = yield* Ref.make(false)
      while (true) {
        yield* Effect.sleep(POLL)
        const status = yield* env.status.get(input.session)
        if (status.type === "retry" && SPEND_CAP.test(status.message)) {
          return yield* stop({ kind: "spend-cap", reason: `spend cap: ${oneLine(status.message)}` })
        }
        const was = yield* Ref.getAndSet(busy, status.type === "busy")
        if (status.type !== "busy" || !was) {
          yield* touch
          continue
        }
        const messages = yield* turnMessages(env, input.session, started)
        const running = messages.some((message) =>
          message.parts.some((part) => part.type === "tool" && part.state.status === "running"),
        )
        if (running) {
          yield* touch
          continue
        }
        const now = yield* Clock.currentTimeMillis
        if (now - (yield* Ref.get(activity)) >= idle) {
          return yield* stop({
            kind: "stall",
            reason: `stall: no stream activity for ${Math.round(idle / 1000)} s`,
          })
        }
      }
    })
    yield* watch.pipe(Effect.forkScoped)
    yield* env.ops.prompt({
      sessionID: input.session,
      agent: input.agent,
      model: input.model,
      parts: [{ type: "text", text: input.text }],
    })
    return { outcome: yield* Ref.get(outcome), started }
  })
  return yield* env.instances.provide({ directory: input.directory }, Effect.scoped(body))
})

export * as TaskSessions from "./sessions"
