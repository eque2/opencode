import { Option } from "effect"
import { BlendDraft } from "./draft"
import type { BlendModel } from "./model"
import type { BlendSchema } from "./schema"

// The rules that check the spec as a whole (README "Rules"): R5–R10 and R13. They run on a draft whose every file
// passed R1–R4, so each one sees complete front matter. R11 is a per-file rule and R12 is checked at run time.

type Failure = BlendModel.Failure

const fail = (rule: BlendModel.RuleId, path: string, message: string): Failure => ({ rule, path, message })

export const check = (spec: BlendDraft.Spec): ReadonlyArray<Failure> => [
  ...uniqueIds(spec),
  ...references(spec),
  ...order(spec),
  ...leafAndParent(spec),
  ...edges(spec),
  ...scopedRules(spec),
  ...overrides(spec),
]

const outsideIds = (spec: BlendDraft.Spec) => Object.keys(spec.front.outside ?? {})

// R5: task ids (folders and `outside`), scenario ids, gate ids and ref ids never repeat.
const uniqueIds = (spec: BlendDraft.Spec) => {
  const ids = [
    ...spec.tasks.map((task) => ({ id: task.id, kind: "task", path: task.folder })),
    ...outsideIds(spec).map((id) => ({ id, kind: "task", path: "SPEC.md" })),
    ...spec.scenarios.map((scenario) => ({ id: scenario.id, kind: "scenario", path: scenario.path })),
    ...Object.keys(spec.front.gates).map((id) => ({ id, kind: "gate", path: "SPEC.md" })),
    ...Object.keys(spec.front.refs).map((id) => ({ id, kind: "ref", path: "SPEC.md" })),
  ]
  return ids.flatMap((entry, index) => {
    const first = ids.slice(0, index).find((other) => other.id === entry.id)
    return first ? [fail("R5", entry.path, `${entry.kind} id ${entry.id} repeats a ${first.kind} id`)] : []
  })
}

// R6: `after`, `needs` and `notHere.owner` name a task; `refs` name a ref; `gates` and gate proofs name a gate;
// `covers` names a scenario or a ref; `{test: k}` and `rejects` keys name an obligation of the same VERIFY.md.
const references = (spec: BlendDraft.Spec) => {
  const tasks = [...spec.tasks.map((task) => task.id), ...outsideIds(spec)]
  const refs = Object.keys(spec.front.refs)
  const gates = Object.keys(spec.front.gates)
  const scenarios = spec.scenarios.map((scenario) => scenario.id)
  const perTask = spec.tasks.flatMap((task) => {
    const obligations = BlendDraft.obligations(task)
    const ensures = obligations
      .filter((obligation) => obligation.kind === "ensures")
      .map((obligation) => obligation.key)
    const keys = obligations.map((obligation) => obligation.key)
    return [
      ...(task.front.after ?? [])
        .filter((id) => !tasks.includes(id))
        .map((id) => fail("R6", task.taskPath, `after names unknown task ${id}`)),
      ...(task.front.notHere ?? [])
        .filter((entry) => !tasks.includes(entry.owner))
        .map((entry) => fail("R6", task.taskPath, `notHere names unknown task ${entry.owner}`)),
      ...(task.front.refs ?? [])
        .filter((id) => !refs.includes(id))
        .map((id) => fail("R6", task.taskPath, `refs names unknown reference ${id}`)),
      ...(task.verify.gates ?? [])
        .filter((id) => !gates.includes(id))
        .map((id) => fail("R6", task.verifyPath, `gates names unknown gate ${id}`)),
      ...obligations.flatMap((obligation) => [
        ...proofReference(obligation.proof, gates, ensures).map((problem) =>
          fail("R6", task.verifyPath, `${obligation.id} ${problem}`),
        ),
        ...obligation.covers
          .filter((id) => !scenarios.includes(id) && !refs.includes(id))
          .map((id) =>
            fail("R6", task.verifyPath, `${obligation.id} covers ${id}, which is neither a scenario nor a ref`),
          ),
      ]),
      ...Object.keys(task.verify.rejects ?? {})
        .filter((key) => !keys.includes(key))
        .map((key) => fail("R6", task.verifyPath, `rejects names ${key}, which is not an obligation here`)),
    ]
  })
  const perScenario = spec.scenarios.flatMap((scenario) =>
    scenario.front.needs
      .filter((id) => !tasks.includes(id))
      .map((id) => fail("R6", scenario.path, `needs names unknown task ${id}`)),
  )
  return [...perTask, ...perScenario]
}

