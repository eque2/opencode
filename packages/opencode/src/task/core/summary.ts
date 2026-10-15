import { Array as Arr, Option } from "effect"
import { Locale } from "@/util/locale"
import type { Plan } from "./model"
import type { Status } from "./status"

// The closing summary (D18, AD-18): one assistant-role markdown message at the end of the run, built from the run's
// status (`project(plan, snapshot)`), the stop the run took, whether the spec stopped validating, and the summed usage
// of the run's sessions. It decides nothing: every class is a tag of the status, and a state is only shown, as its
// label. The glyphs come from the tags too, so no table is keyed by state names here (AD-17).

/** A stop the run took: `run.cancelled`, or the state of `run.ended`, with its reason (AD-4). */
export interface Stop {
  readonly state: string
  readonly reason?: string
}

/** The summed tokens (input, output and reasoning; cache reads and writes are not counted) and cost (D24). */
export interface Usage {
  readonly tokens: number
  readonly cost: number
}

/** The run's usage from the run's sessions: the child sessions of the root (AD-18). */
export const usage = (
  sessions: ReadonlyArray<{
    readonly tokens?: { readonly input: number; readonly output: number; readonly reasoning: number }
    readonly cost?: number
  }>,
): Usage => ({
  tokens: sessions.reduce(
    (sum, session) =>
      sum + (session.tokens ? session.tokens.input + session.tokens.output + session.tokens.reasoning : 0),
    0,
  ),
  cost: sessions.reduce((sum, session) => sum + (session.cost ?? 0), 0),
})

/** Model text for CommonMark: a backslash before each of \ * _ ` | < > [ ], so it renders as written (EDGE-11). */
export const escape = (text: string) => text.replace(/[\\*_`|<>[\]]/g, "\\$&")

const label = (state: string) => state.replaceAll("_", " ")
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim()
const tagged = (unit: { readonly tags: ReadonlyArray<string> }, tag: string) => unit.tags.includes(tag)
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** `45s`, `3m 12s`, `1h 4m` (EXPERIENCE "Durations"). */
export const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`
}

// Natural id order: T1.2 before T1.10.
const byId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true })

type Unit = { readonly tags: ReadonlyArray<string>; readonly state: string }

// Where a unit's count goes in the counts line: the stops that are not blocks, the blocks, the work, the waits.
const rank = (unit: Unit) =>
  tagged(unit, "stopped") && !tagged(unit, "blocked")
    ? 0
    : tagged(unit, "blocked")
      ? 1
      : tagged(unit, "active")
        ? 2
        : tagged(unit, "waiting")
          ? 3
          : 4

// " · N <label>" for each class of units other than the trusted ones, in rank order, then first appearance.
const others = (units: ReadonlyArray<Unit>, name: (unit: Unit) => string) => {
  const rest = units.filter((unit) => !(tagged(unit, "ended") && !tagged(unit, "stopped")))
  const names = Arr.dedupe(rest.toSorted((a, b) => rank(a) - rank(b)).map(name))
  return names.map((item) => ` · ${rest.filter((unit) => name(unit) === item).length} ${item}`).join("")
}

const trustedOf = (units: ReadonlyArray<Unit>) =>
  units.filter((unit) => tagged(unit, "ended") && !tagged(unit, "stopped")).length

// The glyph of a stopped task or a scenario that did not pass, from its tags.
const glyphOf = (unit: Unit, kind: "task" | "scenario") =>
  tagged(unit, "blocked") ? "⊖" : kind === "scenario" ? "✗" : tagged(unit, "dead") ? "⊘" : "–"

// Units with the same state and reason, in natural id order, grouped: dead, then blocked, then the rest.
const groups = <U extends Unit & { readonly reason?: string }>(units: ReadonlyArray<readonly [string, U]>) => {
  const keys = Arr.dedupe(units.map(([, unit]) => `${unit.state}\n${unit.reason ?? ""}`))
  return keys
    .map((key) => units.filter(([, unit]) => `${unit.state}\n${unit.reason ?? ""}` === key))
    .toSorted((a, b) => order(a[0][1]) - order(b[0][1]))
}
const order = (unit: Unit) => (tagged(unit, "dead") ? 0 : tagged(unit, "blocked") ? 1 : 2)

/**
 * The summary's markdown (EXPERIENCE "Closing summary"): the outcome line (the AC 4 order of SD-18: a dead task, a
 * stop, acceptance, done), the counts line, **Stopped**, **Scenarios that did not pass**, **Not run**, the run-warning
 * line and the **Tasks** table. A section with nothing in it is left out. Model text is escaped.
 */
