import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { readFileSync } from "node:fs"
import path from "path"
import {
  type EventObject,
  assign,
  createMachine,
  initialTransition,
  raise,
  stateIn,
  transition,
} from "@jambudipa/xstate-effect"
import { getAdjacencyMap } from "@jambudipa/xstate-effect/graph"

// Scenario RM23 (spec task-harness-feedback, spine "Stack"; AD-1, AD-2, AD-4, AD-6, AD-5, AD-13, AD-3, AD-7): the port
// behaves as the spine relies on.
//
//   Given the pinned xstate port
//   When the 2026-10-14 probes run
//   Then a state id is split on dots, a final state inside a parallel region still takes events, and an onDone
//     target re-enters the region
//   And a pure transition on a done snapshot still runs a microstep, and raised and done events carry no time
//   And snapshot tags are an array, an eventless loop past the iteration cap fails, and the walk limit counts edges
//
// The unit under test is the port itself: each probe builds a small machine with the pinned
// @jambudipa/xstate-effect and runs it through the port's own `initialTransition`, `transition` and
// `getAdjacencyMap`. Each probe has a control beside it, so that it cannot pass for a reason other than the one it
// names.

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

/** The failure of an Exit: the `_tag` and message of its error or defect. */
const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return { tag: "success", message: "" }
  const error = Cause.squash(exit.cause)
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "untagged"
  return { tag, message: error instanceof Error ? error.message : String(error) }
}

const root = path.resolve(import.meta.dir, "../../../..")
const json = (file: string): { readonly [key: string]: unknown } => JSON.parse(readFileSync(file, "utf8"))

test("[RM23] the port is pinned: the root catalog names 0.2.0 exactly and the resolved package is 0.2.0", () => {
  const catalog = json(path.join(root, "package.json")).workspaces
  expect(catalog).toMatchObject({ catalog: { "@jambudipa/xstate-effect": "0.2.0" } })
  expect(json(path.join(root, "packages/opencode/package.json")).dependencies).toMatchObject({
    "@jambudipa/xstate-effect": "catalog:",
  })
  // The package that `import` resolves from this package.
  const entry = Bun.resolveSync("@jambudipa/xstate-effect", import.meta.dir)
  const resolved = json(path.join(path.dirname(entry), "..", "package.json"))
  expect({ name: resolved.name, version: resolved.version }).toEqual({
    name: "@jambudipa/xstate-effect",
    version: "0.2.0",
  })
})

