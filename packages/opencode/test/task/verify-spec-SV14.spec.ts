import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer, Option, Predicate } from "effect"
import fs from "fs"
import path from "path"
import ts from "typescript"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TaskHooks } from "@/task/core/hooks"
import { TaskSessions } from "@/task/core/sessions"
import { TaskSupervisor } from "@/task/core/supervise/task"
import { TaskWorkers } from "@/task/core/workers"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan } from "./lib/machine"
import {
  eventually,
  hang,
  prompted,
  runOf,
  settle,
  stored,
  storedFacts,
  storedTypes,
  type Turn,
  unitOf,
} from "./lib/supervise"

// Scenario SV14 (spec task-harness-feedback, D7, D9, AD-8, AD-11; tasks T2.7, T2.12, T2.13): the session watch and the
// hooks hold no state of their own.
//
//   Given the session watch and hook modules after phase 2
//   When they are inspected
//   Then they hold no Ref, no MutableHashMap and no polled loop
//   And stall, idle and the spend cap are delayed transitions and guards of the task supervisor
//
// The session watch after phase 2 is `core/sessions.ts` (the session messages and the spend-cap read) and the
// `sessionEvents` actor of `core/workers.ts` with its helpers; the hooks are `core/hooks.ts`. The inspection parses
// them with the TypeScript compiler and looks for each construct by its kind: any mutable cell or keyed collection of
// Effect or JavaScript (Ref and its kin, MutableHashMap and its kin, `new Map` / `new Set`), any polled loop (an
// endless loop, a loop that sleeps, a repeat or a schedule, a tick stream, a timer) and any module-level `let` or
// `var`. A negative control runs the same scan over a planted source that holds each construct, so a scan that sees
// nothing fails. The module exports are read from the modules themselves: the phase-1 members (`builderTurn`, the
// hook maps `ready`, `verdicts`, `repeated`, `limits`, `take*`, `watch`, `unwatch`) are gone. The task supervisor's
// own node tree shows where the stall, the idle end and the spend cap live, and a live supervisor on a simulated
// clock shows that each one comes from its delayed transition or its guard, never from wall time passing.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SOURCE = path.resolve(import.meta.dir, "../../src/task")

// --- the scan -------------------------------------------------------------------------------------------------------

interface Unit {
  readonly name: string
  readonly source: ts.SourceFile
}

const parse = (name: string, text: string): Unit => ({
  name,
  source: ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true),
})

const nameOf = (node: ts.Node | undefined) =>
  node !== undefined && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined

// The module-level statements of a file that declare one of `names`, as one unit of their own text.
const declarationsOf = (unit: Unit, names: ReadonlyArray<string>) => {
  const found: Array<string> = []
  const texts = unit.source.statements.flatMap((statement) => {
    const declared = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map((item) => nameOf(item.name))
      : ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        ? [nameOf(statement.name)]
        : []
    const hit = declared.filter((name): name is string => name !== undefined && names.includes(name))
    found.push(...hit)
    return hit.length > 0 ? [statement.getFullText()] : []
  })
  return { found: found.toSorted(), unit: parse(`${unit.name}#${names.join(",")}`, texts.join("\n")) }
}

const CELLS = [
  "Ref",
  "SynchronizedRef",
  "SubscriptionRef",
  "MutableRef",
  "TxRef",
  "MutableHashMap",
  "HashMap",
  "MutableHashSet",
  "HashSet",
  "MutableList",
  "MutableQueue",
  "FiberMap",
  "FiberSet",
]
const REPEATS = ["repeat", "repeatN", "repeatOrElse", "forever", "schedule", "scheduleFrom"]

const isTrue = (node: ts.Node | undefined) => node !== undefined && node.kind === ts.SyntaxKind.TrueKeyword

const member = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
    ? { object: node.expression.text, name: node.name.text }
    : undefined

const containsSleep = (node: ts.Node): boolean => {
  const found = member(node)
  if (found !== undefined && found.object === "Effect" && found.name === "sleep") return true
  return node.forEachChild((child) => (containsSleep(child) ? true : undefined)) ?? false
}

