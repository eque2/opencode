import { Effect, FileSystem, Option, Path, Predicate, Result, Schema } from "effect"
import { BlendDocument } from "./document"
import { BlendDraft } from "./draft"
import type { BlendModel } from "./model"
import { BlendRules } from "./rules"
import { BlendSchema } from "./schema"
import { BlendTree } from "./tree"

export type {
  Budgets,
  Category,
  Failure,
  GateId,
  Judge,
  LoadResult,
  Obligation,
  Policy,
  Proof,
  ProofKind,
  RefId,
  RuleId,
  Scenario,
  ScenarioId,
  Spec,
  Task,
  TaskId,
} from "./model"

type Failure = BlendModel.Failure

// Loads a blend `<slug>.spec/` folder (task-formats/blend/README.md): walks it, splits and parses each file's
// front matter, validates it against its schema, runs R1–R11 and R13, notes R12, derives `children`,
// `afterEffective`, `supports`, the effective `policy` and `judges`, and hashes each unit.
//
// It never fails: an unreadable file or folder is a rule failure like any other. Every failure is reported, with
// one exception. The cross-file rules (R5–R10, R13) run only when the per-file rules R1–R4 hold, because on a
// partial model they report noise: a renamed task folder would make every `after` and `needs` that names it fail.
export const load = Effect.fn("Blend.load")(function* (
  specDir: string,
): Effect.fn.Return<BlendModel.LoadResult, never, FileSystem.FileSystem | Path.Path> {
  const root = yield* BlendTree.read(specDir)
  const layout = layoutOf(root)
  const spec = Option.match(yield* optionalDocument(layout.specFile), {
    onNone: () => unchecked<SpecPart>(),
    onSome: specPart,
  })
  const tasks = yield* Effect.forEach(layout.tasks, (folder) =>
    Effect.map(Effect.all([optionalDocument(folder.taskFile), optionalDocument(folder.verifyFile)]), ([task, verify]) =>
      taskPart(folder, task, verify),
    ),
  )
  const scenarios = yield* Effect.forEach(layout.scenarios, (entry) =>
    Effect.map(documentOf(entry.file), (doc) => scenarioPart(entry, doc)),
  )
  const fileFailures = [
    ...layout.failures,
    ...spec.failures,
    ...tasks.flatMap((part) => part.failures),
    ...scenarios.flatMap((part) => part.failures),
  ]
  const notes = Option.match(spec.value, { onNone: () => [], onSome: (part) => preconditionNote(part.front) })
  const draft = Option.all({
    spec: spec.value,
    tasks: Option.all(tasks.map((part) => part.value)),
    scenarios: Option.all(scenarios.map((part) => part.value)),
  })
  if (Option.isNone(draft) || fileFailures.some((failure) => PER_FILE.includes(failure.rule))) {
    return finish(fileFailures, notes, Option.none())
  }
  const whole: BlendDraft.Spec = {
    id: root.name.slice(0, -".spec".length),
    title: draft.value.spec.title,
    front: draft.value.spec.front,
    tasks: draft.value.tasks,
    scenarios: draft.value.scenarios,
  }
  const failures = [...fileFailures, ...BlendRules.check(whole)]
  return finish(failures, notes, failures.length === 0 ? Option.some(model(whole)) : Option.none())
})

// The rules a single file or folder can break. A failure among them stops the cross-file rules.
const PER_FILE: ReadonlyArray<BlendModel.RuleId> = ["R1", "R2", "R3", "R4"]

const fail = (rule: BlendModel.RuleId, path: string, message: string): Failure => ({ rule, path, message })

const finish = (
  failures: ReadonlyArray<Failure>,
  notes: ReadonlyArray<string>,
  spec: Option.Option<BlendModel.Spec>,
): BlendModel.LoadResult => ({
  ...Option.match(spec, { onNone: () => ({}), onSome: (value) => ({ spec: value }) }),
  failures: failures.toSorted((a, b) => ruleNumber(a.rule) - ruleNumber(b.rule)),
  notes: [...notes],
})

const ruleNumber = (rule: BlendModel.RuleId) => Number(rule.slice(1))