test("[RM23] a state id is split on dots: #T1.4/x names the node T1 and the path 4/x; #T1_4/x resolves", () => {
  // Control: an id with `_` and `/` resolves as one id.
  const underscored = createMachine({ initial: "a", states: { a: { on: { go: "#T1_4/x" } }, b: { id: "T1_4/x" } } })
  expect(run(transition(underscored, run(initialTransition(underscored))[0], { type: "go" }))[0].value).toBe("b")

  // The same target with a dot: the port looks for a node whose id is `T1`.
  const dotted = createMachine({ initial: "a", states: { a: { on: { go: "#T1.4/x" } }, b: { id: "T1.4/x" } } })
  const exit = Effect.runSyncExit(
    Effect.suspend(() => transition(dotted, run(initialTransition(dotted))[0], { type: "go" })),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(failure(exit).message).toContain("'#T1' does not exist")
  // With a node whose id is T1, the dotted target reaches its child `4/x`, never the node whose id is `T1.4/x`.
  const split = createMachine({
    id: "T1",
    initial: "a",
    states: { a: { on: { go: "#T1.4/x" } }, "4/x": {}, b: { id: "T1.4/x" } },
  })
  expect(run(transition(split, run(initialTransition(split))[0], { type: "go" }))[0].value).toBe("4/x")

  // A `stateIn` guard is split the same way.
  const guarded = (id: string) =>
    createMachine({
      type: "parallel",
      states: {
        p: { initial: "x", states: { x: { id } } },
        q: { initial: "w", states: { w: { on: { go: { guard: stateIn(`#${id}`), target: "z" } } }, z: {} } },
      },
    })
  const plain = guarded("T1_4/x")
  expect(run(transition(plain, run(initialTransition(plain))[0], { type: "go" }))[0].value).toEqual({ p: "x", q: "z" })
  const dottedGuard = guarded("T1.4/x")
  const guardExit = Effect.runSyncExit(
    Effect.suspend(() => transition(dottedGuard, run(initialTransition(dottedGuard))[0], { type: "go" })),
  )
  expect(failure(guardExit)).toMatchObject({ tag: "GuardError" })
  expect(failure(guardExit).message).toContain("'#T1' does not exist")
})

test("[RM23] a final state inside a parallel region still takes events", () => {
  const machine = createMachine({
    type: "parallel",
    states: {
      a: { initial: "done", states: { done: { type: "final", on: { reopen: "open" } }, open: {} } },
      b: { initial: "busy", states: { busy: { on: { finish: "end" } }, end: { type: "final" } } },
    },
  })
  const start = run(initialTransition(machine))[0]
  expect(start.value).toEqual({ a: "done", b: "busy" })
  expect(start.status).toBe("active")
  const [reopened] = run(transition(machine, start, { type: "reopen" }))
  expect(reopened.value).toEqual({ a: "open", b: "busy" })
  // Control: the final region took the event while the machine stayed active.
  expect(reopened.status).toBe("active")
})

test("[RM23] an onDone target re-enters the parallel region and resets its children; onDone without a target does not", () => {
  const machine = (onDone: object) =>
    createMachine({
      type: "parallel",
      states: {
        active: {
          type: "parallel",
          onDone,
          states: {
            u1: { initial: "a", states: { a: { on: { finish: "f" } }, f: { type: "final" } } },
            u2: { initial: "a", states: { a: { on: { move: "b" } }, b: { type: "final" } } },
          },
        },
        outcome: { initial: "running", states: { running: {}, finished: { id: "outcome/finished" } } },
      },
    })
  const targeted = machine({ target: "#outcome/finished" })
  const [moved] = run(transition(targeted, run(initialTransition(targeted))[0], { type: "move" }))
  expect(moved.value).toEqual({ active: { u1: "a", u2: "b" }, outcome: "running" })
  const [settled] = run(transition(targeted, moved, { type: "finish" }))
  // Both regions were final; the target exits and re-enters `active`, so both are back in `a`.
  expect(settled.value).toEqual({ active: { u1: "a", u2: "a" }, outcome: "finished" })

  // Control: an onDone with only an action leaves the final children where they are.
  const untargeted = machine({ actions: assign({}) })
  const [movedToo] = run(transition(untargeted, run(initialTransition(untargeted))[0], { type: "move" }))
  const [ended] = run(transition(untargeted, movedToo, { type: "finish" }))
  expect(ended.value).toEqual({ active: { u1: "f", u2: "b" }, outcome: "running" })
})

test("[RM23] a pure transition on a done snapshot still runs a microstep", () => {
  const machine = createMachine({
    initial: "a",
    context: { count: 0 },
    states: {
      a: { on: { end: "z" } },
      z: { type: "final", on: { poke: { actions: assign(({ context }) => ({ count: context.count + 1 })) } } },
    },
  })
  const [done] = run(transition(machine, run(initialTransition(machine))[0], { type: "end" }))
  expect(done.status).toBe("done")
  expect(done.context.count).toBe(0)
  const [poked] = run(transition(machine, done, { type: "poke" }))
  // The done snapshot took the event: its action ran, and the snapshot is still done.
  expect(poked.context.count).toBe(1)
  expect(poked.status).toBe("done")
  expect(poked).not.toBe(done)
})

test("[RM23] raised and done events carry no time, while the event sent in does", () => {
  const note = assign(
    ({
      context,
      event,
    }: {
      readonly context: { readonly seen: ReadonlyArray<string> }
      readonly event: EventObject
    }) => ({ seen: [...context.seen, `${event.type} at=${"at" in event ? String(event.at) : "none"}`] }),
  )
  const machine = createMachine({
    type: "parallel",
    context: { seen: [] },
    states: {
      work: {
        initial: "a",
        onDone: { actions: note },
        states: {
          a: { on: { go: { target: "b", actions: [note, raise({ type: "inner" })] } } },
          b: { type: "final" },
        },
      },
      watch: { on: { inner: { actions: note } } },
    },
  })
  const [next] = run(transition(machine, run(initialTransition(machine))[0], { type: "go", at: 5 }))
  expect(next.context.seen).toEqual(["go at=5", "inner at=none", "xstate.done.state.(machine).work at=none"])
})

test("[RM23] snapshot tags are an array, not a Set, and hasTag reads them", () => {
  const machine = createMachine({
    type: "parallel",
    states: {
      x: { initial: "a", states: { a: { tags: ["T1.4:waiting", "T1.5:waits:T1.4"] } } },
      y: { initial: "b", states: { b: { tags: ["T1.5:waiting"] } } },
    },
  })
  const snapshot = run(initialTransition(machine))[0]
  expect(Array.isArray(snapshot.tags)).toBe(true)
  expect(snapshot.tags instanceof Set).toBe(false)
  expect([...snapshot.tags].toSorted()).toEqual(["T1.4:waiting", "T1.5:waiting", "T1.5:waits:T1.4"])
  expect(snapshot.hasTag("T1.5:waits:T1.4")).toBe(true)
  expect(snapshot.hasTag("T1.4:active")).toBe(false)
})

test("[RM23] an eventless loop past the iteration cap fails with a TransitionError; a shorter one does not", () => {
  // An endless oscillation between two eventless states.
  const oscillation = createMachine({
    initial: "a",
    options: { maxIterations: 1000 },
    states: { a: { on: { go: "b" } }, b: { always: "c" }, c: { always: "b" } },
  })
  const endless = Effect.runSyncExit(transition(oscillation, run(initialTransition(oscillation))[0], { type: "go" }))
  expect(failure(endless).tag).toBe("TransitionError")
  // A counted eventless loop: under the cap it settles; past it, it fails the same way.
  const counted = (steps: number) =>
    createMachine({
      initial: "a",
      context: { count: 0 },
      options: { maxIterations: 1000 },
      states: {
        a: { on: { go: "b" } },
        b: {
          always: {
            guard: ({ context }) => context.count < steps,
            actions: assign(({ context }) => ({ count: context.count + 1 })),
          },
        },
      },
    })
  const under = counted(900)
  const [settled] = run(transition(under, run(initialTransition(under))[0], { type: "go" }))
  expect(settled.context.count).toBe(900)
  const past = counted(1100)
  expect(failure(Effect.runSyncExit(transition(past, run(initialTransition(past))[0], { type: "go" }))).tag).toBe(
    "TransitionError",
  )
})

test("[RM23] the walk limit counts dequeued edges, not keys", () => {
  // Two states, each with two events back to the two states: 2 keys, 4 edges, 5 dequeued entries with the start.
  const pair = createMachine({
    initial: "a",
    states: { a: { on: { x: "a", y: "b" } }, b: { on: { x: "a", y: "b" } } },
  })
  expect(Object.keys(run(getAdjacencyMap(pair, {})))).toHaveLength(2)
  expect(Exit.isSuccess(Effect.runSyncExit(getAdjacencyMap(pair, { limit: 4 })))).toBe(true)
  expect(failure(Effect.runSyncExit(getAdjacencyMap(pair, { limit: 3 })))).toMatchObject({
    tag: "TraversalLimitError",
    message: "Traversal limit exceeded",
  })
  // A limit equal to the key count fails: the limit does not count keys.
  expect(failure(Effect.runSyncExit(getAdjacencyMap(pair, { limit: 2 }))).tag).toBe("TraversalLimitError")
  // One state with ten self-loops: 1 key, but 11 dequeued entries.
  const events = Array.from({ length: 10 }, (_, index) => `e${index}`)
  const loop = createMachine({
    initial: "s",
    states: { s: { on: Object.fromEntries(events.map((event) => [event, "s"])) } },
  })
  const all = events.map((type) => ({ type }))
  expect(Object.keys(run(getAdjacencyMap(loop, { events: all, limit: 10 })))).toHaveLength(1)
  expect(failure(Effect.runSyncExit(getAdjacencyMap(loop, { events: all, limit: 9 }))).tag).toBe("TraversalLimitError")
})