/** What the scan finds in each unit: `<unit>: <construct>` for every mutable cell, polled loop and module-level let. */
const scan = (units: ReadonlyArray<Unit>) =>
  units.flatMap((unit) => {
    const findings: Array<string> = []
    const visit = (node: ts.Node) => {
      const at = (what: string) => findings.push(`${unit.name}: ${what}`)
      // An import of a cell type, a use of one, or a JavaScript keyed collection.
      if (ts.isImportSpecifier(node) && CELLS.includes(node.name.text)) at(`import ${node.name.text}`)
      const found = member(node)
      if (found !== undefined && CELLS.includes(found.object)) at(`${found.object}.${found.name}`)
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression))
        if (["Map", "Set", "WeakMap", "WeakSet"].includes(node.expression.text)) at(`new ${node.expression.text}`)
      // A polled loop: an endless loop, a loop that sleeps, a repeat or schedule, a tick stream, a timer.
      if (
        (ts.isWhileStatement(node) && isTrue(node.expression)) ||
        (ts.isDoStatement(node) && isTrue(node.expression)) ||
        (ts.isForStatement(node) && node.condition === undefined)
      )
        at("endless loop")
      if (
        (ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node) || ts.isForOfStatement(node)) &&
        containsSleep(node.statement)
      )
        at("sleeping loop")
      if (found !== undefined && found.object === "Effect" && REPEATS.includes(found.name)) at(`Effect.${found.name}`)
      if (found !== undefined && found.object === "Schedule") at(`Schedule.${found.name}`)
      if (found !== undefined && found.object === "Stream" && ["tick", "repeat", "schedule"].includes(found.name))
        at(`Stream.${found.name}`)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
        if (["setInterval", "setTimeout"].includes(node.expression.text)) at(node.expression.text)
      // State that outlives a call: a module-level let or var, or a class with fields.
      if (ts.isVariableStatement(node) && ts.isSourceFile(node.parent))
        if (!(node.declarationList.flags & ts.NodeFlags.Const)) at("module-level let or var")
      if (ts.isClassDeclaration(node)) at(`class ${nameOf(node.name) ?? "<anonymous>"}`)
      node.forEachChild(visit)
    }
    visit(unit.source)
    return findings
  })

const read = (file: string) => parse(file, fs.readFileSync(path.join(SOURCE, file), "utf8"))

// The session watch: core/sessions.ts, and the sessionEvents actor with its helpers in core/workers.ts.
const WATCH = ["sessionEvents", "toolEvents", "statusEvent", "of", "TurnEvent"]
const watchPart = declarationsOf(read("core/workers.ts"), WATCH)
const units = [read("core/sessions.ts"), watchPart.unit, read("core/hooks.ts")]

// --- the task supervisor's node tree ----------------------------------------------------------------------------------

interface Row {
  readonly event: string
  readonly delay?: number | string
  readonly guard: string | undefined
  readonly target: ReadonlyArray<string>
}

const guardOf = (guard: unknown) => {
  if (!Option.isOption(guard) || Option.isNone(guard)) return undefined
  return Predicate.isString(guard.value) ? guard.value : "<inline>"
}

const rowOf = (transition: unknown): Row => {
  const target =
    Predicate.hasProperty(transition, "target") && Array.isArray(transition.target) ? transition.target : []
  return {
    event: Predicate.hasProperty(transition, "eventType") ? String(transition.eventType) : "",
    ...(Predicate.hasProperty(transition, "delay") &&
    (Predicate.isNumber(transition.delay) || Predicate.isString(transition.delay))
      ? { delay: transition.delay }
      : {}),
    guard: guardOf(Predicate.hasProperty(transition, "guard") ? transition.guard : undefined),
    target: target.map((node: unknown) => (Predicate.hasProperty(node, "id") ? String(node.id) : "?")),
  }
}

