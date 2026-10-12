import { Schema } from "effect"

// The front-matter contracts of the blend format, one schema for each file kind. They mirror
// `task-formats/blend/schema/*.schema.json` (draft 2020-12) one for one. Decode them with `parseOptions`:
// `onExcessProperty: "error"` is the JSON Schemas' `additionalProperties: false`, and a record whose key schema
// carries a pattern is their `propertyNames`. `reportInput` puts the rejected value in each message.

export const parseOptions = { errors: "all", onExcessProperty: "error", reportInput: true } as const

const Text = Schema.String.check(Schema.isMinLength(1))

export const TaskId = Schema.String.check(Schema.isPattern(/^T[1-9][0-9]*(\.[1-9][0-9]*)*$/))
export const GateId = Schema.String.check(Schema.isPattern(/^BUILD-[1-9][0-9]*$/))
export const RefId = Schema.String.check(Schema.isPattern(/^[A-Z]+-[A-Z]*[0-9]+(\.[a-z0-9]+)?$/))
const ScenarioOrRefId = Schema.String.check(Schema.isPattern(/^(S[1-9][0-9]*|[A-Z]+-[A-Z]*[0-9]+(\.[a-z0-9]+)?)$/))
const EnsuresKey = Schema.String.check(Schema.isPattern(/^[ce][1-9][0-9]*$/))
const ObligationKey = Schema.String.check(Schema.isPattern(/^[cepf][1-9][0-9]*$/))

// A repository-relative path: no leading slash and no `..` segment.
const RepoPath = Schema.String.check(Schema.isPattern(/^(?!\/)(?!(.*\/)?\.\.(\/|$)).+$/))

export const Judge = Schema.Literals(["runner", "verifier", "reviewer", "engine", "human"])
const Judges = Schema.Array(Judge).check(Schema.isMinLength(1), Schema.isUnique())

export const Category = Schema.Literals([
  "happy-path",
  "empty",
  "boundary",
  "invalid-input",
  "failure",
  "concurrency",
  "security",
  "compatibility",
  "regression",
  "money",
])

export const Evidence = Schema.Literals(["exit-code", "counts", "run-id", "commit", "signed-reporter"])

const TaskAttempts = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Retries = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const Budgets = Schema.Struct({
  taskAttempts: TaskAttempts,
  retries: Retries,
}).annotate({ description: "Retry limits before the engine stops and reports" })

export const PolicyJudges = Schema.Struct({
  test: Judges,
  gate: Judges,
  unchanged: Judges,
  review: Judges,
}).annotate({ description: "Who judges each proof kind" })

export const Policy = Schema.Struct({
  redFirst: Schema.Boolean,
  proofBinding: Schema.Literal("title-tag"),
  structural: Schema.Literal("touches-plus-tests"),
  review: Schema.Literal("parent-diff"),
  trust: Schema.Literal("independent-verifier"),
  acceptance: Schema.Literal("after-all-needs-trusted"),
  evidence: Schema.Array(Evidence).check(Schema.isMinLength(1), Schema.isUnique()),
  budgets: Budgets,
  judges: PolicyJudges,
}).annotate({ description: "The verification policy every task in the spec inherits" })

export const Gate = Schema.Struct({
  title: Text,
  command: Text,
  requires: Schema.optionalKey(Text),
}).annotate({ description: "A build check whose command exits 0 to pass" })

// `SPEC.md`: the format version, the policy every task inherits, the gates, the refs and the `outside` tasks.
export const SpecFrontMatter = Schema.Struct({
  format: Schema.Literal("task-spec/1"),
  policy: Policy,
  gates: Schema.Record(GateId, Gate),
  refs: Schema.Record(RefId, Text),
  outside: Schema.optionalKey(Schema.Record(TaskId, Text)),
}).annotate({ description: "SPEC.md front matter" })

export const Touch = Schema.Struct({
  path: RepoPath,
  change: Schema.Literals(["new", "update", "delete"]),
  what: Text,
}).annotate({ description: "A file the task changes, the kind of change and what changes" })

export const NotHere = Schema.Struct({
  what: Text,
  owner: TaskId,
}).annotate({ description: "Work that looks like this task's but another task owns" })

// `TASK.md`: the order, the complete touch set, the refs and the work another task owns.
export const TaskFrontMatter = Schema.Struct({
  after: Schema.optionalKey(Schema.Array(TaskId).check(Schema.isUnique())),
  touches: Schema.optionalKey(Schema.Array(Touch).check(Schema.isMinLength(1))),
  refs: Schema.optionalKey(Schema.Array(RefId).check(Schema.isUnique())),
  notHere: Schema.optionalKey(Schema.Array(NotHere).check(Schema.isMinLength(1))),
}).annotate({ description: "TASK.md front matter" })