const preconditionNote = (front: BlendSchema.SpecFrontMatter) => {
  const count = Object.keys(front.outside ?? {}).length
  if (count === 0) return []
  return [
    `R12 note: \`outside\` names ${count} task${count === 1 ? "" : "s"} — each is a precondition the state store must record as trusted before anything that depends on it starts`,
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// R1 and R2: the folder layout and the names in it.

interface FolderTask {
  readonly id: string
  readonly slug: string
  readonly folder: string
  readonly parent: Option.Option<string>
  readonly children: ReadonlyArray<string>
  readonly taskFile: Option.Option<BlendTree.File>
  readonly verifyFile: Option.Option<BlendTree.File>
}

interface ScenarioFile {
  readonly id: string
  readonly file: BlendTree.File
}

interface Layout {
  readonly failures: ReadonlyArray<Failure>
  readonly specFile: Option.Option<BlendTree.File>
  // Depth first; each folder's children in id order.
  readonly tasks: ReadonlyArray<FolderTask>
  // In id order.
  readonly scenarios: ReadonlyArray<ScenarioFile>
}

interface TaskLayout {
  readonly failures: ReadonlyArray<Failure>
  // The folder's own task first, then its descendants.
  readonly tasks: ReadonlyArray<FolderTask>
}

const TASK_FOLDER = /^(T[1-9][0-9]*(?:\.[1-9][0-9]*)*)-([a-z0-9]+(?:-[a-z0-9]+)*)\.task$/
const SCENARIO_FILE = /^(S[1-9][0-9]*)\.md$/

const isFile =
  (name: string) =>
  (node: BlendTree.Node): node is BlendTree.File =>
    node.kind === "file" && node.name === name

const isTaskFolder = (node: BlendTree.Node): node is BlendTree.Folder =>
  node.kind === "folder" && node.name.endsWith(".task")

const isAcceptance = (node: BlendTree.Node): node is BlendTree.Folder =>
  node.kind === "folder" && node.name === "acceptance"

const layoutOf = (root: BlendTree.Folder): Layout => {
  const named =
    root.name.endsWith(".spec") && root.name.length > ".spec".length
      ? []
      : [fail("R1", ".", "the folder is not a `<slug>.spec` folder")]
  if (Result.isFailure(root.entries)) {
    return {
      failures: [...named, fail("R1", ".", `the folder cannot be read: ${root.entries.failure}`)],
      specFile: Option.none(),
      tasks: [],
      scenarios: [],
    }
  }
  const entries = root.entries.success
  const specFile = Option.fromUndefinedOr(entries.find(isFile("SPEC.md")))
  const acceptance = Option.fromUndefinedOr(entries.find(isAcceptance))
  const strays = entries.filter((entry) => !isFile("SPEC.md")(entry) && !isAcceptance(entry) && !isTaskFolder(entry))
  const tasks = inIdOrder(entries.filter(isTaskFolder).map((folder) => taskLayout(folder, Option.none())))
  const scenarios = Option.match(acceptance, {
    onNone: () => ({ failures: [], scenarios: [] }),
    onSome: scenarioLayout,
  })
  return {
    failures: [
      ...named,
      ...(Option.isNone(specFile) ? [fail("R1", ".", "missing SPEC.md")] : []),
      ...strays.map((entry) =>
        fail("R1", entry.rel, "a `.spec` folder holds only SPEC.md, acceptance/ and `.task` folders"),
      ),
      ...tasks.flatMap((part) => part.failures),
      ...scenarios.failures,
    ],
    specFile,
    tasks: tasks.flatMap((part) => part.tasks),
    scenarios: scenarios.scenarios,
  }
}

const taskLayout = (folder: BlendTree.Folder, parent: Option.Option<string>): TaskLayout => {
  const match = TASK_FOLDER.exec(folder.name)
  if (!match) return { failures: [fail("R2", folder.rel, "folder name is not `<task id>-<slug>.task`")], tasks: [] }
  const id = match[1]
  const naming = Option.match(parent, {
    onNone: () => (/^T[1-9][0-9]*$/.test(id) ? [] : [fail("R2", folder.rel, `id ${id} is not a top-level id T<n>`)]),
    onSome: (parentId) =>
      id.startsWith(`${parentId}.`) && /^[1-9][0-9]*$/.test(id.slice(parentId.length + 1))
        ? []
        : [fail("R2", folder.rel, `id ${id} is not a direct child id of ${parentId}`)],
  })
  if (Result.isFailure(folder.entries)) {
    return {
      failures: [...naming, fail("R1", folder.rel, `the folder cannot be read: ${folder.entries.failure}`)],
      tasks: [],
    }
  }
  const entries = folder.entries.success
  const taskFile = Option.fromUndefinedOr(entries.find(isFile("TASK.md")))
  const verifyFile = Option.fromUndefinedOr(entries.find(isFile("VERIFY.md")))
  const strays = entries.filter(
    (entry) => !isFile("TASK.md")(entry) && !isFile("VERIFY.md")(entry) && !isTaskFolder(entry),
  )
  const children = inIdOrder(entries.filter(isTaskFolder).map((child) => taskLayout(child, Option.some(id))))
  const self: FolderTask = {
    id,
    slug: match[2],
    folder: folder.rel,
    parent,
    children: children.flatMap((part) => part.tasks.slice(0, 1).map((task) => task.id)),
    taskFile,
    verifyFile,
  }
  return {
    failures: [
      ...naming,
      ...strays.map((entry) =>
        fail("R1", entry.rel, "a `.task` folder holds only TASK.md, VERIFY.md and child `.task` folders"),
      ),
      ...(Option.isNone(taskFile) ? [fail("R1", folder.rel, "missing TASK.md")] : []),
      ...(Option.isNone(verifyFile) ? [fail("R1", folder.rel, "missing VERIFY.md")] : []),
      ...children.flatMap((part) => part.failures),
    ],
    tasks: [self, ...children.flatMap((part) => part.tasks)],
  }
}

// Sorts sibling folders by task id; a folder whose name gives no id sorts last.
const inIdOrder = (parts: ReadonlyArray<TaskLayout>) =>
  parts.toSorted((a, b) => {
    const left = a.tasks.at(0)
    const right = b.tasks.at(0)
    if (!left || !right) return Number(!left) - Number(!right)
    return BlendDraft.compareIds(left.id, right.id)
  })

const scenarioLayout = (folder: BlendTree.Folder) => {
  if (Result.isFailure(folder.entries)) {
    return { failures: [fail("R1", folder.rel, `the folder cannot be read: ${folder.entries.failure}`)], scenarios: [] }
  }
  const entries = folder.entries.success
  const scenarios = entries
    .flatMap((entry) => {
      if (entry.kind !== "file") return []
      const match = SCENARIO_FILE.exec(entry.name)
      return match ? [{ id: match[1], file: entry }] : []
    })
    .toSorted((a, b) => BlendDraft.compareIds(a.id, b.id))
  const failures = entries.flatMap((entry) => {
    if (entry.kind === "file" && SCENARIO_FILE.test(entry.name)) return []
    if (entry.kind === "file" && entry.name.endsWith(".md")) {
      return [fail("R2", entry.rel, "file name is not `<scenario id>.md`")]
    }
    return [fail("R1", entry.rel, "acceptance/ holds only `S<n>.md` files")]
  })
  return { failures, scenarios }
}

// ---------------------------------------------------------------------------------------------------------------
// R3, R4 and R11: each file on its own.

interface Doc {
  readonly path: string
  readonly yaml: Result.Result<unknown, ReadonlyArray<string>>
  // None when the file cannot be read.
  readonly body: Option.Option<string>
}

// A file's failures, and its parts when it has none that matter to the model.
interface Checked<A> {
  readonly failures: ReadonlyArray<Failure>
  readonly value: Option.Option<A>
}

const unchecked = <A>(): Checked<A> => ({ failures: [], value: Option.none() })

const documentOf = Effect.fnUntraced(function* (file: BlendTree.File): Effect.fn.Return<Doc> {
  if (Result.isFailure(file.text)) {
    return { path: file.rel, yaml: Result.fail([`cannot be read: ${file.text.failure}`]), body: Option.none() }
  }
  const parsed = yield* BlendDocument.frontMatter(file.text.success)
  return { path: file.rel, yaml: parsed.yaml, body: Option.some(parsed.body) }
})

const optionalDocument = (file: Option.Option<BlendTree.File>) =>
  Option.match(file, {
    onNone: () => Effect.succeed(Option.none<Doc>()),
    onSome: (present) => Effect.map(documentOf(present), Option.some),
  })

const frontOf = <S extends Schema.ConstraintDecoder<unknown>>(
  doc: Doc,
  schema: S,
): Result.Result<S["Type"], ReadonlyArray<Failure>> =>
  Result.mapError(
    Result.flatMap(doc.yaml, (yaml) => BlendDocument.decode(schema, yaml)),
    (problems) => problems.map((message) => fail("R3", doc.path, message)),
  )

const failuresOf = <A>(result: Result.Result<A, ReadonlyArray<Failure>>) =>
  Result.isFailure(result) ? result.failure : []

const stateIn = (doc: Doc) =>
  Option.exists(doc.body, BlendDocument.hasCheckbox)
    ? [fail("R11", doc.path, "checkbox in the body — state never lives in the files")]
    : []

const NO_TITLE = "body does not start with `# <title>`"

interface SpecPart {
  readonly front: BlendSchema.SpecFrontMatter
  readonly title: string
}

const specPart = (doc: Doc): Checked<SpecPart> => {
  const front = frontOf(doc, BlendSchema.SpecFrontMatter)
  const title = Option.flatMap(doc.body, BlendDocument.title)
  return {
    failures: [
      ...failuresOf(front),
      ...(Option.isSome(doc.body) && Option.isNone(title) ? [fail("R4", doc.path, NO_TITLE)] : []),
      ...stateIn(doc),
    ],
    value: Option.all({ front: Result.getSuccess(front), title }),
  }
}

const taskPart = (
  folder: FolderTask,
  taskDoc: Option.Option<Doc>,
  verifyDoc: Option.Option<Doc>,
): Checked<BlendDraft.Task> => {
  const taskPath = `${folder.folder}/TASK.md`
  const front = Option.map(taskDoc, (doc) => frontOf(doc, BlendSchema.TaskFrontMatter))
  const verify = Option.map(verifyDoc, (doc) => frontOf(doc, BlendSchema.VerifyFrontMatter))
  const body = Option.flatMap(taskDoc, (doc) => doc.body)
  const title = Option.flatMap(body, BlendDocument.title)
  const goal = Option.flatMap(body, (text) => BlendDocument.section(text, "Goal"))
  const failures = [
    ...Option.match(front, { onNone: () => [], onSome: failuresOf }),
    ...Option.match(verify, { onNone: () => [], onSome: failuresOf }),
    ...(Option.isSome(body) && Option.isNone(title) ? [fail("R4", taskPath, NO_TITLE)] : []),
    ...(Option.isSome(body) && Option.isNone(goal) ? [fail("R4", taskPath, "no `## Goal` section")] : []),
    ...(Option.isSome(goal) && goal.value === "" ? [fail("R4", taskPath, "the `## Goal` section is empty")] : []),
    ...Option.match(taskDoc, { onNone: () => [], onSome: stateIn }),
    ...Option.match(verifyDoc, { onNone: () => [], onSome: stateIn }),
  ]
  const parts = Option.all({
    front: Option.flatMap(front, Result.getSuccess),
    verify: Option.flatMap(verify, Result.getSuccess),
    title,
    goal: Option.filter(goal, (text) => text !== ""),
  })
  return {
    failures,
    value: Option.map(parts, (part) => ({
      id: folder.id,
      slug: folder.slug,
      folder: folder.folder,
      taskPath,
      verifyPath: `${folder.folder}/VERIFY.md`,
      parent: folder.parent,
      children: folder.children,
      front: part.front,
      verify: part.verify,
      title: part.title,
      goal: part.goal,
      approach: Option.filter(
        Option.flatMap(body, (text) => BlendDocument.section(text, "Approach")),
        (text) => text !== "",
      ),
    })),
  }
}

const scenarioPart = (entry: ScenarioFile, doc: Doc): Checked<BlendDraft.Scenario> => {
  const front = frontOf(doc, BlendSchema.ScenarioFrontMatter)
  const block = Option.map(doc.body, (body) => BlendDocument.gherkin(body, entry.id))
  const blockFailures = Option.match(block, {
    onNone: () => [],
    onSome: (result) =>
      Result.isFailure(result) ? result.failure.map((message) => fail("R4", doc.path, message)) : [],
  })
  const parts = Option.all({ front: Result.getSuccess(front), block: Option.flatMap(block, Result.getSuccess) })
  return {
    failures: [...failuresOf(front), ...blockFailures, ...stateIn(doc)],
    value: Option.map(parts, (part) => ({
      id: entry.id,
      path: doc.path,
      front: part.front,
      title: part.block.title,
      tags: part.block.tags,
      steps: part.block.steps,
    })),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The parse target: derivations and unit hashes.

const model = (spec: BlendDraft.Spec): BlendModel.Spec => {
  const tasks = spec.tasks.map((task) => taskModel(spec, task))
  return {
    id: spec.id,
    title: spec.title,
    policy: spec.front.policy,
    gates: spec.front.gates,
    refs: spec.front.refs,
    outside: spec.front.outside ?? {},
    tasks,
    obligations: spec.tasks.flatMap((task, index) =>
      BlendDraft.obligations(task).map((obligation) => obligationModel(obligation, tasks[index].policy)),
    ),
    scenarios: spec.scenarios.map(scenarioModel),
  }
}

const taskModel = (spec: BlendDraft.Spec, task: BlendDraft.Task): BlendModel.Task => {
  const override = task.verify.policy
  // Everything a file states about the task; the hash covers exactly this.
  const unit = {
    id: task.id,
    slug: task.slug,
    title: task.title,
    ...Option.match(task.parent, { onNone: () => ({}), onSome: (parent) => ({ parent }) }),
    after: [...(task.front.after ?? [])],
    goal: task.goal,
    ...Option.match(task.approach, { onNone: () => ({}), onSome: (approach) => ({ approach }) }),
    touches: (task.front.touches ?? []).map((touch) => ({ ...touch })),
    refs: [...(task.front.refs ?? [])],
    notHere: (task.front.notHere ?? []).map((entry) => ({ ...entry })),
    gates: [...(task.verify.gates ?? [])],
    ...(task.verify.hint === undefined ? {} : { hint: task.verify.hint }),
    ...(override ? { policyOverride: overrideModel(override) } : {}),
  }
  return {
    ...unit,
    children: [...task.children],
    policy: effectivePolicy(spec.front.policy, override),
    afterEffective: [...BlendDraft.afterEffective(spec, task)],
    supports: spec.scenarios
      .filter((scenario) => scenario.front.needs.includes(task.id))
      .map((scenario) => scenario.id),
    hash: hash(unit),
  }
}

const PROOF_KINDS = ["test", "gate", "unchanged", "review"] as const

const overrideModel = (override: BlendSchema.PolicyOverride): NonNullable<BlendModel.Task["policyOverride"]> => ({
  ...(override.judges
    ? {
        judges: Object.fromEntries(
          PROOF_KINDS.flatMap((kind) => {
            const judges = override.judges?.[kind]
            return judges ? [[kind, [...judges]]] : []
          }),
        ),
      }
    : {}),
  ...(override.budgets ? { budgets: { ...override.budgets } } : {}),
})

// The spec policy with the task's tightening applied. R13 has already checked that it only tightens.
const effectivePolicy = (
  policy: BlendSchema.Policy,
  override: BlendSchema.PolicyOverride | undefined,
): BlendSchema.Policy => ({
  ...policy,
  budgets: { ...policy.budgets, ...override?.budgets },
  judges: { ...policy.judges, ...override?.judges },
})

const obligationModel = (obligation: BlendDraft.Obligation, policy: BlendSchema.Policy): BlendModel.Obligation => {
  const proof = proofModel(obligation)
  const unit = {
    id: obligation.id,
    task: obligation.task,
    kind: obligation.kind,
    ...Option.match(obligation.category, { onNone: () => ({}), onSome: (category) => ({ category }) }),
    text: obligation.text,
    covers: [...obligation.covers],
    proof,
    ...Option.match(obligation.rejects, { onNone: () => ({}), onSome: (rejects) => ({ rejects: [...rejects] }) }),
  }
  return { ...unit, judges: [...policy.judges[proof.kind]], hash: hash(unit) }
}

// README "Proofs and judges": no proof and `test` are the obligation's own tag; `{test: c3}` is another
// obligation's tag in the same task.
const proofModel = (obligation: BlendDraft.Obligation): BlendModel.Proof => {
  const proof = obligation.proof
  if (proof === "test") return { kind: "test", tag: obligation.id }
  if (proof === "review") return { kind: "review" }
  if ("test" in proof) return { kind: "test", tag: `${obligation.task}.${proof.test}` }
  if ("gate" in proof) return { kind: "gate", gate: proof.gate }
  return { kind: "unchanged", path: proof.unchanged }
}

const scenarioModel = (scenario: BlendDraft.Scenario): BlendModel.Scenario => {
  const environment = scenario.front.environment
  const unit = {
    id: scenario.id,
    title: scenario.title,
    tags: [...scenario.tags],
    steps: [...scenario.steps],
    category: scenario.front.category,
    needs: [...scenario.front.needs],
    ...(environment ? { environment: { ...environment } } : {}),
  }
  return { ...unit, hash: hash(unit) }
}

// README "State": the SHA-256 of the unit's canonical JSON — sorted keys, no whitespace, UTF-8 — without the
// derived fields. The caller passes the unit before it adds them.
const hash = (unit: unknown) => `sha256:${new Bun.CryptoHasher("sha256").update(canonical(unit)).digest("hex")}`

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String))

const canonical = (value: unknown): string => {
  if (Predicate.isString(value)) return quote(value)
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return `${value}`
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (!Predicate.isObject(value)) return "null"
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .toSorted()
  return `{${keys.map((key) => `${quote(key)}:${canonical(value[key])}`).join(",")}}`
}

export * as Blend from "."
