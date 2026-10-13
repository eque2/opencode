import { Effect, FileSystem, Option, Path, Schema } from "effect"
import type { Fact, Plan, State } from "@/task/core/model"
import { TaskEngineTable } from "@/task/engine-table"

// O3's store: one append-only JSONL file per directory, `<directory>/.opencode/task/events.jsonl`. Each line is
// one fact and the spec folder it belongs to; the spec is "" for a directory fact, the `outside` id that
// `/task trust` records, which may come before any run. A run's state is the fold of its facts, from its latest
// `run.started` on, through O1's transition table (`@/task/engine-table`). A line that does not decode (a write
// that a crash cut short) is skipped.

const Text = Schema.String
const At = Schema.Number
const Reason = Schema.optional(Schema.String)

const Verdict = Schema.Struct({
  id: Text,
  verdict: Schema.Literals(["trusted", "rejected"]),
  reason: Reason,
}).annotate({ identifier: "TaskHarnessPlugin.Verdict" })

const Proved = Schema.Struct({
  id: Text,
  status: Schema.Literals(["passed", "failed", "needs-judge"]),
  reason: Reason,
}).annotate({ identifier: "TaskHarnessPlugin.Result" })

const TaskFact = <T extends string>(type: T) => ({ type: Schema.Literal(type), at: At, task: Text })

/** The JSON form of a `Fact` (`@/task/core/model`); its decoder is the validation boundary of the log. */
export const FactSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("run.started"), at: At }),
  Schema.Struct({ type: Schema.Literal("run.resumed"), at: At }),
  Schema.Struct({ type: Schema.Literal("outside.trusted"), at: At, id: Text }),
  Schema.Struct({ ...TaskFact("task.started"), worktree: Text, branch: Text, base: Text, session: Text }),
  Schema.Struct({ ...TaskFact("task.ready"), head: Text }),
  Schema.Struct({ ...TaskFact("task.proved"), results: Schema.Array(Proved), reason: Reason }),
  Schema.Struct({ ...TaskFact("task.verified"), verdicts: Schema.Array(Verdict) }),
  Schema.Struct({ ...TaskFact("task.stalled"), reason: Text }),
  Schema.Struct({ ...TaskFact("task.repeated"), reason: Text }),
  Schema.Struct({ ...TaskFact("task.needs_human"), reason: Text }),
  Schema.Struct({ ...TaskFact("task.failed"), reason: Text }),
  Schema.Struct({ type: Schema.Literal("obligation.stale"), at: At, id: Text, hash: Text }),
  Schema.Struct({
    type: Schema.Literal("scenario.proved"),
    at: At,
    id: Text,
    status: Schema.Literals(["passed", "failed"]),
    reason: Reason,
  }),
  Schema.Struct({ type: Schema.Literal("scenario.verified"), at: At, verdict: Verdict }),
  Schema.Struct({ type: Schema.Literal("run.cancelled"), at: At, reason: Text }),
  Schema.Struct({ type: Schema.Literal("run.ended"), at: At, state: Schema.Literals(["done", "failed"]), reason: Reason }),
]).annotate({ identifier: "TaskHarnessPlugin.Fact" })

// Both directions must hold, so the stored form and the engine's type cannot drift apart.
const asFact = (fact: typeof FactSchema.Type): Fact => fact
const asStored = (fact: Fact): typeof FactSchema.Type => fact

const Line = Schema.Struct({ spec: Text, fact: FactSchema }).annotate({ identifier: "TaskHarnessPlugin.Line" })

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line))
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Line))

/** One line of the log. */
export interface Entry {
  readonly spec: string
  readonly fact: Fact
}

/** The spec of a directory fact. */
export const DIRECTORY = ""

/** `<directory>/.opencode/task/events.jsonl`. */
export const file = (path: Path.Path, directory: string) => path.join(directory, ".opencode", "task", "events.jsonl")

/** One line of JSON for an entry, newline included. */
export const encode = (entry: Entry) => `${encodeLine({ spec: entry.spec, fact: asStored(entry.fact) })}\n`

/** The entries of a log text, oldest first; a line that does not decode is skipped. */
export const parse = (text: string): ReadonlyArray<Entry> =>
  text.split("\n").flatMap((line) =>
    Option.toArray(
      Option.map(decodeLine(line), (decoded): Entry => ({ spec: decoded.spec, fact: asFact(decoded.fact) })),
    ),
  )

/** Every entry of the directory's log; none when it does not exist yet. */
export const read = Effect.fn("HarnessLog.read")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* fs.readFileString(file(path, directory)).pipe(Effect.orElseSucceed(() => ""))
  return parse(text)
})

/** Appends one entry. A plain append: a crash can cut only the last line, which `parse` then skips. */
export const append = Effect.fn("HarnessLog.append")(function* (directory: string, entry: Entry) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = file(path, directory)
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  yield* fs.writeFileString(target, encode(entry), { flag: "a" })
})

/** The facts of the latest run of a spec folder: from its `run.started` on. None when no run ever started. */
export const latestRun = (entries: ReadonlyArray<Entry>, spec: string): Option.Option<ReadonlyArray<Fact>> => {
  const facts = entries.filter((entry) => entry.spec === spec).map((entry) => entry.fact)
  const start = facts.findLastIndex((fact) => fact.type === "run.started")
  return start < 0 ? Option.none() : Option.some(facts.slice(start))
}

/** The `outside` ids that facts record as trusted. */
export const trustedOutside = (facts: ReadonlyArray<Fact>): ReadonlyArray<string> =>
  facts.flatMap((fact) => (fact.type === "outside.trusted" ? [fact.id] : []))

/** The `outside` ids that `/task trust` recorded in the directory. */
export const directoryTrust = (entries: ReadonlyArray<Entry>) =>
  trustedOutside(entries.filter((entry) => entry.spec === DIRECTORY).map((entry) => entry.fact))

/** A run's state: its facts folded over the first state of the plan. */
export const fold = (plan: Plan, facts: ReadonlyArray<Fact>): State =>
  facts.reduce((state, fact) => TaskEngineTable.apply(plan, state, fact), TaskEngineTable.initial(plan))

export * as HarnessLog from "./log"
