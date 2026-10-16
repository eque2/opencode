import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import path from "path"
import ts from "typescript"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, observed } from "./lib/machine"

// Scenario SV15 (spec task-harness-feedback, D8, D17, D20, AD-13, defect 9; task T2.3): the status file is a
// projection of the machine snapshot.
//
//   Given the observed facts folded through the release-notes machine
//   When the status is projected
//   Then each task, obligation and scenario carries its state, its tags, its blocked cause, its start and end times
//     and, for a task, its spans
//   And the run carries its title, spec id, path, start and end times, and each scenario carries its loader title
//     with no leading id
//   And the projection derives no state of its own and never emits phase or dependency tags
//   And the old run-state and waitingOn derivations from the plan no longer exist
//   And an obligation, which never blocks, carries no blocked cause
//
// The observed facts are the owner's release-notes run (T1.1 to T1.3 trusted, T1.4 budget exhausted after three
// failed proofs). They are folded through the real engine (`TaskEngineXState.initial` and `apply`, the run machine of
// the loaded plan), and the status is the real `TaskStatus.project`. Each projected value is checked twice: against
// the snapshot's own selectors and context (the projection adds nothing), and against the facts themselves (the
// values are the right ones). The status is also projected after every prefix of the fold, and with a plan whose
// dependency lists are emptied, to show that nothing in it comes from the plan's dependencies.

const it = testEffect(NodeServices.layer)

const SPEC_DIR = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")
const SOURCE = path.resolve(import.meta.dir, "../../src/task")
/** The class tags of the contract, in the AD-1 order. */
const CLASS_TAGS = ["waiting", "active", "ended", "stopped", "blocked", "dead"]
/** The phase tags the machine carries and the file never holds. */
const PHASE_TAGS = ["ready", "building", "proving", "verifying"]

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = TaskEngineXState.initial(plan)) =>
  list.reduce((snapshot, fact) => TaskEngineXState.apply(plan, snapshot, fact), from)

// The keys of an object that are present (an absent optional value is an absent key, AD-13).
const present = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

// What the snapshot itself holds for a unit, with no projection in between.
const ownOf = (snapshot: RunSnapshot, id: string) => {
  const slot = snapshot.context.units[id]
  const blockedBy = TaskEngineXState.blockedBy(snapshot, id)
  return {
    tags: [...TaskEngineXState.tags(snapshot, id)],
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(slot?.startedAt === undefined ? {} : { startedAt: slot.startedAt }),
    ...(slot?.endedAt === undefined ? {} : { endedAt: slot.endedAt }),
  }
}

// Every `tags` array in a status, with the key path it sits at.
const tagLists = (value: unknown, at = ""): Array<readonly [string, ReadonlyArray<unknown>]> => {
  if (Array.isArray(value)) return value.flatMap((item, index) => tagLists(item, `${at}[${index}]`))
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([name, item]) => [
    ...(name === "tags" && Array.isArray(item) ? [[`${at}.tags`, item] as const] : []),
    ...tagLists(item, `${at}.${name}`),
  ])
}

const given = Effect.fnUntraced(function* () {
  const plan = yield* loadPlan("release-notes.spec")
  const f = facts()
  const list = observed(plan, f)
  const snapshot = fold(plan, list)
  return { plan, f, list, snapshot, status: TaskStatus.project(plan, snapshot) }
})

// The `at` of the first and last fact of a task, and of a given fact type.
const atOf = (list: ReadonlyArray<Fact>, task: string, type: Fact["type"], which: "first" | "last" = "first") => {
  const own = list.filter((fact) => fact.type === type && "task" in fact && fact.task === task)
  const fact = which === "first" ? own[0] : own.at(-1)
  if (fact === undefined) throw new Error(`no ${type} for ${task}`)
  return fact.at
}

