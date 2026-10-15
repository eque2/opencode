import { Effect, Option, Predicate } from "effect"
import type { EventV2 } from "@opencode-ai/core/event"
import type { Database } from "@opencode-ai/core/database/database"
import type { BackgroundJob } from "@/background/job"
import type { InstanceStore } from "@/project/instance-store"
import type { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionStatus } from "@/session/status"
import type { BlendModel } from "@/task/blend/model"
import type { Ops } from "./ops"

// The child sessions of the harness: their protocol messages (harness contract, section 4), their creation and
// prompting in their own instance, and the spend-cap check at the end of a turn. Permission and agent state are per
// instance, so a child is created, prompted and cancelled inside the same `InstanceStore.provide`. The builder watch
// is the task supervisor's (AD-11).

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
  "- For each scenario under Scenarios, write one test titled with its id in brackets, for example `[S1] …`, that checks it end to end.",
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
  /** Whether a task or `outside` id the scenarios need is trusted when the attempt starts. */
  readonly trusted: (id: string) => boolean
}) => {
  const { task, spec } = input
  const obligations = spec.obligations.filter((obligation) => obligation.task === task.id)
  // The scenarios this task completes: it supports them and every other task they need is already trusted. Their
  // `[S<n>]` tests are this builder's to write; nobody else would, and a scenario is proved only by its tests.
  const scenarios = spec.scenarios.filter(
    (scenario) => scenario.needs.includes(task.id) && scenario.needs.every((id) => id === task.id || input.trusted(id)),
  )
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
    ...section(
      "Scenarios",
      scenarios.flatMap((scenario) => [`- ${scenario.id}: ${oneLine(scenario.title)}`, ...scenario.steps.map((step) => `  ${oneLine(step)}`)]),
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
    // A reviewer judges a parent's `proof: review` obligations on the combined diff of its trusted children (blend
    // README, "Proofs and judges"). A parent has no builder, so no test carries its id.
    ...(input.role === "reviewer"
      ? [
          "Review the combined diff in the current directory and run `bun --no-env-file test`. A unit is trusted only when the combined",
          "diff meets exactly its text. The review is its proof: no test is titled with its id, and none is needed.",
          "Call `verdict` once with one entry for every id above",
        ]
      : [
          "Inspect the code in the current directory and run `bun --no-env-file test`. A unit is trusted only when the code and a passing",
          "test titled with its id in brackets prove exactly its text. Call `verdict` once with one entry for every id above",
        ]),
    '({ id, verdict: "trusted" | "rejected", reason }), give a reason for each rejection, then stop.',
  ].join("\n")

/** Asks the same judge once more for the ids it gave no verdict: their `judge` lines only, no marker. */
export const judgeMissingMessage = (judge: ReadonlyArray<{ readonly id: string; readonly text: string }>) =>
  [
    ...judge.map((item) => `judge ${item.id}: ${oneLine(item.text)}`),
    "",
    "You gave no verdict for the ids above. Call `verdict` once with one entry for each of them, then stop.",
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

// --- the end of a turn ------------------------------------------------------------------------------------------------

/** A provider retry with one of these messages is a spend cap: no retry can succeed, a human must act. */
export const SPEND_CAP = /insufficient_quota|exceeded your current quota|spend.?cap|billing/i

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

export * as TaskSessions from "./sessions"
