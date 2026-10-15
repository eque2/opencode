import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import {
  type EventObject,
  assign,
  createActor,
  createMachine,
  initialTransition,
  raise,
  stateIn,
  transition,
} from "@jambudipa/xstate-effect"
import { getAdjacencyMap } from "@jambudipa/xstate-effect/graph"

// The port conformance test (spine "Stack"): the 2026-10-14 probes that the run machine relies on, run again on the
// pinned @jambudipa/xstate-effect. A port upgrade that changes one of them fails here, not in a run.
//
// - AD-1: `#id` targets and `stateIn` ids are split on `.`, so explicit ids replace `.` with `_`.
// - AD-2: a final state inside a parallel region still takes an event.
// - AD-4: an `onDone` target in a sibling region re-enters the parallel state and resets its children.
// - AD-6: a pure `transition` on a `done` snapshot still runs a microstep. A `stateIn` guard on an unknown id gives
//   an `error` snapshot in the initial macrostep, and a failed Effect (GuardError) in a pure `transition`.
// - AD-5: raised and done events carry no `at`.
// - AD-13: `snapshot.tags` is an array, and `snapshot.hasTag` works.
// - AD-3: an eventless oscillation fails with a `TransitionError` once `maxIterations` is passed.
// - AD-7: `getAdjacencyMap`'s `limit` counts dequeued edges, not keys (port `src/graph/adjacency.ts:72`), and its
//   options are required: `getAdjacencyMap(logic)` is a type error, so the walks always pass `{ ... }`.

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

// The `_tag` of the error an Exit failed with (EFX-34: assert failures by tag).
const failureTag = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "success"
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
  return typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "untagged"
}