it.live(
  "[SV15] each task, obligation and scenario carries its state, its tags, its blocked cause, its start and end times and, for a task, its spans, as the snapshot holds them",
  () =>
    Effect.gen(function* () {
      const { plan, list, snapshot, status } = yield* given()
      const view = TaskEngineXState.view(snapshot)
      // Every unit of the plan is in the file, and nothing else.
      expect(Object.keys(status.tasks).toSorted()).toEqual(plan.tasks.map((task) => task.id).toSorted())
      expect(Object.keys(status.obligations).toSorted()).toEqual(
        plan.spec.obligations.map((item) => item.id).toSorted(),
      )
      expect(Object.keys(status.scenarios).toSorted()).toEqual(plan.scenarios.map((item) => item.id).toSorted())

      // Against the snapshot: each value is the snapshot's own, and an absent one is an absent key.
      for (const task of plan.tasks) {
        const entry = status.tasks[task.id]
        const own = ownOf(snapshot, task.id)
        expect({ id: task.id, state: entry?.state }).toEqual({ id: task.id, state: view.tasks[task.id]?.state })
        expect({ id: task.id, tags: entry?.tags, blockedBy: entry?.blockedBy }).toEqual({
          id: task.id,
          tags: own.tags,
          blockedBy: own.blockedBy,
        })
        expect({ id: task.id, startedAt: entry?.startedAt, endedAt: entry?.endedAt }).toEqual({
          id: task.id,
          startedAt: own.startedAt,
          endedAt: own.endedAt,
        })
        expect(present(entry ?? {}, "blockedBy")).toBe(present(own, "blockedBy"))
        expect(present(entry ?? {}, "startedAt")).toBe(present(own, "startedAt"))
        expect(present(entry ?? {}, "endedAt")).toBe(present(own, "endedAt"))
        expect({ id: task.id, spans: entry?.spans }).toEqual({
          id: task.id,
          spans: (snapshot.context.units[task.id]?.spans ?? []).map((span) => ({
            state: span.state,
            from: span.from,
            ...(span.to === undefined ? {} : { to: span.to }),
          })),
        })
      }
      for (const obligation of plan.spec.obligations) {
        const entry = status.obligations[obligation.id]
        const own = ownOf(snapshot, obligation.id)
        expect({ id: obligation.id, state: entry?.state, tags: entry?.tags }).toEqual({
          id: obligation.id,
          state: view.obligations[obligation.id]?.state,
          tags: own.tags,
        })
        expect({ id: obligation.id, startedAt: entry?.startedAt, endedAt: entry?.endedAt }).toEqual({
          id: obligation.id,
          startedAt: own.startedAt,
          endedAt: own.endedAt,
        })
      }
      for (const scenario of plan.scenarios) {
        const entry = status.scenarios[scenario.id]
        const own = ownOf(snapshot, scenario.id)
        expect({ id: scenario.id, state: entry?.state }).toEqual({
          id: scenario.id,
          state: view.scenarios[scenario.id]?.state,
        })
        expect({ id: scenario.id, tags: entry?.tags, blockedBy: entry?.blockedBy }).toEqual({
          id: scenario.id,
          tags: own.tags,
          blockedBy: own.blockedBy,
        })
        expect({ id: scenario.id, startedAt: entry?.startedAt, endedAt: entry?.endedAt }).toEqual({
          id: scenario.id,
          startedAt: own.startedAt,
          endedAt: own.endedAt,
        })
      }

      // Against the facts: the values are the right ones.
      // T1.1 trusted: built, proved and verified on its first attempt, from its task.started to its task.verified.
      const t11 = status.tasks["T1.1"]
      expect(t11).toMatchObject({ state: "trusted", tags: ["ended"], attempts: 1 })
      expect(t11?.startedAt).toBe(atOf(list, "T1.1", "task.started"))
      expect(t11?.endedAt).toBe(atOf(list, "T1.1", "task.verified"))
      expect(t11?.blockedBy).toBeUndefined()
      // Its spans run without a gap from its start to its end, and end in trusted.
      const spans = t11?.spans ?? []
      expect(spans.map((span) => span.state)).toEqual(["waiting", "building", "proving", "verifying", "trusted"])
      for (const [index, span] of spans.entries()) if (index > 0) expect(span.from).toBe(spans[index - 1]?.to ?? -1)
      expect(spans.find((span) => span.state === "building")?.from).toBe(atOf(list, "T1.1", "task.started"))
      // The last span starts at the verification and, the task having ended, is closed at its end time.
      expect(spans.at(-1)).toMatchObject({ state: "trusted", from: atOf(list, "T1.1", "task.verified") })
      expect([undefined, t11?.endedAt]).toContain(spans.at(-1)?.to)
      // T1.4 budget exhausted after three attempts: dead, from its task.started to its last task.proved.
      const t14 = status.tasks["T1.4"]
      expect(t14).toMatchObject({ state: "budget_exhausted", tags: ["ended", "stopped", "dead"], attempts: 3 })
      expect(t14?.startedAt).toBe(atOf(list, "T1.4", "task.started"))
      expect(t14?.endedAt).toBe(atOf(list, "T1.4", "task.proved", "last"))
      expect(t14?.spans.map((span) => span.state)).toEqual([
        "waiting",
        "building",
        "proving",
        "building",
        "proving",
        "building",
        "proving",
        "budget_exhausted",
      ])
      // T1.5 and T1 blocked by T1.4, the cause named; never started, so no start time.
      for (const id of ["T1.5", "T1"]) {
        expect(status.tasks[id]).toMatchObject({
          state: "blocked",
          tags: ["ended", "stopped", "blocked"],
          blockedBy: { id: "T1.4", state: "budget_exhausted" },
        })
        expect(status.tasks[id]?.startedAt).toBeUndefined()
        expect(status.tasks[id]?.endedAt).toBe(atOf(list, "T1.4", "task.proved", "last"))
        expect(status.tasks[id]?.spans.map((span) => span.state)).toEqual(["waiting", "blocked"])
      }
      // An obligation: T1.1.c1 trusted with T1.1's verification, T1.4.c7 failed with its reason.
      // T1.1's proof passed every obligation with no judge left to ask, so T1.1.c1 ended trusted at the proof; the
      // end time is the history entry of that move.
      const trustedAt = snapshot.context.log.find((entry) => entry.unit === "T1.1.c1" && entry.to === "trusted")?.at
      expect(trustedAt).toBe(atOf(list, "T1.1", "task.proved"))
      expect(status.obligations["T1.1.c1"]).toMatchObject({ state: "trusted", tags: ["ended"], endedAt: trustedAt })
      expect(status.obligations["T1.4.c7"]).toMatchObject({
        state: "failed",
        reason: "the test asserts only that 'topic change' appears",
      })
      // A scenario that needs T1.4 is blocked with the cause named; one whose needs are trusted is pending.
      const blocked = plan.scenarios.filter((item) => status.scenarios[item.id]?.state === "blocked")
      expect(blocked.length).toBeGreaterThan(0)
      // Each names the need that ended it, in that need's own projected state: T1.4 dead, or a task it blocked.
      for (const item of blocked) {
        const cause = status.scenarios[item.id]?.blockedBy
        expect({ id: item.id, need: item.needs.includes(cause?.id ?? "") }).toEqual({ id: item.id, need: true })
        expect({ id: item.id, state: cause?.state }).toEqual({
          id: item.id,
          state: status.tasks[cause?.id ?? ""]?.state,
        })
        expect(["budget_exhausted", "blocked"]).toContain(cause?.state ?? "")
      }
      expect(status.scenarios["S2"]).toMatchObject({ state: "pending", tags: ["active"] })
      expect(status.scenarios["S2"]?.blockedBy).toBeUndefined()
    }),
)