const proofReference = (proof: BlendSchema.Proof, gates: ReadonlyArray<string>, ensures: ReadonlyArray<string>) => {
  if (typeof proof === "string") return []
  if ("gate" in proof) return gates.includes(proof.gate) ? [] : [`proof names unknown gate ${proof.gate}`]
  if ("test" in proof) {
    return ensures.includes(proof.test) ? [] : [`proof names ${proof.test}, which is not an ensures key here`]
  }
  return []
}

// R7: the `after` graph has no cycle when each child inherits its ancestors' `after`, and no task is after its
// own ancestor or descendant. A parent also waits for its children, so the graph has an edge from each parent to
// each child: a child after its parent closes a cycle.
const order = (spec: BlendDraft.Spec) => {
  const folderIds = spec.tasks.map((task) => task.id)
  const find = (id: string) => spec.tasks.find((task) => task.id === id)
  const lineage = spec.tasks.flatMap((task) => {
    const above = BlendDraft.ancestors(spec, task).map((each) => each.id)
    const below = BlendDraft.descendants(spec, task).map((each) => each.id)
    return (task.front.after ?? []).flatMap((id) => {
      if (above.includes(id)) return [fail("R7", task.taskPath, `${task.id} is after its own ancestor ${id}`)]
      if (below.includes(id)) return [fail("R7", task.taskPath, `${task.id} is after its own descendant ${id}`)]
      return []
    })
  })
  const next = (id: string) => {
    const task = find(id)
    if (!task) return []
    return BlendDraft.distinct([...BlendDraft.afterEffective(spec, task), ...task.children]).filter((each) =>
      folderIds.includes(each),
    )
  }
  const cycles = cyclesOf(folderIds, next).flatMap((cycle) => {
    const first = find(cycle[0])
    return first ? [fail("R7", first.taskPath, `order has a cycle: ${cycle.join(" → ")}`)] : []
  })
  return [...lineage, ...cycles]
}

interface Search {
  readonly done: ReadonlyArray<string>
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>
}

// Depth-first search from each node in turn; every edge back into the current path closes one cycle.
const cyclesOf = (nodes: ReadonlyArray<string>, next: (node: string) => ReadonlyArray<string>) =>
  nodes.reduce<Search>((search, node) => visit(node, [], search, next), { done: [], cycles: [] }).cycles

const visit = (
  node: string,
  stack: ReadonlyArray<string>,
  search: Search,
  next: (node: string) => ReadonlyArray<string>,
): Search => {
  if (search.done.includes(node)) return search
  const path = [...stack, node]
  const explored = next(node).reduce((state, target) => {
    if (path.includes(target))
      return { ...state, cycles: [...state.cycles, [...path.slice(path.indexOf(target)), target]] }
    return visit(target, path, state, next)
  }, search)
  return { ...explored, done: [...explored.done, node] }
}