// `test`, `review`, `{test: <ensures key>}`, `{gate: <gate id>}` or `{unchanged: <path>}`. The exact structs keep
// the members disjoint, as the JSON Schema's `oneOf` requires.
export const Proof = Schema.Union([
  Schema.Literals(["test", "review"]),
  Schema.Struct({ test: EnsuresKey }),
  Schema.Struct({ gate: GateId }),
  Schema.Struct({ unchanged: RepoPath }),
])

export const Ensures = Schema.Struct({
  category: Schema.optionalKey(Category),
  text: Text,
  covers: Schema.optionalKey(Schema.Array(ScenarioOrRefId).check(Schema.isMinLength(1), Schema.isUnique())),
  proof: Schema.optionalKey(Proof),
}).annotate({ description: "What must be true when the work is done" })

export const Rule = Schema.Struct({
  text: Text,
  proof: Proof,
}).annotate({ description: "A preserves or forbids rule and its proof" })

export const PolicyOverride = Schema.Struct({
  judges: Schema.optionalKey(
    Schema.Struct({
      test: Schema.optionalKey(Judges),
      gate: Schema.optionalKey(Judges),
      unchanged: Schema.optionalKey(Judges),
      review: Schema.optionalKey(Judges),
    }).check(Schema.isMinProperties(1)),
  ),
  budgets: Schema.optionalKey(
    Schema.Struct({
      taskAttempts: Schema.optionalKey(TaskAttempts),
      retries: Schema.optionalKey(Retries),
    }).check(Schema.isMinProperties(1)),
  ),
})
  .check(Schema.isMinProperties(1))
  .annotate({ description: "The task's tightening of the spec policy (R13)" })

// `VERIFY.md`: the obligations (`ensures`, `preserves`, `forbids`), the gates, the rejected proofs and the task's
// tightening of the spec policy.
export const VerifyFrontMatter = Schema.Struct({
  gates: Schema.optionalKey(Schema.Array(GateId).check(Schema.isUnique())),
  hint: Schema.optionalKey(Text),
  ensures: Schema.optionalKey(Schema.Record(EnsuresKey, Ensures).check(Schema.isMinProperties(1))),
  preserves: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.isPattern(/^p[1-9][0-9]*$/)), Rule).check(Schema.isMinProperties(1)),
  ),
  forbids: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.isPattern(/^f[1-9][0-9]*$/)), Rule).check(Schema.isMinProperties(1)),
  ),
  rejects: Schema.optionalKey(
    Schema.Record(ObligationKey, Schema.Array(Text).check(Schema.isMinLength(1), Schema.isUnique())).check(
      Schema.isMinProperties(1),
    ),
  ),
  policy: Schema.optionalKey(PolicyOverride),
}).annotate({ description: "VERIFY.md front matter" })

export const Environment = Schema.Struct({
  kind: Schema.Literals(["local", "deployed"]),
  setup: Schema.optionalKey(Text),
}).annotate({ description: "Where the scenario can be judged" })

// `acceptance/S<n>.md`: the tasks the scenario needs, its group and where it can be judged.
export const ScenarioFrontMatter = Schema.Struct({
  needs: Schema.Array(TaskId).check(Schema.isMinLength(1), Schema.isUnique()),
  category: Text,
  environment: Schema.optionalKey(Environment),
}).annotate({ description: "acceptance/S<n>.md front matter" })

export type Judge = typeof Judge.Type
export type Category = typeof Category.Type
export type Budgets = typeof Budgets.Type
export type Policy = typeof Policy.Type
export type Gate = typeof Gate.Type
export type Touch = typeof Touch.Type
export type NotHere = typeof NotHere.Type
export type Proof = typeof Proof.Type
export type Ensures = typeof Ensures.Type
export type Rule = typeof Rule.Type
export type PolicyOverride = typeof PolicyOverride.Type
export type Environment = typeof Environment.Type
export type SpecFrontMatter = typeof SpecFrontMatter.Type
export type TaskFrontMatter = typeof TaskFrontMatter.Type
export type VerifyFrontMatter = typeof VerifyFrontMatter.Type
export type ScenarioFrontMatter = typeof ScenarioFrontMatter.Type

export * as BlendSchema from "./schema"