it.live(
  "[SV15] the run carries its title, spec id, path, start and end times, and each scenario carries its loader title with no leading id",
  () =>
    Effect.gen(function* () {
      const { plan, f, list, snapshot, status } = yield* given()
      // The title is the SPEC.md H1.
      const h1 = fs
        .readFileSync(path.join(SPEC_DIR, "SPEC.md"), "utf8")
        .split("\n")
        .find((line) => line.startsWith("# "))
      expect(h1).toBe(`# ${status.run.title}`)
      expect(status.run).toMatchObject({
        title: "Release notes from conventional commits",
        spec: "task-formats/blend/release-notes.spec",
        specId: "release-notes.spec",
        path: "task-formats/blend/release-notes.spec",
        state: "running",
        tags: ["active"],
        startedAt: list[0]?.at,
      })
      expect(list[0]?.type).toBe("run.started")
      // A live run has no end time; no task title is in the run of a whole-spec run, and the heartbeat is not
      // projected.
      expect(present(status.run, "endedAt")).toBe(false)
      expect(present(status.run, "task")).toBe(false)
      expect(present(status.run, "aliveAt")).toBe(false)
      // A stopped run ends: its end time is the stop's, and its state follows the task that died first (AD-4).
      const stop = f.cancelled("stopped by the owner")
      const stopped = TaskStatus.project(plan, fold(plan, [stop], snapshot))
      expect(stopped.run).toMatchObject({
        state: "budget_exhausted",
        tags: ["ended", "stopped"],
        startedAt: list[0]?.at,
        endedAt: stop.at,
        title: "Release notes from conventional commits",
        specId: "release-notes.spec",
      })
      // Each scenario: the loader's title, which is its acceptance file's Scenario line without the leading id.
      for (const scenario of plan.scenarios) {
        const title = status.scenarios[scenario.id]?.title ?? ""
        const line = fs
          .readFileSync(path.join(SPEC_DIR, "acceptance", `${scenario.id}.md`), "utf8")
          .split("\n")
          .find((text) => text.trim().startsWith("Scenario:"))
        expect({ id: scenario.id, line: line?.trim() }).toEqual({
          id: scenario.id,
          line: `Scenario: ${scenario.id} ${title}`,
        })
        expect({ id: scenario.id, title }).toEqual({ id: scenario.id, title: scenario.title })
        expect({ id: scenario.id, leadingId: /^S\d+\b/.test(title) }).toEqual({ id: scenario.id, leadingId: false })
        expect(title.length).toBeGreaterThan(0)
      }
    }),
)