// The state node at a path of keys under the machine's root.
const nodeAt = (...keys: ReadonlyArray<string>) => {
  let current: unknown = TaskSupervisor.machine.root
  for (const key of keys) {
    const states = Predicate.hasProperty(current, "states") ? current.states : undefined
    current = Predicate.hasProperty(states, key) ? states[key] : undefined
    if (current === undefined) throw new Error(`no state ${keys.join(".")}`)
  }
  const list = (key: string): ReadonlyArray<Row> => {
    const value = Predicate.hasProperty(current, key) ? current[key] : []
    return Array.isArray(value) ? value.map(rowOf) : []
  }
  const on = (event: string): ReadonlyArray<Row> => {
    const table = Predicate.hasProperty(current, "on") ? current.on : {}
    const rows = Predicate.hasProperty(table, event) ? table[event] : []
    return Array.isArray(rows) ? rows.map(rowOf) : []
  }
  const events = Object.keys(Predicate.hasProperty(current, "on") && Predicate.isObject(current.on) ? current.on : {})
  return { after: list("after"), always: list("always"), on, events }
}

const BUILDING = "task.live.work.building"

// --- a live supervisor on a simulated clock ---------------------------------------------------------------------------

// A building T1.1 and its task supervisor on `clock`, with the scripted bounds (stream idle 2 s).
const supervised = Effect.fnUntraced(function* (clock: SimulatedClock, turns: ReadonlyArray<Turn>) {
  const plan = yield* loadPlan("release-notes.spec")
  const f = facts()
  const setup = yield* runOf({ plan, directory: "/root", stored: [f.runStarted(plan.path), f.started("T1.1")], turns })
  const unit = unitOf(yield* setup.recorder.actor.getSnapshot, "T1.1")
  expect(unit.state).toBe("building")
  const task = plan.tasks.find((item) => item.id === "T1.1")
  if (task === undefined) throw new Error("no task T1.1")
  const actor = yield* createActor(TaskSupervisor.machine, {
    input: {
      run: setup.run,
      events: setup.events,
      task,
      spec: plan.spec,
      owner: `task:${setup.id}:T1.1`,
      entry: unit.entry,
      tags: unit.tags,
      session: "ses_T1.1",
      runStart: 0,
    } satisfies TaskSupervisor.Input,
    clock,
  })
  yield* actor.start
  return { setup, actor }
})

// --- the tests --------------------------------------------------------------------------------------------------------

it.live("[SV14] the inspection finds each construct in a planted source (negative control)", () =>
  Effect.sync(() => {
    const planted = parse(
      "planted.ts",
      [
        'import { Effect, MutableHashMap, Ref, Schedule, Stream } from "effect"',
        "let turns = 0",
        "var busy = false",
        "const map = new Map<string, number>()",
        "const owners = MutableHashMap.empty<string, string>()",
        "const cell = Ref.make(0)",
        "class Watch { seen = 0 }",
        "export const watch = Effect.gen(function* () {",
        "  while (true) { turns++ }",
        "  for (;;) {}",
        "  do {} while (true)",
        "  for (const item of [1]) { yield* Effect.sleep(10) }",
        "  yield* Effect.repeat(Effect.void, Schedule.spaced(10))",
        "  yield* Effect.forever(Effect.void)",
        "  yield* Stream.runDrain(Stream.tick(10))",
        "  setInterval(() => {}, 10)",
        "  setTimeout(() => {}, 10)",
        "})",
      ].join("\n"),
    )
    const found = scan([planted])
    for (const what of [
      "import MutableHashMap",
      "import Ref",
      "module-level let or var",
      "new Map",
      "MutableHashMap.empty",
      "Ref.make",
      "class Watch",
      "endless loop",
      "sleeping loop",
      "Effect.repeat",
      "Schedule.spaced",
      "Effect.forever",
      "Stream.tick",
      "setInterval",
      "setTimeout",
    ])
      expect(found).toContain(`planted.ts: ${what}`)
    // Two module-level mutables and three endless loops, each one found.
    expect(found.filter((item) => item === "planted.ts: module-level let or var")).toHaveLength(2)
    expect(found.filter((item) => item === "planted.ts: endless loop")).toHaveLength(3)
  }),
)

it.live(
  "[SV14] the session watch and the hooks hold no Ref, no MutableHashMap, no other mutable cell or keyed collection, no polled loop and no module-level let",
  () =>
    Effect.sync(() => {
      // The scan covers what it should: the whole of sessions.ts and hooks.ts, and every part of the watch actor.
      expect(watchPart.found).toEqual(WATCH.toSorted())
      expect(units.map((unit) => unit.source.statements.length).every((count) => count > 0)).toBe(true)
      expect(watchPart.unit.source.getFullText()).toContain("fromCallback")
      expect(scan(units)).toEqual([])
    }),
)

