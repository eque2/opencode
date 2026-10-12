import type { BlendSchema } from "./schema"

// The parse target of `task-formats/blend/README.md` ("The parse target"). Every harness option reads a spec
// through these types, so the parse cannot differ between them. A field marked "derived" is computed by the
// loader and is never hashed.

export type TaskId = string // "T2", "T2.1"
export type ScenarioId = string // "S25"
export type GateId = string // "BUILD-2"
export type RefId = string // "POA-D3", "POA-A3.b"
export type Judge = BlendSchema.Judge
export type ProofKind = "test" | "gate" | "unchanged" | "review"
export type Category = BlendSchema.Category
export type Budgets = BlendSchema.Budgets
export type Policy = BlendSchema.Policy

export interface Spec {
  id: string
  title: string
  policy: Policy // SPEC.md `policy`, as written
  gates: Record<GateId, { title: string; command: string; requires?: string }>
  refs: Record<RefId, string>
  outside: Record<TaskId, string> // preconditions: checked in the state store (R12)
  tasks: Task[] // depth first, children in id order
  obligations: Obligation[] // task order, then ensures, preserves, forbids
  scenarios: Scenario[] // id order
}

export interface Task {
  id: TaskId
  slug: string
  title: string
  parent?: TaskId
  children: TaskId[] // derived: child folders
  after: TaskId[]
  goal: string
  approach?: string
  touches: { path: string; change: "new" | "update" | "delete"; what: string }[]
  refs: RefId[]
  notHere: { what: string; owner: TaskId }[]
  gates: GateId[]
  hint?: string
  policyOverride?: { judges?: Partial<Record<ProofKind, Judge[]>>; budgets?: Partial<Budgets> }
  policy: Policy // derived: spec policy with the override applied
  afterEffective: TaskId[] // derived: own `after` + every ancestor's
  supports: ScenarioId[] // derived: scenarios whose `needs` name this task
  hash: string
}

export type Proof =
  | { kind: "test"; tag: string }
  | { kind: "gate"; gate: GateId }
  | { kind: "unchanged"; path: string }
  | { kind: "review" }

export interface Obligation {
  id: string // qualified: "T2.2.c6"
  task: TaskId
  kind: "ensures" | "preserves" | "forbids"
  category?: Category // leaf ensures only
  text: string
  covers: string[] // scenario ids and ref ids
  proof: Proof
  judges: Judge[] // derived: task.policy.judges[proof.kind]
  rejects?: string[]
  hash: string
}

export interface Scenario {
  id: ScenarioId
  title: string
  tags: string[]
  steps: string[]
  category: string
  needs: TaskId[]
  environment?: { kind: "local" | "deployed"; setup?: string } // absent means local
  hash: string
}

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11" | "R12" | "R13"

// One broken rule. `path` is relative to the `.spec` folder; "." is the folder itself.
export interface Failure {
  rule: RuleId
  path: string
  message: string
}

// `spec` is present only when no rule fails: no work starts while a rule fails. `notes` carries the R12 note,
// because R12 is checked at run time against the state store, not here.
export interface LoadResult {
  spec?: Spec
  failures: Failure[]
  notes: string[]
}

export * as BlendModel from "./model"