it.live(
  "[SV15] the projection derives no state of its own: after every fact it shows the machine's states, class tags only in their order, no phase or waits: tag, and waits that follow the machine, not the plan",
  () =>
    Effect.gen(function* () {
      const { plan, list } = yield* given()
      // The same plan with every dependency list emptied: a projection that read the plan's dependencies would change.
      const unlinked: Plan = {
        ...plan,
        tasks: plan.tasks.map((task) => ({ ...task, after: [], afterEffective: [] })),
        scenarios: plan.scenarios.map((scenario) => ({ ...scenario, needs: [] })),
      }
      let snapshot = TaskEngineXState.initial(plan)
      let phaseSeen = 0
      let waitsSeen = 0
      for (const [index, fact] of [undefined, ...list].entries()) {
        if (fact !== undefined) snapshot = TaskEngineXState.apply(plan, snapshot, fact)
        const status = TaskStatus.project(plan, snapshot)
        const view = TaskEngineXState.view(snapshot)
        // The snapshot carries phase and waits: tags; the file never does.
        phaseSeen += snapshot.tags.filter((tag) => PHASE_TAGS.some((phase) => tag.endsWith(`:${phase}`))).length
        waitsSeen += snapshot.tags.filter((tag) => tag.includes(":waits:")).length
        for (const [at, tags] of tagLists(status)) {
          expect({ step: index, at, unknown: tags.filter((tag) => !CLASS_TAGS.includes(String(tag))) }).toEqual({
            step: index,
            at,
            unknown: [],
          })
          expect({ step: index, at, tags }).toEqual({
            step: index,
            at,
            tags: CLASS_TAGS.filter((tag) => tags.includes(tag)),
          })
        }
        // Every state is the machine's: the run's and each unit's.
        expect({ step: index, run: status.run.state }).toEqual({ step: index, run: view.run.state })
        for (const [id, task] of Object.entries(status.tasks))
          expect({ step: index, id, state: task.state }).toEqual({ step: index, id, state: view.tasks[id]?.state })
        for (const [id, scenario] of Object.entries(status.scenarios))
          expect({ step: index, id, state: scenario.state }).toEqual({
            step: index,
            id,
            state: view.scenarios[id]?.state,
          })
        // What a unit waits on is the machine's waits: tags, never the plan's lists.
        for (const [id, task] of Object.entries(status.tasks))
          expect({ step: index, id, waitingOn: task.waitingOn }).toEqual({
            step: index,
            id,
            waitingOn: [...TaskEngineXState.waitingOn(snapshot, id)],
          })
        expect(TaskStatus.project(unlinked, snapshot)).toEqual(status)
      }
      expect(phaseSeen).toBeGreaterThan(0)
      expect(waitsSeen).toBeGreaterThan(0)

      // T1.5 is after T1.3, T1.4 and T9 in the plan. Once T1.3 is trusted, the file says it waits on T1.4 and T9 only
      // (T9 is outside); once T1.4 is dead it is blocked and waits on nothing.
      expect(plan.tasks.find((task) => task.id === "T1.5")?.after).toEqual(["T1.3", "T1.4", "T9"])
      const t13Trusted = list.findIndex((fact) => fact.type === "task.verified" && fact.task === "T1.3")
      const mid = TaskStatus.project(plan, fold(plan, list.slice(0, t13Trusted + 1)))
      expect(mid.tasks["T1.5"]).toMatchObject({
        state: "waiting",
        tags: ["waiting"],
        waitingOn: ["T1.4", "T9"],
        waitingOnOutside: ["T9"],
      })
      const end = TaskStatus.project(plan, fold(plan, list))
      expect(end.tasks["T1.5"]).toMatchObject({ state: "blocked", waitingOn: [], waitingOnOutside: [] })
    }),
)