it.live(
  "[SV14] the phase-1 watch and hook state is gone: no builderTurn in the sessions module, no hook maps, take, watch or unwatch",
  () =>
    Effect.sync(() => {
      const sessions = Object.keys(TaskSessions)
      expect(sessions).not.toContain("builderTurn")
      // What is left of the session module: pure message builders, the session calls, and the spend-cap read.
      for (const name of ["create", "prompt", "cancel", "builderHistory", "spendCapError", "builderMessage"])
        expect(sessions).toContain(name)
      // The module's own namespace re-export (`export * as TaskSessions`) is the module itself, not a member.
      for (const name of sessions.filter((key) => key !== "TaskSessions")) {
        const value: unknown = Reflect.get(TaskSessions, name)
        expect({
          name,
          kind: typeof value === "function" || typeof value === "string" || value instanceof RegExp,
        }).toEqual({
          name,
          kind: true,
        })
      }
      expect(TaskSessions.SPEND_CAP.global).toBe(false)
      const hooks = Object.keys(TaskHooks)
      for (const name of ["ready", "verdicts", "repeated", "limits", "watch", "unwatch"])
        expect(hooks).not.toContain(name)
      expect(hooks.filter((name) => name.startsWith("take"))).toEqual([])
      // The hooks are functions over `HarnessHooks`, which the owner's context answers, and fixed names.
      for (const name of hooks.filter((key) => key !== "TaskHooks")) {
        const value: unknown = Reflect.get(TaskHooks, name)
        expect({ name, kind: typeof value === "function" || typeof value === "string" }).toEqual({ name, kind: true })
      }
      // The watch actor is an actor logic, created per turn; the workers keep none of its events.
      expect(Predicate.isObject(TaskWorkers.sessionEvents)).toBe(true)
    }),
)

it.live(
  "[SV14] in the task supervisor the stall is the delayed transition of the watched turn, and the spend cap and the idle end are guards",
  () =>
    Effect.sync(() => {
      const watching = nodeAt("live", "work", "building", "turn", "watching")
      const tool = nodeAt("live", "work", "building", "turn", "tool")
      const turn = nodeAt("live", "work", "building", "turn")
      const ended = nodeAt("live", "work", "building", "ended")
      // The stall: one delayed transition after streamIdle from the watched turn to stalling; any activity re-enters
      // the state, which starts the delay again; while a tool runs there is no delay at all.
      expect(watching.after).toEqual([
        {
          event: `xstate.after.streamIdle.${BUILDING}.turn.watching`,
          delay: "streamIdle",
          guard: undefined,
          target: [`${BUILDING}.stalling`],
        },
      ])
      expect(watching.on("turn.activity")).toEqual([
        { event: "turn.activity", guard: undefined, target: [`${BUILDING}.turn.watching`] },
      ])
      expect(tool.after).toEqual([])
      // The spend cap: the guard spendCap on a turn status, in the watched turn and while a tool runs, and the guard
      // capped when the turn ends; each goes to the state that records task.needs_human.
      expect(watching.on("turn.status")).toEqual([
        { event: "turn.status", guard: "spendCap", target: [`${BUILDING}.spendCap`] },
        { event: "turn.status", guard: undefined, target: [`${BUILDING}.turn.watching`] },
      ])
      expect(tool.on("turn.status")).toEqual([
        { event: "turn.status", guard: "spendCap", target: [`${BUILDING}.spendCap`] },
      ])
      // The idle end: the turn's worker is done, and the guards of `ended` decide, the spend cap first.
      const done = turn.events.filter((event) => event.startsWith("xstate.done.actor."))
      expect(done).toHaveLength(1)
      expect(turn.on(done[0] ?? "").map((row) => row.target)).toEqual([[`${BUILDING}.ended`]])
      expect(ended.always).toEqual([
        { event: "", guard: "capped", target: [`${BUILDING}.spendCap`] },
        { event: "", guard: "repeated", target: [`${BUILDING}.repeating`] },
        { event: "", guard: "readied", target: [`${BUILDING}.readying`] },
        { event: "", guard: "nudgeLeft", target: [`${BUILDING}.nudging`] },
        { event: "", guard: undefined, target: [`${BUILDING}.unready`] },
      ])
      // Each guard and the delay are implementations of the supervisor's own machine.
      const implementations: unknown = TaskSupervisor.machine.implementations
      const guards = Predicate.hasProperty(implementations, "guards") ? implementations.guards : {}
      const delays = Predicate.hasProperty(implementations, "delays") ? implementations.delays : {}
      for (const name of ["spendCap", "capped", "repeated", "readied", "nudgeLeft"])
        expect({ name, guard: Predicate.hasProperty(guards, name) && Predicate.isFunction(guards[name]) }).toEqual({
          name,
          guard: true,
        })
      expect(Predicate.hasProperty(delays, "streamIdle") && Predicate.isFunction(delays.streamIdle)).toBe(true)
    }),
)

