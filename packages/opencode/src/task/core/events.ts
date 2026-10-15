import { Effect, Option, Result, Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import type { Database } from "@opencode-ai/core/database/database"
import { Event } from "@opencode-ai/schema/event"
import type { Engine, RunSnapshot } from "@/task/engine-xstate"
import type { Fact, Plan } from "./model"

// The durable store of the task harness. Every fact of a run is one EventV2 event on the run's own aggregate,
// `task_<16 hex>`, never on a session aggregate: a session's event stream must not carry harness facts. The
// `outside` preconditions that `/task trust` records live on a second aggregate per directory, `taskdir_<16 hex>`,
// because they may be recorded before any run exists.

const Text = Schema.String
const At = Schema.Number
const Reason = Schema.optional(Schema.String)

const Verdict = Schema.Struct({
  id: Text,
  verdict: Schema.Literals(["trusted", "rejected"]),
  reason: Reason,
}).annotate({ identifier: "TaskCore.Verdict" })

const Result_ = Schema.Struct({
  id: Text,
  status: Schema.Literals(["passed", "failed", "needs-judge"]),
  reason: Reason,
}).annotate({ identifier: "TaskCore.Result" })

const TaskFact = <T extends string>(type: T) => ({ type: Schema.Literal(type), at: At, task: Text })

/** The JSON form of a `Fact` (`./model`). The decoder is the validation boundary of the stored facts. */
export const FactSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("run.started"),
    at: At,
    base: Schema.optionalKey(Text),
    // The /task argument of the slice (AD-6); a slice stored before it was recorded is a whole-spec slice.
    path: Schema.optionalKey(Text),
  }),
  Schema.Struct({
    type: Schema.Literal("run.resumed"),
    at: At,
    base: Schema.optionalKey(Text),
    // The /task argument of the slice (AD-6); a slice stored before it was recorded is a whole-spec slice.
    path: Schema.optionalKey(Text),
  }),
  Schema.Struct({ type: Schema.Literal("outside.trusted"), at: At, id: Text }),
  Schema.Struct({ ...TaskFact("task.started"), worktree: Text, branch: Text, base: Text, session: Text }),
  Schema.Struct({ ...TaskFact("task.ready"), head: Text }),
  Schema.Struct({ ...TaskFact("task.proved"), results: Schema.Array(Result_), reason: Reason }),
  Schema.Struct({ ...TaskFact("task.verified"), verdicts: Schema.Array(Verdict) }),
  Schema.Struct({ ...TaskFact("task.stalled"), reason: Text }),
  Schema.Struct({ ...TaskFact("task.nudged"), nudge: Schema.Literals([1, 2]), reason: Text }),
  Schema.Struct({ ...TaskFact("task.repeated"), reason: Text }),
  Schema.Struct({ ...TaskFact("task.needs_human"), reason: Text }),
  Schema.Struct({ ...TaskFact("task.failed"), reason: Text }),
  Schema.Struct({
    type: Schema.Literal("spec.checked"),
    at: At,
    failures: Schema.Array(Schema.Struct({ rule: Text, path: Text, message: Text })),
  }),
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
]).annotate({ identifier: "TaskCore.Fact" })

// Both directions must hold, so the stored form and the engine's type cannot drift apart.
const asFact = (fact: typeof FactSchema.Type): Fact => fact
const asStored = (fact: Fact): typeof FactSchema.Type => fact

/** One recorded fact. `runID` names the aggregate: a run (`task_…`) or a directory (`taskdir_…`). */
export const FactEvent = EventV2.define({
  type: "task.harness.fact",
  durable: { version: 1, aggregate: "runID" },
  schema: { runID: Schema.String, fact: FactSchema },
})

// A duplicate definition is a defect in this module, so it fails module load.
const manifest = {
  definitions: Result.getOrThrow(Event.durable([FactEvent])),
  schema: FactEvent,
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

/** The aggregate of the run of one spec folder in one directory. */
export const runID = (directory: string, specPath: string) => `task_${sha256(`${directory}\n${specPath}`).slice(0, 16)}`

/** The aggregate of the `outside` preconditions recorded in one directory. */
export const directoryID = (directory: string) => `taskdir_${sha256(directory).slice(0, 16)}`

export const publish = Effect.fn("TaskCore.publish")(function* (
  events: EventV2.Interface,
  aggregateID: string,
  fact: Fact,
) {
  yield* events.publish(FactEvent, { runID: aggregateID, fact: asStored(fact) })
})

const PAGE = 500

/** Every fact of an aggregate, oldest first. */
export const read = Effect.fn("TaskCore.read")(function* (db: Database.Interface["db"], aggregateID: string) {
  const fromSeq = (after: number, done: ReadonlyArray<Fact>): Effect.Effect<ReadonlyArray<Fact>> =>
    Effect.gen(function* () {
      const page = yield* EventV2.readAggregate(db, { aggregateID, after, limit: PAGE, manifest })
      const facts = [...done, ...page.events.map((event) => asFact(event.data.fact))]
      const last = Option.fromNullishOr(page.events.at(-1)?.durable?.seq)
      if (!page.hasMore || Option.isNone(last)) return facts
      return yield* fromSeq(last.value, facts)
    })
  return yield* fromSeq(-1, [])
})

/** The facts of the latest run: from its `run.started` on. None when no run ever started. */
export const latestRun = (facts: ReadonlyArray<Fact>): Option.Option<ReadonlyArray<Fact>> => {
  const start = facts.findLastIndex((fact) => fact.type === "run.started")
  return start < 0 ? Option.none() : Option.some(facts.slice(start))
}

/** Every stored slice, oldest first: each from its `run.started` up to the next. */
export const slices = (facts: ReadonlyArray<Fact>): ReadonlyArray<ReadonlyArray<Fact>> =>
  facts.flatMap((fact, index) => {
    if (fact.type !== "run.started") return []
    const next = facts.findIndex((other, at) => at > index && other.type === "run.started")
    return [facts.slice(index, next < 0 ? facts.length : next)]
  })

/** The `outside` ids that the facts record as trusted. */
export const trustedOutside = (facts: ReadonlyArray<Fact>): ReadonlyArray<string> =>
  facts.flatMap((fact) => (fact.type === "outside.trusted" ? [fact.id] : []))

/** The snapshot of a run: its facts folded over the engine's first snapshot. */
export const fold = (engine: Engine, plan: Plan, facts: ReadonlyArray<Fact>): RunSnapshot =>
  facts.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), engine.initial(plan))

export * as TaskEvents from "./events"
