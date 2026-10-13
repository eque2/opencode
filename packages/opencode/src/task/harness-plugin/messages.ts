import type { BlendModel } from "@/task/blend/model"

// The texts O3 sends: the protocol messages of the child sessions (harness contract, section 4), the prompts of
// its hidden agents, and their permission rules. Modelled on O1's `@/task/core/sessions` messages, which import
// in-core services and so cannot be imported here.

/** One line of text: a reason or an obligation text may span lines, a protocol line may not. */
export const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " | ").trim()

export interface Reopen {
  readonly id: string
  readonly reason: string
}

const section = (title: string, lines: ReadonlyArray<string>) => (lines.length === 0 ? [] : ["", `## ${title}`, ...lines])

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
 * reopened obligation (attempt 2 on), then the task, its obligations, the scenarios it completes and the rules.
 */
export const builderMessage = (input: {
  readonly first: boolean
  readonly attempt: number
  readonly reopen: ReadonlyArray<Reopen>
  readonly task: BlendModel.Task
  readonly spec: BlendModel.Spec
  /** Whether a task or `outside` id is trusted when the attempt starts. */
  readonly trusted: (id: string) => boolean
}) => {
  const { task, spec } = input
  const obligations = spec.obligations.filter((obligation) => obligation.task === task.id)
  // The scenarios this task completes: it supports them and every other task they need is trusted. Their `[S<n>]`
  // tests are this builder's to write; a scenario is proved only by its tests.
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
      scenarios.flatMap((scenario) => [
        `- ${scenario.id}: ${oneLine(scenario.title)}`,
        ...scenario.steps.map((step) => `  ${oneLine(step)}`),
      ]),
    ),
    ...rules(task, spec),
  ].join("\n")
}

/** Resumes a builder turn that a stall or a crash cut: no attempt line, so the attempt goes on. */
export const continueMessage =
  "Continue the task from where you stopped. When it is done, call task_ready once and end your turn."

/** Sent when a builder turn ended without `task_ready`; no attempt line. */
export const nudgeMessage = "Call task_ready when the task is done."

export interface Judge {
  readonly role: "verifier" | "reviewer"
  readonly kind: "task" | "scenario"
  readonly unit: string
  readonly judge: ReadonlyArray<{ readonly id: string; readonly text: string }>
  readonly about: ReadonlyArray<string>
}

/** A verifier, reviewer or scenario judge round: the marker, one `judge` line per id, then the instructions. */
export const judgeMessage = (input: Judge) =>
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

/** Asks the same judge once more for the ids it gave no verdict: their `judge` lines only, no marker. */
export const judgeMissingMessage = (judge: Judge["judge"]) =>
  [
    ...judge.map((item) => `judge ${item.id}: ${oneLine(item.text)}`),
    "",
    "You gave no verdict for the ids above. Call `verdict` once with one entry for each of them, then stop.",
  ].join("\n")

// --- the hidden agents ---------------------------------------------------------------------------------------------

export const builderPrompt = [
  "You are the builder of one task in a blend task tree. The task harness runs you; no human reads your replies.",
  "",
  "- Implement exactly the task in your message, in the current directory. Do nothing the task does not ask for.",
  "- Change only the files the task lists, plus test files.",
  "- Title every test with the obligation id it proves, in brackets: `[T1.1.c1] ...`.",
  "- Run the tests and the gates the task names, and fix what fails.",
  "- When the work is done, call `task_ready` once, then stop. The harness then runs the proofs.",
  "- When a later message reopens obligations (`reopen <id>: <reason>`), fix those, run the tests again, call `task_ready` and stop.",
].join("\n")

export const verifierPrompt = [
  "You are an independent verifier for the task harness. You never change code; no human reads your replies.",
  "",
  "- Inspect the code and the tests in the current directory, and run `bun test`.",
  "- Judge every `judge <id>` line of your message: `trusted` when the code and its tests truly prove the obligation, `rejected` with a short reason when they do not.",
  "- Call `verdict` once with all of your verdicts, then stop.",
].join("\n")

export const notePrompt = "You acknowledge notes of the task harness. Reply with one short line and use no tool."

type Action = "allow" | "deny"

// Deny by default, then allow the role's tools: every allowed tool's definition rides on every request, and the
// other role's harness tool must not appear at all. `invalid` answers a call to a tool the agent does not have, so a
// builder's `verdict` call fails there. opencode's own doom-loop check would end a repeated call with an error; the
// harness stops repetition itself (`tool.execute.before`), so `doom_loop` is allowed.
const role = (allowed: ReadonlyArray<string>): Record<string, Action> =>
  Object.fromEntries([["*", "deny"], ...allowed.map((tool): [string, Action] => [tool, "allow"])])

export const builderPermission = role([
  "read",
  "glob",
  "grep",
  "list",
  "edit",
  "write",
  "apply_patch",
  "bash",
  "invalid",
  "external_directory",
  "task_ready",
  "doom_loop",
])

export const verifierPermission = role([
  "read",
  "glob",
  "grep",
  "list",
  "bash",
  "invalid",
  "external_directory",
  "verdict",
  "doom_loop",
])

export const notePermission = role([])

/** A permission config as the session rules `session.create` takes: one rule per tool, `*` pattern. */
export const ruleset = (permission: Record<string, Action>) =>
  Object.entries(permission).map(([tool, action]) => ({ permission: tool, pattern: "*", action }))

export * as HarnessMessages from "./messages"