it.live(
  "[SV14] a live supervisor stalls only when its own clock passes streamIdle, never as wall time passes",
  () =>
    Effect.gen(function* () {
      const clock = new SimulatedClock()
      const { setup, actor } = yield* supervised(clock, [hang])
      yield* prompted(setup.seen, 1)
      yield* eventually(
        Effect.map(actor.getSnapshot, (snapshot) =>
          snapshot.matches({ live: { work: { building: { turn: "watching" } } } }),
        ),
        "the builder turn is watched",
      )
      // Wall time past streamIdle (2 s) with the supervisor's clock still: no poll notices, nothing is recorded.
      yield* Effect.sleep(3_000)
      expect(yield* storedTypes(setup.id)).toEqual([])
      // Its clock just short of streamIdle: still nothing; at streamIdle: the delayed transition records the stall.
      yield* clock.increment(1_990)
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* clock.increment(10)
      yield* stored(setup.id, 1)
      expect(yield* storedFacts(setup.id)).toMatchObject([
        { type: "task.stalled", task: "T1.1", reason: "stall: no stream activity for 2 s" },
      ])
    }),
  90_000,
)

it.live(
  "[SV14] a live supervisor decides the idle end and the spend cap by its guards, with its clock still",
  () =>
    Effect.gen(function* () {
      // The idle end: the turn ends without task_ready; the nudge is recorded at once, with no time passing.
      const idleClock = new SimulatedClock()
      const idle = yield* supervised(idleClock, [() => Effect.void])
      yield* stored(idle.setup.id, 1)
      expect(yield* storedFacts(idle.setup.id)).toMatchObject([
        { type: "task.nudged", task: "T1.1", nudge: 1, reason: TaskWorkers.NO_READY },
      ])
      // The spend cap: a retry status that names it ends the watched turn at once, with no time passing.
      const capClock = new SimulatedClock()
      const capped = yield* supervised(capClock, [hang])
      yield* prompted(capped.setup.seen, 1)
      yield* eventually(
        Effect.map(capped.actor.getSnapshot, (snapshot) =>
          snapshot.matches({ live: { work: { building: { turn: "watching" } } } }),
        ),
        "the builder turn is watched",
      )
      yield* settle
      yield* capped.setup.events.publish(SessionStatus.Event.Status, {
        sessionID: SessionID.make("ses_T1.1"),
        status: { type: "retry", attempt: 1, message: "insufficient_quota", next: 0 },
      })
      yield* stored(capped.setup.id, 1)
      expect(yield* storedFacts(capped.setup.id)).toMatchObject([
        { type: "task.needs_human", task: "T1.1", reason: "spend cap: insufficient_quota" },
      ])
      // The Recorder stores first and folds second: the run actor then holds T1.1 waiting for a human.
      yield* eventually(
        Effect.map(
          capped.setup.recorder.actor.getSnapshot,
          (snapshot) => TaskEngineXState.unitState(snapshot, "T1.1") === "needs_human",
        ),
        "T1.1 needs a human",
      )
      // Neither needed the stall timer: no stall was recorded, and the clocks never moved.
      expect(yield* storedTypes(idle.setup.id)).toEqual(["task.nudged"])
      expect(yield* storedTypes(capped.setup.id)).toEqual(["task.needs_human"])
    }),
  90_000,
)