// R8: a leaf has at least one touch, and its ensures keys are `c<n>`, each with a category. A parent has no
// touches; its ensures keys are `e<n>`, with no category, and the proof is `review` or a gate.
const leafAndParent = (spec: BlendDraft.Spec) =>
  spec.tasks.flatMap((task) => {
    const ensures = BlendDraft.obligations(task).filter((obligation) => obligation.kind === "ensures")
    if (task.children.length === 0) {
      return [
        ...((task.front.touches ?? []).length > 0
          ? []
          : [fail("R8", task.taskPath, "a leaf task declares at least one touch")]),
        ...ensures
          .filter((obligation) => !obligation.key.startsWith("c") || Option.isNone(obligation.category))
          .map((obligation) =>
            fail("R8", task.verifyPath, `${obligation.id}: a leaf's ensures key is c<n> and carries a category`),
          ),
      ]
    }
    return [
      ...(task.front.touches ? [fail("R8", task.taskPath, "a parent task declares no touches")] : []),
      ...ensures
        .filter(
          (obligation) =>
            !obligation.key.startsWith("e") ||
            Option.isSome(obligation.category) ||
            !(obligation.proof === "review" || (typeof obligation.proof === "object" && "gate" in obligation.proof)),
        )
        .map((obligation) =>
          fail(
            "R8",
            task.verifyPath,
            `${obligation.id}: a parent's ensures key is e<n>, has no category, and is proved by review or a gate`,
          ),
        ),
    ]
  })

// R9: a scenario's `needs` names leaf tasks or `outside` tasks, and an obligation that covers a scenario belongs
// to a task that the scenario needs.
const edges = (spec: BlendDraft.Spec) => {
  const parents = spec.tasks.filter((task) => task.children.length > 0).map((task) => task.id)
  const needsParent = spec.scenarios.flatMap((scenario) =>
    scenario.front.needs
      .filter((id) => parents.includes(id))
      .map((id) => fail("R9", scenario.path, `needs parent ${id}; name its leaves`)),
  )
  const covered = spec.tasks.flatMap((task) =>
    BlendDraft.obligations(task).flatMap((obligation) =>
      obligation.covers.flatMap((id) => {
        const scenario = spec.scenarios.find((candidate) => candidate.id === id)
        if (!scenario || scenario.front.needs.includes(task.id)) return []
        return [fail("R9", task.verifyPath, `${obligation.id} covers ${id}, but ${id} does not need ${task.id}`)]
      }),
    ),
  )
  return [...needsParent, ...covered]
}

// R10: a `forbids` path under `unchanged` is not in the same task's touches, and `notHere.owner` is not the task.
const scopedRules = (spec: BlendDraft.Spec) =>
  spec.tasks.flatMap((task) => {
    const touched = (task.front.touches ?? []).map((touch) => touch.path)
    return [
      ...BlendDraft.obligations(task)
        .filter((obligation) => obligation.kind === "forbids")
        .flatMap((obligation) => {
          const proof = obligation.proof
          if (typeof proof === "string" || !("unchanged" in proof) || !touched.includes(proof.unchanged)) return []
          return [
            fail(
              "R10",
              task.verifyPath,
              `${obligation.id} forbids changing ${proof.unchanged}, which the task touches`,
            ),
          ]
        }),
      ...(task.front.notHere ?? [])
        .filter((entry) => entry.owner === task.id)
        .map(() => fail("R10", task.taskPath, "notHere names the task itself as the owner")),
    ]
  })

const PROOF_KINDS = ["test", "gate", "unchanged", "review"] as const
const BUDGETS = ["taskAttempts", "retries"] as const

// R13: an override's judges list holds every judge the spec requires for that proof kind, and no budget is above
// the spec's.
const overrides = (spec: BlendDraft.Spec) => {
  const policy = spec.front.policy
  return spec.tasks.flatMap((task) => {
    const override = task.verify.policy
    if (!override) return []
    const judges = PROOF_KINDS.flatMap((kind) => {
      const listed = override.judges?.[kind]
      if (!listed) return []
      const dropped = policy.judges[kind].filter((judge) => !listed.includes(judge))
      if (dropped.length === 0) return []
      return [
        fail("R13", task.verifyPath, `policy.judges.${kind} drops ${dropped.join(", ")}, which the spec requires`),
      ]
    })
    const budgets = BUDGETS.flatMap((name) => {
      const value = override.budgets?.[name]
      if (value === undefined || value <= policy.budgets[name]) return []
      return [
        fail("R13", task.verifyPath, `policy.budgets.${name} is ${value}, above the spec's ${policy.budgets[name]}`),
      ]
    })
    return [...judges, ...budgets]
  })
}

export * as BlendRules from "./rules"
