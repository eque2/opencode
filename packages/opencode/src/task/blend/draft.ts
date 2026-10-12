import { Option } from "effect"
import type { BlendSchema } from "./schema"

// A spec whose every file has passed the per-file rules (R1–R4): decoded front matter and the body parts the
// parser reads, with the files' paths kept for reporting. The cross-file rules and the model both start here.

export interface Task {
  readonly id: string
  readonly slug: string
  readonly folder: string
  readonly taskPath: string
  readonly verifyPath: string
  readonly parent: Option.Option<string>
  readonly children: ReadonlyArray<string>
  readonly front: BlendSchema.TaskFrontMatter
  readonly verify: BlendSchema.VerifyFrontMatter
  readonly title: string
  readonly goal: string
  readonly approach: Option.Option<string>
}

export interface Scenario {
  readonly id: string
  readonly path: string
  readonly front: BlendSchema.ScenarioFrontMatter
  readonly title: string
  readonly tags: ReadonlyArray<string>
  readonly steps: ReadonlyArray<string>
}

export interface Spec {
  readonly id: string
  readonly title: string
  readonly front: BlendSchema.SpecFrontMatter
  readonly tasks: ReadonlyArray<Task>
  readonly scenarios: ReadonlyArray<Scenario>
}

export type ObligationKind = "ensures" | "preserves" | "forbids"

export interface Obligation {
  readonly id: string
  readonly key: string
  readonly task: string
  readonly kind: ObligationKind
  readonly category: Option.Option<BlendSchema.Category>
  readonly text: string
  readonly covers: ReadonlyArray<string>
  // As written; an ensures obligation without `proof` is proved by its own test.
  readonly proof: BlendSchema.Proof
  readonly rejects: Option.Option<ReadonlyArray<string>>
}

// The obligations of one task: ensures, then preserves, then forbids, each in key order.
export const obligations = (task: Task): ReadonlyArray<Obligation> => {
  const verify = task.verify
  const make = (kind: ObligationKind, key: string, entry: BlendSchema.Ensures | BlendSchema.Rule): Obligation => ({
    id: `${task.id}.${key}`,
    key,
    task: task.id,
    kind,
    category: "category" in entry ? Option.fromUndefinedOr(entry.category) : Option.none(),
    text: entry.text,
    covers: "covers" in entry ? (entry.covers ?? []) : [],
    proof: entry.proof ?? "test",
    rejects: Option.fromUndefinedOr(verify.rejects?.[key]),
  })
  return [
    ...byKey(verify.ensures).map(([key, entry]) => make("ensures", key, entry)),
    ...byKey(verify.preserves).map(([key, entry]) => make("preserves", key, entry)),
    ...byKey(verify.forbids).map(([key, entry]) => make("forbids", key, entry)),
  ]
}

const byKey = <A>(record: { readonly [key: string]: A } | undefined): ReadonlyArray<readonly [string, A]> =>
  Object.entries(record ?? {}).toSorted(([a], [b]) => numberOf(a) - numberOf(b))

const numberOf = (key: string) => Number(key.slice(1))

// Orders ids by their numbers: T2.2 before T2.10, S9 before S10.
export const compareIds = (a: string, b: string): number => {
  const left = a.slice(1).split(".").map(Number)
  const right = b.slice(1).split(".").map(Number)
  const index = left.findIndex((value, at) => at >= right.length || value !== right[at])
  // `left` equals `right` or is a prefix of it.
  if (index < 0) return left.length - right.length
  // `right` is a prefix of `left`.
  if (index >= right.length) return 1
  return left[index] - right[index]
}

export const ancestors = (spec: Spec, task: Task): ReadonlyArray<Task> =>
  Option.match(task.parent, {
    onNone: () => [],
    onSome: (id) => {
      const parent = spec.tasks.find((candidate) => candidate.id === id)
      return parent ? [parent, ...ancestors(spec, parent)] : []
    },
  })

export const descendants = (spec: Spec, task: Task): ReadonlyArray<Task> =>
  spec.tasks
    .filter((candidate) => task.children.includes(candidate.id))
    .flatMap((child) => [child, ...descendants(spec, child)])

// The task's own `after`, then every ancestor's: a child inherits its ancestors' order (R7).
export const afterEffective = (spec: Spec, task: Task): ReadonlyArray<string> =>
  distinct([task, ...ancestors(spec, task)].flatMap((each) => each.front.after ?? []))

export const distinct = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
  values.filter((value, index) => values.indexOf(value) === index)

export * as BlendDraft from "./draft"