it.live("[SV15] the old run-state and waitingOn derivations from the plan no longer exist", () =>
  Effect.sync(() => {
    // The module: the projection takes the plan and a snapshot, and nothing of the old derivation is exported.
    const exported = Object.keys(TaskStatus)
    for (const name of ["runState", "waitingOn", "trusted", "ACTIVE", "Input"]) expect(exported).not.toContain(name)
    for (const name of ["project", "refused", "write", "file", "Status", "specIdOf"]) expect(exported).toContain(name)
    expect(TaskStatus.project.length).toBe(2)
    // The source: no declaration of the old names, and no read of a dependency list of the plan.
    const file = path.join(SOURCE, "core/status.ts")
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
    const declared: Array<string> = []
    const reads: Array<string> = []
    const visit = (node: ts.Node) => {
      if (
        (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        node.name
      )
        if (ts.isIdentifier(node.name)) declared.push(node.name.text)
      if (ts.isPropertyAccessExpression(node)) reads.push(node.name.text)
      node.forEachChild(visit)
    }
    visit(source)
    expect(declared).toContain("project")
    for (const name of ["runState", "waitingOn", "trusted", "ACTIVE", "Input"]) expect(declared).not.toContain(name)
    for (const name of ["after", "afterEffective", "needs", "supports"]) expect(reads).not.toContain(name)
    // What a unit waits on is read through the engine's selector of the machine's waits: tags.
    expect(reads).toContain("waitingOn")
    expect(fs.readFileSync(file, "utf8")).toContain("TaskEngineXState.waitingOn(snapshot, id)")
    // No other harness module brings the old derivation back.
    const others = (directory: string): ReadonlyArray<string> =>
      fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? others(path.join(directory, entry.name))
            : /\.tsx?$/.test(entry.name)
              ? [path.join(directory, entry.name)]
              : [],
        )
    // A function named like an old derivation, or the old ACTIVE list, anywhere in the harness source. (The engine's
    // `view` keeps a local value `runState`, read from the run slot's state through the CLASS table: no derivation.)
    const derivations = others(SOURCE).flatMap((other) => {
      const parsed = ts.createSourceFile(other, fs.readFileSync(other, "utf8"), ts.ScriptTarget.Latest, true)
      const found: Array<string> = []
      const look = (node: ts.Node) => {
        const name =
          (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)
            ? node.name.text
            : undefined
        const isFunction =
          ts.isFunctionDeclaration(node) ||
          (ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
        if (name !== undefined && ["runState", "trusted", "waitingOn"].includes(name) && isFunction)
          found.push(`${path.relative(SOURCE, other)}#${name}`)
        if (name === "ACTIVE") found.push(`${path.relative(SOURCE, other)}#ACTIVE`)
        node.forEachChild(look)
      }
      look(parsed)
      return found
    })
    // The one function of these names is the engine's selector that reads the machine's waits: tags.
    expect(derivations).toEqual(["engine-xstate/index.ts#waitingOn"])
    expect(TaskEngineXState.waitingOn.toString()).toContain(":waits:")
  }),
)

it.live(
  "[SV15] an obligation, which never blocks, carries no blocked cause, while blocked tasks and scenarios do",
  () =>
    Effect.gen(function* () {
      const { plan, list, snapshot, status } = yield* given()
      // Blocked units exist in this run, so a missing cause on an obligation is not for want of one.
      expect(Object.values(status.tasks).filter((task) => task.blockedBy !== undefined).length).toBeGreaterThan(0)
      expect(Object.values(status.scenarios).filter((item) => item.blockedBy !== undefined).length).toBeGreaterThan(0)
      // No obligation carries the key, in the observed fold and after every prefix of it, and the machine never tags
      // an obligation blocked.
      let current = TaskEngineXState.initial(plan)
      for (const fact of [undefined, ...list]) {
        if (fact !== undefined) current = TaskEngineXState.apply(plan, current, fact)
        const each = TaskStatus.project(plan, current)
        for (const [id, obligation] of Object.entries(each.obligations)) {
          expect({ id, blockedBy: present(obligation, "blockedBy") }).toEqual({ id, blockedBy: false })
          expect({ id, blocked: current.hasTag(`${id}:blocked`) }).toEqual({ id, blocked: false })
        }
      }
      // The obligations of the blocked T1.5 and T1 stay pending, with no cause.
      for (const obligation of plan.spec.obligations.filter((item) => item.task === "T1.5" || item.task === "T1"))
        expect(status.obligations[obligation.id]).toEqual({ state: "pending", tags: ["waiting"] })
      expect(snapshot.status).toBe("active")
    }),
)