export const markdown = (input: {
  readonly plan: Plan
  readonly status: Status
  readonly stop: Option.Option<Stop>
  /** Whether a spec check found failures during the run, even if a later check validated again. */
  readonly warned: boolean
  readonly usage: Usage
}) => {
  const { status } = input
  const ids = input.plan.tasks.map((task) => task.id).filter((id) => status.tasks[id] !== undefined)
  const tasks = ids.flatMap((id) => {
    const task = status.tasks[id]
    return task ? [[id, task] as const] : []
  })
  const scenarios = Object.keys(status.scenarios)
    .toSorted(byId)
    .flatMap((id) => {
      const scenario = status.scenarios[id]
      return scenario ? [[id, scenario] as const] : []
    })
  const waiting = scenarios.filter(([, scenario]) => tagged(scenario, "waiting"))
  const notRun =
    waiting.length === 0 ? "" : ` · ${waiting.length} ${waiting.length === 1 ? "scenario" : "scenarios"} not run`

  const title = `**${escape(status.run.title)}**`
  const subject = status.run.task
    ? `**${status.run.task.id} ${escape(status.run.task.title)}** from spec ${title}`
    : `Spec ${title}`
  const firstReason = (reason: string | undefined) => escape(reason?.split("\n")[0] ?? "")
  const outcome = tasks.some(([, task]) => tagged(task, "dead"))
    ? label(status.run.state)
    : Option.isSome(input.stop)
      ? `${label(status.run.state)}: ${firstReason(status.run.reason)}`
      : status.run.state === "failed"
        ? `failed: acceptance not proved${notRun}`
        : status.run.state === "done"
          ? `done${notRun}`
          : label(status.run.state)

  const units = tasks.map(([, task]) => task)
  const scenarioUnits = scenarios.map(([, scenario]) => scenario)
  const duration =
    status.run.startedAt !== undefined && status.run.endedAt !== undefined
      ? [elapsed(status.run.endedAt - status.run.startedAt)]
      : []
  const spent =
    input.usage.tokens > 0 ? [`${Locale.number(input.usage.tokens)} tokens`, money.format(input.usage.cost)] : []
  const counts = [
    `Tasks ${trustedOf(units)}/${units.length} trusted${others(units, (unit) => label(unit.state))}`,
    ...(scenarioUnits.length === 0
      ? []
      : [
          `Scenarios ${trustedOf(scenarioUnits)}/${scenarioUnits.length} trusted${others(scenarioUnits, (unit) =>
            tagged(unit, "waiting") ? "not run" : label(unit.state),
          )}`,
        ]),
    ...duration,
    ...spent,
  ].join(" · ")

  // A task's time: from its start to its end, or to the run's; none for a task that never started.
  const timeOf = (task: (typeof tasks)[number][1]) =>
    Option.map(Option.fromNullishOr(task.startedAt), (start) =>
      elapsed((task.endedAt ?? status.run.endedAt ?? start) - start),
    )
  const stopped = groups(tasks.filter(([, task]) => tagged(task, "stopped"))).map((group) => {
    const [, first] = group[0]
    const names = group.map(([id]) => `**${id}**`).join(", ")
    if (tagged(first, "blocked")) return [`- ⊖ ${names} ${escape(oneLine(first.reason ?? label(first.state)))}`]
    // One task's line names its attempts and its time; a line of several names neither.
    const alone = group.length === 1
    const time = alone
      ? Option.getOrElse(
          Option.map(timeOf(first), (value) => ` · ${value}`),
          () => "",
        )
      : ""
    const attempts =
      alone && first.attempts > 0 ? ` after ${first.attempts} ${first.attempts === 1 ? "attempt" : "attempts"}` : ""
    return [
      `- ${glyphOf(first, "task")} ${names} ${label(first.state)}${attempts}${time}`,
      ...(first.reason ? [`  ${escape(oneLine(first.reason))}`] : []),
    ]
  })
  const failed = groups(
    scenarios.filter(([, scenario]) => tagged(scenario, "stopped") && !tagged(scenario, "blocked")),
  ).map((group) => {
    const [, first] = group[0]
    const names = group.map(([id]) => `**${id}**`).join(", ")
    return [
      `- ${glyphOf(first, "scenario")} ${names} ${label(first.state)}${group.length === 1 ? ` · ${escape(first.title)}` : ""}`,
      ...(first.reason ? [`  ${escape(oneLine(first.reason))}`] : []),
    ]
  })
  const parked = waiting.map(([id, scenario]) => {
    const waits = scenario.waitingOn.map((need) =>
      scenario.waitingOnOutside.includes(need) ? `${need} (outside)` : need,
    )
    return `- ○ **${id}** ${escape(scenario.title)}${waits.length === 0 ? "" : ` — waiting on ${waits.join(", ")}`}`
  })
  const section = (name: string, lines: ReadonlyArray<string>) =>
    lines.length === 0 ? [] : [`**${name}**`, "", ...lines, ""]
  const table = [
    "| Task | State | Attempts | Time |",
    "|---|---|---|---|",
    ...tasks.map(
      ([id, task]) =>
        `| ${id} | ${label(task.state)} | ${task.attempts} | ${Option.getOrElse(timeOf(task), () => "—")} |`,
    ),
  ]
  return [
    `${subject} — ${outcome}`,
    "",
    counts,
    "",
    ...section("Stopped", stopped.flat()),
    ...section("Scenarios that did not pass", failed.flat()),
    ...section("Not run", parked),
    ...(input.warned ? ["The spec stopped validating during the run. The run kept the plan it loaded.", ""] : []),
    "**Tasks**",
    "",
    ...table,
  ].join("\n")
}

export * as TaskSummary from "./summary"
