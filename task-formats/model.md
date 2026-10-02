# The engine's view — one model, six surfaces

Every format in this folder parses into the same model. The formats differ in where each field is written,
not in what exists. This is the TypeScript shape the engine reads; the state it writes is a separate shape,
kept out of the files.

## The definition (read from the markdown, never written by the engine)

```ts
/** A stable, human-written id: "T2", "T2.1", "T2.1.c4", "T2.1.p1", "S25", "BUILD-2", "POA-D3". */
type Id = string

interface Spec {
  id: string                         // "provider-ordering-admin"
  title: string
  policy: VerificationPolicy         // defaults every task inherits
  refs: Record<Id, string>           // decisions, findings, assumptions, standards — one statement each
  gates: Gate[]
  scenarios: Scenario[]
  tasks: Task[]                      // parents and leaves; the tree comes from `parent`
}

interface Task {
  id: Id
  title: string                      // imperative: "Add the dry-run mode to the gateway"
  parent?: Id
  after: Id[]                        // tasks that must be trusted before this one starts
  goal: string                       // why: one outcome sentence
  approach?: string                  // guidance for the builder; never judged
  touches: Touch[]                   // the complete touch set — the engine enforces it and uses it for parallelism
  preserve: Rule[]                   // what must still be true
  mustNot: Rule[]                    // what this task must not do — scoped to this task only
  notHere: { what: string; owner: Id }[]   // work a sibling owns
  refs: Id[]
  verify?: Verification              // leaves only; a parent is verified by its children plus a review
}

interface Touch {
  path: string
  change: 'new' | 'update' | 'delete'
  what: string
}

interface Rule {
  id?: Id                            // "T2.1.p1" — format 5 numbers every rule
  text: string
  proof: Proof
}

interface Verification {
  cases: Case[]                      // task-local proof obligations
  supports: Id[]                     // scenarios — shared, many-to-many
  gates: Id[]                        // build checks — global commands
  rejects: string[]                  // weak proofs the verifier refuses for this task
  hint?: string                      // where the tests probably live; never the binding
}

interface Case {
  id: Id                             // "c4", qualified as "T2.1.c4"
  category: Category
  text: string
  covers: Id[]                       // scenarios or refs this case also speaks to
}

type Category =
  | 'happy-path' | 'empty' | 'boundary' | 'invalid-input' | 'failure'
  | 'concurrency' | 'security' | 'compatibility' | 'regression' | 'money'

type Proof =
  | { kind: 'test'; tag: Id }        // a passing test whose title starts with `[tag]`
  | { kind: 'gate'; gate: Id }       // the gate's command exits 0
  | { kind: 'diff'; unchanged: string } // the path is not changed by this task's commits
  | { kind: 'review' }               // the parent's independent review

type Judge = 'runner' | 'verifier' | 'reviewer' | 'engine' | 'human'

interface Scenario {
  id: Id
  title: string
  tags: string[]                     // "@core", "@ASSUMPTION:A3.b" — quoted in YAML, `@` is reserved
  category: string                   // "Data Integrity & Consistency"
  steps: string[]                    // Gherkin, verbatim
  needs?: Id[]                       // format 4 declares the edge here instead of on the task
  environment?: string               // S51: a deployed service
}

interface Gate {
  id: Id
  title: string
  command: string                    // executable — never prose like "Type check passes"
  requires?: string                  // "Node 22"
}

interface VerificationPolicy {
  redFirst: boolean
  proofBinding: 'title-tag'
  structural: string
  review: 'parent-diff'
  trust: 'independent-verifier'
  acceptance: 'after-all-supporters-trusted'
  evidence: string
  budgets: { taskAttempts: number; retries: number }
}
```

## The state (written by the engine, never in the markdown)

```ts
/** Keyed by id AND by the content hash of the definition it was produced against. */
interface Keyed { id: Id; specHash: string }

interface TaskState extends Keyed {
  status: 'not-started' | 'building' | 'built' | 'failed'
  attempt: number
  commits: string[]
  trust: 'untrusted' | 'verified' | 'trusted' | 'rejected' | 'suspect'
}

interface ProofState extends Keyed {          // one per case, rule, scenario or gate
  runId: string
  commit: string
  passed: boolean
  counts?: { pass: number; fail: number; skip: number }
  evidence?: string                           // signed reporter evidence, by reference
}

interface Verdict extends Keyed {
  judge: Judge
  outcome: 'trusted' | 'rejected'
  reason: string                              // per case or per step
  at: string
}
```

An edit to a task file changes its `specHash`, so every state record and verdict produced against the old
version stops counting. The engine can then re-verify only what the edit touched.

## Where each field lives

| Field | 1 one file | 2 pairs | 3 folders | 4 acceptance first | 5 contracts | 6 literate |
| --- | --- | --- | --- | --- | --- | --- |
| id, title | `## T2.1 — title` | front matter | folder name + `TASK.md` front matter | `work/` front matter | front matter | `task T2.1` info string + `title:` |
| parent | heading nesting | `parent:` | folder nesting | `parent:` | `part-of:` | `parts:` on the parent block |
| after | `**After:**` label | `after:` | `after:` | `after:` | `after:` + `## Requires` | `after:` |
| touches | `**Touches:**` list | front matter + `## Change detail` | same as 2 | same as 2 | `## Changes` | `touches:` |
| goal | `### Goal` | `## Goal` | `## Goal` | `## Goal` | `> **Goal.**` | first paragraph under `### T2.1` |
| approach | `### Approach` | `## Approach` | `## Approach` | `## Approach` | `## Approach` (not judged) | prose under `### T2.1` |
| preserve | `### Preserve` | `## Preserve` | `## Preserve` | `## Preserve` | `## Preserves` (`T2.1.p1`) | `preserve:` |
| must not | `### Must not` | `## Must not` | `## Must not` | `## Must not` | `## Forbids` (`T2.1.f1`) | `must-not:` |
| not here | `### Not in this task` | `## Not in this task` | same | same | `## Not in this contract` | `not-here:` |
| cases | `### Verify` list | `*.verify.md` `## Cases` | `VERIFY.md` `## Cases` | `## Unit cases` | `## Ensures` | `cases:` in `verify T2.1` |
| supports | `**Supports:**` label | verify front matter | `VERIFY.md` front matter | outcome `needs:` (inverted) | `## Contributes to` | `supports:` |
| gates | `**Gates:**` label | verify front matter | `VERIFY.md` front matter | work front matter | `## Contributes to` | `gates:` |
| rejects | "The verifier rejects" | `## Weak proofs to reject` | same | same | `## Rejected proofs` | `rejects:` |
| scenarios | `## Acceptance` blocks | `acceptance.md` | `acceptance/S25.md` | `outcomes/S25.md` | `acceptance.contract.md` | `gherkin S25` blocks |
| policy | `## Verification policy` | `verification-policy.md` | `SPEC.md` | `policy.md` | `policy.md` | `policy` block |
| refs | `## References` | `refs.md` | `SPEC.md` | `refs.md` | `refs.md` | `refs` block |
| gates (commands) | `## Gates` table | `gates.md` | `SPEC.md` | `gates.md` | `gates.md` | `gate BUILD-2` blocks |
