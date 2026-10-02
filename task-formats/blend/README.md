# Blend — the engine's input format

This format joins the three ideas that the [recommendation](../README.md#recommendation) chose. Format 3 gives
the folder contract: a `.spec` folder, one `.task` folder for each task, and a `TASK.md` and a `VERIFY.md` in
each. Format 5 gives the verification: every obligation has an id, a proof and a judge, and `VERIFY.md` holds
them. Format 4 gives the edges: a scenario declares the tasks it needs, and no task lists its scenarios. The
result is the aspirational input format for a TypeScript harness engine. A machine can validate it with JSON
Schemas and a short list of numbered rules, and can parse it into the engine's model in one pass.

The example is the same T2 as in the six numbered formats: 41 files, 838 lines, 61 obligations, 26 scenarios.

## Layout

```
blend/
  README.md                                   this file: the format specification
  schema/                                     JSON Schema (draft 2020-12), one for each file kind
    spec.schema.json  task.schema.json  verify.schema.json  scenario.schema.json
  provider-ordering-admin.spec/               the spec; the folder name gives the spec id
    SPEC.md                                   policy, gates, refs, and `outside` (preconditions)
    acceptance/
      S3.md … S59.md                          one scenario each: `needs:` + one gherkin block
    T2-services.task/                         a parent task: <task id>-<slug>.task
      TASK.md                                 what to do
      VERIFY.md                               how it is judged
      T2.1-database-source.task/              a leaf task: its id is the parent id + ".<n>"
        TASK.md
        VERIFY.md
      …
      T2.6-routing-decision-record.task/
```

## Design rules

These rules make the format easy to validate and easy to parse.

| Rule | What it means |
| --- | --- |
| One parse rule for each file | Each file is YAML front matter, then a markdown body. The front matter is the machine contract. A schema validates it. |
| The body is for agents | The parser reads only the H1, the `## Goal` and `## Approach` sections of `TASK.md`, and the gherkin block of a scenario. Everything else in a body is prose for the agent. |
| Each fact once | The folder name gives the task id. The file name gives the scenario id. The H1 gives a task title, and the `Scenario:` line gives a scenario title. A scenario's `needs` gives each task's supported scenarios. The proof kind gives each obligation's judges. |
| Closed vocabularies | Ids, categories, change kinds, proofs, judges and policy values have fixed patterns or enums in the schemas. |
| Strings are quoted | Every free-text value is a double-quoted YAML string. `@`, `:` and `#` in text cannot change the parse. |
| No state | No status, no ticks, no counters. The schemas refuse any field that they do not name. |

## The file kinds

### `SPEC.md`

One for each spec. It holds what every task inherits.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `format` | `"task-spec/1"` | yes | The format version. It selects the schemas. |
| `policy` | object | yes | The verification policy. See below. |
| `gates` | map gate id → `{title, command, requires?}` | yes | Build checks. `command` is executable. |
| `refs` | map ref id → string | yes | Decisions, findings, assumptions and standards, one statement each. |
| `outside` | map task id → title | no | Tasks of this spec that the folder does not contain. Each one is a precondition (R12). |

`policy` holds `redFirst`, `proofBinding`, `structural`, `review`, `trust`, `acceptance`, `evidence`,
`budgets` and `judges`. All are required. Each value is a constant or an enum, so a spec cannot weaken the policy
by accident.

```yaml
policy:
  redFirst: true
  proofBinding: title-tag
  # …
  acceptance: after-all-needs-trusted
  budgets: {taskAttempts: 10, retries: 3}
  judges:
    test: [runner, verifier]
    unchanged: [engine]
    # …
gates:
  BUILD-2:
    title: "Type check passes"
    command: "pnpm nx run-many -t typecheck -p ui,api,media,media-mcp,contracts,db"
```

The body starts with `# <spec title>`.

### `TASK.md`

One in each `.task` folder. It tells the builder what to do.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `after` | task ids | no | Tasks that must be trusted before this one starts. Children inherit it. |
| `touches` | list of `{path, change, what}` | leaf: yes; parent: no | The complete touch set. `change` is `new`, `update` or `delete`. |
| `refs` | ref ids | no | References from `SPEC.md` that apply. |
| `notHere` | list of `{what, owner}` | no | Work that another task owns. |

```yaml
after: [T1.4]
touches:
  - path: libs/media/src/media-gateway.ts
    change: update
    what: "`GatewayRoutingContext` gains an optional dry-run field"
refs: [POA-D8]
notHere:
  - what: "the short-circuit itself — this task supplies the mode and the money guarantee"
    owner: T2.5
```

The body starts with `# <task title>`, then `## Goal` (required) and `## Approach` (optional).

### `VERIFY.md`

One in each `.task` folder. It tells the verifier how the task is judged. Each key under `ensures`,
`preserves` and `forbids` is an obligation. Its qualified id is the task id, a dot and the key: `T2.2.c6`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `gates` | gate ids | no | Gates that must pass at the task's final commit. |
| `hint` | path | no | Where the tests probably are. Never the binding. |
| `ensures` | map `c<n>` (leaf) or `e<n>` (parent) → `{category?, text, covers?, proof?}` | yes | What must be true. A leaf gives a category. `proof` defaults to `test`. |
| `preserves` | map `p<n>` → `{text, proof}` | no | What must still be true. |
| `forbids` | map `f<n>` → `{text, proof}` | no | What this task must not do. Scoped to this task. |
| `rejects` | map obligation key → list of strings | no | Weak proofs that the verifier must refuse for that obligation. A list, because the lessons of earlier rejections accumulate. |
| `policy` | `{judges?, budgets?}` | no | This task's tightening of the spec policy. It can only add judges and lower budgets (R13). |

```yaml
ensures:
  c6:
    category: concurrency
    text: "a poll that began before an Apply and completes after it does not reinstate the pre-Apply configuration — …"
    covers: [S57, POA-R2]
preserves:
  p4:
    text: "a request sees one snapshot for its lifetime"
    proof: {test: c3}
rejects:
  c6:
    - "running the poll and the Apply one after the other. The poll must begin before the Apply and complete after it, or the test cannot fail."
```

T2.4 moves money, so its tests also need a human judge:

```yaml
policy:
  judges:
    test: [runner, verifier, human]
```

A parent's `VERIFY.md` holds only its own obligations. Its children's trust is implicit:

```yaml
ensures:
  e1:
    text: "The combined T2 diff passes one independent review once the last child is trusted. …"
    proof: review
```

The body is free prose for the verifier. The parser does not read it.

### `acceptance/S<n>.md`

One for each scenario. The scenario owns its edges to the tasks.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `needs` | task ids | yes | The scenario is judged when all of these are trusted. |
| `category` | string | yes | The group in the source feature file. |
| `environment` | `{kind, setup?}` | no | Where the scenario can be judged. `kind` is `local` (the default) or `deployed`. `setup` tells the agent that prepares the run what must be in place. |

````markdown
---
needs: [T2.2, T5.3]
category: "Delivery & Environment Promotion"
environment:
  kind: deployed
  setup: "the service deployed to its hosting environment, with the configuration store selected"
---

```gherkin
@delivery
Scenario: S51 The deployed service reads its configuration from the store
  Given the service deployed to its hosting environment with the configuration store selected as its source
  …
```
````

The body is exactly one gherkin block: tag lines, one `Scenario:` line that starts with the file's id, then the
steps. The tags live in the Gherkin only.

## Proofs and judges

| In `VERIFY.md` | Parsed proof | What proves it | Judges (`policy.judges`) |
| --- | --- | --- | --- |
| `test`, or no `proof` on an ensures obligation | `{kind: 'test', tag: 'T2.2.c6'}` | A passing test whose title starts with `[T2.2.c6]` | runner, verifier |
| `{test: c3}` | `{kind: 'test', tag: 'T2.2.c3'}` | The test of another obligation in the same file | runner, verifier |
| `{gate: BUILD-2}` | `{kind: 'gate', gate: 'BUILD-2'}` | The gate's command exits 0 | runner |
| `{unchanged: <path>}` | `{kind: 'unchanged', path}` | No commit of this task changes the path | engine |
| `review` | `{kind: 'review'}` | The independent review of the parent's combined diff | reviewer |

A scenario `S25` is proved by the tests whose titles start with `[S25]`. The file never states this, because it
is always true.

A task can add judges for its own proofs with `policy.judges` in `VERIFY.md`. It can add a judge, for example
`human`, but it cannot remove one that the spec requires (R13). The obligation's judges then come from the
task's effective policy: the spec policy with the task's override applied.

## Rules

The schemas check one file at a time. These rules check the spec as a whole. The engine runs all of them before
it starts any work.

| # | Rule | What it checks |
| --- | --- | --- |
| R1 | Layout | `<slug>.spec/` holds `SPEC.md`, an optional `acceptance/` and `*.task` folders. A `*.task` folder holds exactly `TASK.md`, `VERIFY.md` and child `*.task` folders. `acceptance/` holds only `S<n>.md`. Nothing else. |
| R2 | Names | A `.task` folder is `<task id>-<slug>.task`. A top-level id is `T<n>`. A child's id is its parent's id plus `.<n>`. A scenario file is `<scenario id>.md`. |
| R3 | Front matter | Every file starts with `---`. The front matter is YAML 1.2, duplicate keys are refused, and it validates against its schema. |
| R4 | Titles and bodies | The H1 gives the title of `SPEC.md` and `TASK.md`, and `TASK.md` has `## Goal`. A scenario body is one gherkin block; its `Scenario:` line gives the title, and its id equals the file name. |
| R5 | Unique ids | Task ids (folders and `outside`), scenario ids, gate ids and ref ids never repeat. |
| R6 | References resolve | `after`, `needs` and `notHere.owner` name a task. `refs` name a ref. `gates` and gate proofs name a gate. `covers` names a scenario or a ref. `{test: k}` and `rejects` keys name an obligation in the same `VERIFY.md`. |
| R7 | Order is acyclic | The `after` graph has no cycle when each child inherits its ancestors' `after`. No task is after its own ancestor or descendant. |
| R8 | Leaf and parent | A leaf has at least one touch, and its ensures keys are `c<n>`, each with a category. A parent has no touches; its ensures keys are `e<n>`, with no category, and the proof is `review` or a gate. |
| R9 | Edges agree | A scenario's `needs` names leaf tasks or `outside` tasks. A case that covers a scenario belongs to a task that the scenario needs. |
| R10 | Scoped rules agree | A `forbids` path under `unchanged` is not in the same task's `touches`. `notHere.owner` is not the task itself. |
| R11 | No state | No body holds a checkbox. The schemas already refuse state in front matter. |
| R12 | Preconditions | An `outside` task is a precondition. Before a task whose effective `after` names one starts, the engine checks the state store. Until that task is trusted, the dependent task waits, blocked on a dependency. A scenario that needs an `outside` task waits the same way. |
| R13 | Overrides only tighten | In a task's `policy`, each judges list holds every judge that the spec requires for that proof kind. Each budget is not more than the spec's budget. |

## Parse

The parse is one pass over the folder. It gives the model below.

1. Find the `*.spec` folder. The spec id is the folder name without `.spec`.
2. Read `SPEC.md`. Split the front matter, parse it as YAML, and validate it with `spec.schema.json`. The H1
   gives the title.
3. Walk the `*.task` folders depth first. The folder name gives the id and the slug. The enclosing folder gives
   the parent. The child folders give `children`.
4. In each folder, parse and validate `TASK.md` and `VERIFY.md`. Read the H1, `## Goal` and `## Approach`.
5. Make one obligation for each key under `ensures`, `preserves` and `forbids`. Qualify the id, normalise the
   proof (see the table above), attach the `rejects` list, and set `judges` from the task's effective policy.
6. Read each `acceptance/S<n>.md`. Validate the front matter with `scenario.schema.json`. Read the tags, the
   title and the steps from the gherkin block.
7. Run R1–R13. Report every failure with its file and its rule. Start no work while a rule fails.
8. Derive `supports`, `afterEffective` and `children`. Hash each unit.

### The parse target

```ts
type TaskId = string       // "T2", "T2.1"
type ScenarioId = string   // "S25"
type GateId = string       // "BUILD-2"
type RefId = string        // "POA-D3", "POA-A3.b"
type Judge = 'runner' | 'verifier' | 'reviewer' | 'engine' | 'human'
type ProofKind = 'test' | 'gate' | 'unchanged' | 'review'
interface Budgets { taskAttempts: number; retries: number }
type Category =
  | 'happy-path' | 'empty' | 'boundary' | 'invalid-input' | 'failure'
  | 'concurrency' | 'security' | 'compatibility' | 'regression' | 'money'

interface Spec {
  id: string
  title: string
  policy: Policy                                   // SPEC.md `policy`, as written
  gates: Record<GateId, { title: string; command: string; requires?: string }>
  refs: Record<RefId, string>
  outside: Record<TaskId, string>                  // preconditions: checked in the state store
  tasks: Task[]
  obligations: Obligation[]
  scenarios: Scenario[]
}

interface Task {
  id: TaskId
  slug: string
  title: string
  parent?: TaskId
  children: TaskId[]                               // derived: child folders
  after: TaskId[]
  afterEffective: TaskId[]                         // derived: own `after` + every ancestor's
  goal: string
  approach?: string
  touches: { path: string; change: 'new' | 'update' | 'delete'; what: string }[]
  refs: RefId[]
  notHere: { what: string; owner: TaskId }[]
  gates: GateId[]
  hint?: string
  supports: ScenarioId[]                           // derived: scenarios whose `needs` name this task
  policyOverride?: { judges?: Partial<Record<ProofKind, Judge[]>>; budgets?: Partial<Budgets> }
  policy: Policy                                   // derived: spec policy with the override applied
  hash: string
}

interface Obligation {
  id: string                                       // qualified: "T2.2.c6"
  task: TaskId
  kind: 'ensures' | 'preserves' | 'forbids'
  category?: Category                              // leaf ensures only
  text: string
  covers: (ScenarioId | RefId)[]
  proof:
    | { kind: 'test'; tag: string }
    | { kind: 'gate'; gate: GateId }
    | { kind: 'unchanged'; path: string }
    | { kind: 'review' }
  judges: Judge[]                                  // derived: task.policy.judges[proof.kind]
  rejects?: string[]
  hash: string
}

interface Scenario {
  id: ScenarioId
  title: string
  tags: string[]
  category: string
  steps: string[]
  needs: TaskId[]
  environment?: { kind: 'local' | 'deployed'; setup?: string }   // absent means local
  hash: string
}
```

### Where each field comes from

| Model field | Source |
| --- | --- |
| `Spec.id` | the `.spec` folder name |
| `Spec.title` | `SPEC.md` H1 |
| `Spec.policy`, `gates`, `refs`, `outside` | `SPEC.md` front matter |
| `Task.id`, `slug` | the `.task` folder name |
| `Task.parent`, `children` | folder nesting |
| `Task.title`, `goal`, `approach` | `TASK.md` H1, `## Goal`, `## Approach` |
| `Task.after`, `touches`, `refs`, `notHere` | `TASK.md` front matter |
| `Task.gates`, `hint` | `VERIFY.md` front matter |
| `Task.supports` | derived from every scenario's `needs` |
| `Task.policyOverride`; `policy` | `VERIFY.md` `policy`; derived from it and `SPEC.md` `policy` |
| `Obligation.*` | `VERIFY.md` `ensures`, `preserves`, `forbids`, `rejects`; `judges` from the task's effective policy |
| `Scenario.id` | the file name |
| `Scenario.title`, `tags`, `steps` | the gherkin block |
| `Scenario.needs`, `category`, `environment` | the scenario's front matter |

### Relation to `../model.md`

This is the model in [`../model.md`](../model.md) with four refinements:

- Obligations are one list with required ids. Cases, preserve rules and must-not rules become `ensures`,
  `preserves` and `forbids`.
- `supports` is derived from `needs`. No file states it.
- `judges` is derived from the proof kind through the task's effective policy.
- A task can tighten the policy (`policy` in `VERIFY.md`), as the top-level README asks.
- The proof kind `diff` is now `unchanged`, the word the file uses.

## State

No state lives in these files. The engine keeps state elsewhere. It keys each record by a qualified id and by
the hash of that unit: a task, an obligation, a scenario or a gate. The hash is the SHA-256 of the unit's
canonical JSON, with sorted keys and without derived fields.

The key is fine-grained. An edit to the text of `T2.2.c6` changes only the hash of `T2.2.c6`. The engine
invalidates that obligation's proof state and verdict, and keeps every other one. An edit to `Goal` or
`Approach` changes the task hash, so the engine gives the task to the builder again.

## Validating

1. Parse each front matter with a YAML 1.2 parser that refuses duplicate keys. The `yaml` package does this by
   default.
2. Validate each front matter against its schema in [`schema/`](./schema/) with Ajv (`ajv/dist/2020`).
3. Run R1–R13 on the parsed model.

A schema checks parsed front matter, not a markdown file. A command-line validator such as
`npx ajv-cli validate --spec=draft2020 -s schema/task.schema.json -d <front-matter.json>` thus needs a separate
extraction step. The engine does the extraction and the validation in one pass. The cross-file rules are the
engine's own checks: no schema can express them.

A reference checker, `check_blend.py`, parses this example, runs R1–R13, and prints the model as JSON. The
example passes it. The checker is not included. Ask for it if you want it.

## What changed from formats 3, 4 and 5

| From | Kept | Changed |
| --- | --- | --- |
| 3 folders | `.spec` and `.task` folders; `TASK.md` and `VERIFY.md` in each; `acceptance/` | The id and title are no longer in front matter: the folder name and the H1 give them. `VERIFY.md` has no `supports`. Preserve and must-not rules moved from the `TASK.md` body to `VERIFY.md` front matter. `Change detail` became `touches[].what`. |
| 4 acceptance first | Scenarios own the edge with `needs:` | The `outcome` and `proof` fields are gone: the file name gives the id, and the proof is always the `[S<n>]` tag. |
| 5 contracts | Numbered obligations (`ensures`, `preserves`, `forbids`), rejected proofs, judges | Obligations are YAML keys, not a list grammar. The judge is derived from the proof. A parent's obligations are `e<n>`; "every part is trusted" is implicit. `Contributes to` is derived. |

## The example

The example is a slice: parent T2 and its six subtasks of a 28-task spec. Its tasks name tasks from phases 1, 3,
4 and 5 in `after` and `needs`. `SPEC.md` lists those 12 tasks under `outside`, so every reference resolves
(R6). Each one is a precondition (R12): for example, T2.1 waits until the state store records T1.2 and T1.3
as trusted. A complete spec has no `outside`.

The example keeps the corrections from the [top-level README](../README.md#how-these-files-were-made). T2.2
touches `routing-policy.ts`. T2.3 is after T1.3 and T1.6. S57 and S59 need T2.2, and S58 needs T2.6. The test
paths are the repo's real ones, as hints.

One more correction is new here. The source says T2 depends on all of T1. A parent's `after` applies to every
child (R7), so that edge would make T2.1–T2.6 wait for T1.5, which none of them needs. Each subtask already
states its own `after`, so the parent states none.