describe("port conformance", () => {
  test("AD-1: an id with `/` and `_` resolves; a dotted `#id` target is split on `.`", () => {
    const machine = createMachine({
      type: "parallel",
      states: {
        a: { initial: "x", states: { x: { on: { go: "y" } }, y: { id: "T1_4/budget_exhausted" } } },
        b: {
          initial: "w",
          states: { w: { always: { guard: stateIn("#T1_4/budget_exhausted"), target: "z" } }, z: {} },
        },
      },
    })
    const [first] = run(initialTransition(machine))
    expect(run(transition(machine, first, { type: "go" }))[0].value).toEqual({ a: "y", b: "z" })

    const dotted = createMachine({
      initial: "a",
      states: { a: { on: { go: "#T1.4/x" } }, b: { id: "T1.4/x" } },
    })
    // The target names `T1` and the path `4/x`, not the node whose id is `T1.4/x`.
    const exit = Effect.runSyncExit(
      Effect.suspend(() => transition(dotted, run(initialTransition(dotted))[0], { type: "go" })),
    )
    const reached = Exit.isSuccess(exit) ? exit.value[0].value : "failed"
    expect(reached).not.toEqual("b")
  })

  test("AD-2: a final state inside a parallel region still takes an event", () => {
    const machine = createMachine({
      type: "parallel",
      states: {
        a: { initial: "done", states: { done: { type: "final", on: { reopen: "open" } }, open: {} } },
        b: { initial: "busy", states: { busy: {} } },
      },
    })
    const [first] = run(initialTransition(machine))
    expect(run(transition(machine, first, { type: "reopen" }))[0].value).toEqual({ a: "open", b: "busy" })
  })

  test("AD-4: an onDone target in a sibling region re-enters the parallel state and resets its children", () => {
    const machine = createMachine({
      type: "parallel",
      states: {
        active: {
          type: "parallel",
          onDone: { target: "#outcome/finished" },
          states: {
            u1: { initial: "a", states: { a: { on: { finish: "f" } }, f: { type: "final" } } },
            u2: { initial: "a", states: { a: { on: { move: "b" } }, b: { type: "final" } } },
          },
        },
        outcome: { initial: "running", states: { running: {}, finished: { id: "outcome/finished" } } },
      },
    })
    const [moved] = run(transition(machine, run(initialTransition(machine))[0], { type: "move" }))
    expect(moved.value).toEqual({ active: { u1: "a", u2: "b" }, outcome: "running" })
    // Every region of `active` is final: the onDone target exits and re-enters `active`, so u2 is back in `a`.
    const [finished] = run(transition(machine, moved, { type: "finish" }))
    expect(finished.value).toEqual({ active: { u1: "a", u2: "a" }, outcome: "finished" })
  })

  test("AD-6: a pure transition on a done snapshot still runs a microstep", () => {
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
    const [poked] = run(transition(machine, done, { type: "poke" }))
    expect(poked.status).toBe("done")
    expect(poked.context.count).toBe(1)
  })

  test("AD-5: a raised event and a done event carry no `at`", () => {
    const note = assign(
      ({
        context,
        event,
      }: {
        readonly context: { readonly seen: ReadonlyArray<string> }
        readonly event: EventObject
      }) => ({
        seen: [...context.seen, `${event.type} at=${"at" in event ? String(event.at) : "none"}`],
      }),
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
    const go = { type: "go", at: 5 }
    const [next] = run(transition(machine, run(initialTransition(machine))[0], go))
    expect(next.context.seen).toEqual(["go at=5", "inner at=none", "xstate.done.state.(machine).work at=none"])
  })

  test("AD-13: snapshot.tags is an array and hasTag works", () => {
    const machine = createMachine({ initial: "a", states: { a: { tags: ["T1.4:waiting", "T1.5:waits:T1.4"] } } })
    const [snapshot] = run(initialTransition(machine))
    expect(Array.isArray(snapshot.tags)).toBe(true)
    expect(snapshot.tags).toContain("T1.5:waits:T1.4")
    expect(snapshot.hasTag("T1.4:waiting")).toBe(true)
    expect(snapshot.hasTag("T1.4:active")).toBe(false)
  })

  test("AD-3: an eventless oscillation fails with a TransitionError past maxIterations", () => {
    const machine = createMachine({
      initial: "a",
      options: { maxIterations: 1000 },
      states: { a: { on: { go: "b" } }, b: { always: "c" }, c: { always: "b" } },
    })
    const exit = Effect.runSyncExit(transition(machine, run(initialTransition(machine))[0], { type: "go" }))
    expect(failureTag(exit)).toBe("TransitionError")
  })

  test("AD-6: a stateIn guard on an unknown id gives an error snapshot at start and a GuardError in a transition", () => {
    // In the initial macrostep the port catches the guard's failure into the snapshot: status `error`, no failed
    // Effect. A pure `transition` fails its Effect with a GuardError instead. `initial` and `apply` die on both.
    const atStart = createMachine({
      type: "parallel",
      states: {
        x: { initial: "a", states: { a: {} } },
        y: { initial: "w", states: { w: { always: { guard: stateIn("#nowhere/at_all"), target: "b" } }, b: {} } },
      },
    })
    expect(run(initialTransition(atStart))[0].status).toBe("error")
    const onEvent = createMachine({
      initial: "a",
      states: { a: { on: { go: { guard: stateIn("#nowhere/at_all"), target: "b" } } }, b: {} },
    })
    const viaEvent = Effect.runSyncExit(transition(onEvent, run(initialTransition(onEvent))[0], { type: "go" }))
    expect(failureTag(viaEvent)).toBe("GuardError")
    const eventless = createMachine({
      initial: "a",
      states: { a: { on: { go: "w" } }, w: { always: { guard: stateIn("#nowhere/at_all"), target: "b" } }, b: {} },
    })
    const viaEventless = Effect.runSyncExit(transition(eventless, run(initialTransition(eventless))[0], { type: "go" }))
    expect(failureTag(viaEventless)).toBe("GuardError")
  })

  test("AD-7: getAdjacencyMap accepts {} and its limit counts dequeued edges, not keys", () => {
    // Two states, each with two events that lead back to the two states: 2 keys, but 1 + 2 + 2 dequeued entries.
    const machine = createMachine({
      initial: "a",
      states: { a: { on: { x: "a", y: "b" } }, b: { on: { x: "a", y: "b" } } },
    })
    // Never called: the typecheck proves that the options are required.
    // @ts-expect-error getAdjacencyMap takes a required options argument.
    const noOptions = () => getAdjacencyMap(machine)
    expect(typeof noOptions).toBe("function")
    expect(Object.keys(run(getAdjacencyMap(machine, {})))).toHaveLength(2)
    expect(failureTag(Effect.runSyncExit(getAdjacencyMap(machine, { limit: 3 })))).toBe("TraversalLimitError")
    expect(Exit.isSuccess(Effect.runSyncExit(getAdjacencyMap(machine, { limit: 10 })))).toBe(true)
  })

  test("a live actor and the pure transition agree on a final parallel state that takes an event", async () => {
    const machine = createMachine({
      type: "parallel",
      states: {
        a: { initial: "done", states: { done: { type: "final", on: { reopen: "open" } }, open: {} } },
        b: { initial: "busy", states: { busy: {} } },
      },
    })
    const live = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const actor = yield* createActor(machine)
          yield* actor.start
          yield* actor.send({ type: "reopen" })
          return (yield* actor.getSnapshot).value
        }),
      ),
    )
    expect(live).toEqual(run(transition(machine, run(initialTransition(machine))[0], { type: "reopen" }))[0].value)
  })
})
