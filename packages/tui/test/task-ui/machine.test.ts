// The taskView machine (spine AD-16) on a SimulatedClock, with the feed's read replaced by a scripted one: what the
// view holds, each cadence, the stop key, the liveness rows, and the adapter to Solid.
import { describe, expect, test } from "bun:test"
import { Effect, Option, type Scope } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createActor, fromEffect, SimulatedClock } from "@jambudipa/xstate-effect"
import { createRoot } from "solid-js"
import { fromActor } from "../../src/task-ui/actor"
import { TaskView } from "../../src/task-ui/machine"

const NOW = 1_791_000_000_000

// A status text: tasks T1.1 (building) and T1.2 (waiting) unless given, with the run's tags and heartbeat.
const statusText = (run: { tags?: ReadonlyArray<string>; aliveAt?: number; state?: string } = {}, tasks?: object) =>
  JSON.stringify({
    run: { state: run.state ?? "running", spec: "s.spec", path: "s.spec", ...run },
    tasks: tasks ?? {
      "T1.1": { state: "building", tags: ["active"], attempts: 1, waitingOn: [] },
      "T1.2": { state: "waiting", tags: ["waiting"], attempts: 0, waitingOn: ["T1.1"] },
    },
    obligations: {},
    scenarios: {},
    history: [],
  })

// The invoked read finishes on its own fiber: let it settle before the next step reads the snapshot. A loaded machine
// runs that fiber late, so the wait is 20 ms, not the 5 ms an idle one needs.
const settle = Effect.promise(() => Bun.sleep(20))

type Step = TaskView.Read | "fail"
const file = (text: string, now = NOW): TaskView.Read => ({ exists: true, text, mtime: now, logs: [], now })
const gone = (now = NOW): TaskView.Read => ({ exists: false, text: "", mtime: 0, logs: [], now })

// The view actor with a read that answers each step in turn (the last one repeats), and the count of reads.
const view = (steps: ReadonlyArray<Step>, design = 1) =>
  Effect.gen(function* () {
    const reads = { count: 0 }
    const reader = fromEffect<{ directory: string }, TaskView.Read, Error, never>(() =>
      Effect.suspend(() => {
        const step = steps[Math.min(reads.count, steps.length - 1)] ?? gone()
        reads.count++
        return step === "fail" ? Effect.fail(new Error("EACCES: permission denied")) : Effect.succeed(step)
      }),
    )
    const clock = new SimulatedClock()
    const emitted: Array<string> = []
    const actor = yield* createActor(TaskView.machine.provide({ actors: { read: reader } }), {
      input: { directory: "/repo", design },
      clock,
    })
    yield* actor.start
    const snapshot = actor.getSnapshot
    const context = Effect.map(snapshot, (s) => s.context)
    const send = (event: TaskView.Event) => actor.send(event)
    const advance = (ms: number) => Effect.andThen(clock.increment(ms), settle)
    return { actor, reads, clock, emitted, snapshot, context, send, advance }
  })

const run = <A>(body: Effect.Effect<A, unknown, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

const stateOf = (value: unknown, region: string) =>
  typeof value === "object" && value !== null && region in value ? String(Reflect.get(value, region)) : ""

describe("the taskView machine (AD-16)", () => {
  test("UI2 holds the view state as context and takes every view event", () =>
    run(
      Effect.gen(function* () {
        const v = yield* view([file(statusText())], 3)
        expect(yield* v.context).toMatchObject({ design: 3, chosen: Option.none(), root: "", target: "" })
        yield* v.send({ type: "design.set", id: 5 })
        yield* v.send({ type: "design.cycle" })
        expect((yield* v.context).design).toBe(6)
        yield* v.send({ type: "select", id: "T1.2" })
        expect(TaskView.selected(yield* v.context)).toEqual(Option.some("T1.2"))
        yield* v.send({ type: "select.next" })
        expect(TaskView.selected(yield* v.context)).toEqual(Option.some("T1.1"))
        yield* v.send({ type: "select.previous" })
        expect(TaskView.selected(yield* v.context)).toEqual(Option.some("T1.2"))
        yield* v.send({ type: "select.nextRunning" })
        expect(TaskView.selected(yield* v.context)).toEqual(Option.some("T1.1"))
        yield* v.send({ type: "expand.toggle" })
        expect(stateOf((yield* v.snapshot).value, "expansion")).toBe("expanded")
        yield* v.send({ type: "expand.set", open: false })
        expect(stateOf((yield* v.snapshot).value, "expansion")).toBe("collapsed")
        yield* v.send({ type: "watch.toggle" })
        expect(stateOf((yield* v.snapshot).value, "watch")).toBe("on")
        yield* v.send({ type: "watch.target", session: "ses_builder", keep: false })
        yield* v.send({ type: "sessions.changed", owns: true, updated: 42 })
        yield* v.send({ type: "route.changed", session: "ses_child", parent: "ses_root" })
        expect(yield* v.context).toMatchObject({ target: "ses_builder", owns: true, updated: 42, root: "ses_root" })
        yield* v.send({ type: "route.changed", session: "ses_other" })
        expect((yield* v.context).root).toBe("ses_other")
      }),
    ))

  test("select.nextRunning and select.previousRunning step forward and back through three tasks in work, wrapping round", () =>
    run(
      Effect.gen(function* () {
        const working = statusText(
          {},
          {
            "T1.1": { state: "building", tags: ["active"], attempts: 1, waitingOn: [] },
            "T1.2": { state: "waiting", tags: ["waiting"], attempts: 0, waitingOn: ["T1.1"] },
            "T1.3": { state: "proving", tags: ["active"], attempts: 1, waitingOn: [] },
            "T1.4": { state: "verifying", tags: ["active"], attempts: 1, waitingOn: [] },
          },
        )
        const v = yield* view([file(working)])
        yield* settle
        const chosen = Effect.map(v.context, (context) => context.chosen)
        yield* v.send({ type: "select", id: "T1.1" })
        for (const id of ["T1.3", "T1.4", "T1.1"]) {
          yield* v.send({ type: "select.nextRunning" })
          expect(yield* chosen).toEqual(Option.some(id))
        }
        for (const id of ["T1.4", "T1.3", "T1.1"]) {
          yield* v.send({ type: "select.previousRunning" })
          expect(yield* chosen).toEqual(Option.some(id))
        }
        // From a task out of work: the next task in work after it, or the one before it.
        yield* v.send({ type: "select", id: "T1.2" })
        yield* v.send({ type: "select.nextRunning" })
        expect(yield* chosen).toEqual(Option.some("T1.3"))
        yield* v.send({ type: "select", id: "T1.2" })
        yield* v.send({ type: "select.previousRunning" })
        expect(yield* chosen).toEqual(Option.some("T1.1"))
      }),
    ))

  test("expansion and watch: each toggle flips, each set holds its value, and watch off clears the target", () =>
    run(
      Effect.gen(function* () {
        const v = yield* view([file(statusText())])
        yield* settle
        const region = (name: string) => Effect.map(v.snapshot, (snapshot) => stateOf(snapshot.value, name))
        const steps: ReadonlyArray<[TaskView.Event, string]> = [
          [{ type: "expand.toggle" }, "expanded"],
          [{ type: "expand.toggle" }, "collapsed"],
          [{ type: "expand.set", open: true }, "expanded"],
          [{ type: "expand.set", open: true }, "expanded"],
          [{ type: "expand.set", open: false }, "collapsed"],
          [{ type: "expand.set", open: false }, "collapsed"],
        ]
        for (const [event, state] of steps) {
          yield* v.send(event)
          expect({ event, state: yield* region("expansion") }).toEqual({ event, state })
        }
        const watches: ReadonlyArray<[TaskView.Event, string]> = [
          [{ type: "watch.toggle" }, "on"],
          [{ type: "watch.toggle" }, "off"],
          [{ type: "watch.set", on: true }, "on"],
          [{ type: "watch.set", on: true }, "on"],
          [{ type: "watch.set", on: false }, "off"],
          [{ type: "watch.set", on: false }, "off"],
        ]
        for (const [event, state] of watches) {
          yield* v.send(event)
          expect({ event, state: yield* region("watch") }).toEqual({ event, state })
        }
        yield* v.send({ type: "watch.toggle" })
        yield* v.send({ type: "watch.target", session: "ses_builder", keep: false })
        yield* v.send({ type: "watch.toggle" })
        expect((yield* v.context).target).toBe("")
      }),
    ))

  test("select.next and select.previous step one row forward and back through three rows, wrapping round", () =>
    run(
      Effect.gen(function* () {
        const three = statusText(
          {},
          {
            "T1.1": { state: "building", tags: ["active"], attempts: 1, waitingOn: [] },
            "T1.2": { state: "waiting", tags: ["waiting"], attempts: 0, waitingOn: ["T1.1"] },
            "T1.3": { state: "waiting", tags: ["waiting"], attempts: 0, waitingOn: ["T1.2"] },
          },
        )
        const v = yield* view([file(three)])
        yield* settle
        const selected = Effect.map(v.context, TaskView.selected)
        expect(yield* selected).toEqual(Option.some("T1.1"))
        yield* v.send({ type: "select.next" })
        expect(yield* selected).toEqual(Option.some("T1.2"))
        yield* v.send({ type: "select.next" })
        expect(yield* selected).toEqual(Option.some("T1.3"))
        yield* v.send({ type: "select.next" })
        expect(yield* selected).toEqual(Option.some("T1.1"))
        yield* v.send({ type: "select.previous" })
        expect(yield* selected).toEqual(Option.some("T1.3"))
        yield* v.send({ type: "select.previous" })
        expect(yield* selected).toEqual(Option.some("T1.2"))
      }),
    ))

  test("an unchanged status text read later takes the new clock, mtime and logs: a stopped heartbeat makes the view still", () =>
    run(
      Effect.gen(function* () {
        const text = statusText({ tags: ["active"], aliveAt: NOW })
        const later = [{ name: "T1.1", mtime: NOW + 15_000 }]
        const v = yield* view([
          file(text, NOW),
          { exists: true, text, mtime: NOW + 14_000, logs: later, now: NOW + 15_001 },
        ])
        yield* settle
        expect(stateOf((yield* v.snapshot).value, "liveness")).toBe("live")
        yield* v.advance(1_000)
        expect(yield* v.context).toMatchObject({ now: NOW + 15_001, mtime: NOW + 14_000, logs: later })
        expect(stateOf((yield* v.snapshot).value, "liveness")).toBe("still")
      }),
    ))

  test("keeps the read's mtime, proof logs and clock in the context", () =>
    run(
      Effect.gen(function* () {
        const logs = [
          { name: "T1.1", mtime: NOW - 400 },
          { name: "scenarios", mtime: NOW - 900 },
        ]
        const v = yield* view([{ exists: true, text: statusText(), mtime: NOW - 1_000, logs, now: NOW }])
        yield* settle
        expect(yield* v.context).toMatchObject({ mtime: NOW - 1_000, logs, now: NOW })
      }),
    ))

  test("reads the feed, rests 1 s and reads again; ticks the sessions, activity and tail cadences", () =>
    run(
      Effect.gen(function* () {
        const v = yield* view([file(statusText())])
        yield* settle
        expect(v.reads.count).toBe(1)
        expect(stateOf((yield* v.snapshot).value, "feed")).toBe("resting")
        yield* v.advance(999)
        expect(v.reads.count).toBe(1)
        yield* v.advance(1)
        expect(v.reads.count).toBe(2)
        // 1 000 ms so far: two tail ticks, none of the others.
        expect((yield* v.context).ticks).toEqual({ sessions: 0, activity: 0, tail: 2 })
        yield* v.advance(500)
        expect((yield* v.context).ticks).toEqual({ sessions: 0, activity: 1, tail: 3 })
        yield* v.advance(500)
        expect((yield* v.context).ticks).toEqual({ sessions: 1, activity: 1, tail: 4 })
      }),
    ))

  test("the stop key warns and arms, stops on the second press, and disarms after 5 s", () =>
    run(
      Effect.gen(function* () {
        const v = yield* view([file(statusText({ tags: ["active"], aliveAt: NOW }))])
        yield* v.actor.on("*", (event) => Effect.sync(() => v.emitted.push(event.type)))
        yield* v.send({ type: "stop.key" })
        expect(stateOf((yield* v.snapshot).value, "stopKey")).toBe("armed")
        yield* v.send({ type: "stop.key" })
        expect(stateOf((yield* v.snapshot).value, "stopKey")).toBe("disarmed")
        expect(v.emitted).toEqual(["stop.warn", "stop.run"])
        yield* v.send({ type: "stop.key" })
        yield* v.advance(4_999)
        expect(stateOf((yield* v.snapshot).value, "stopKey")).toBe("armed")
        yield* v.advance(1)
        expect(stateOf((yield* v.snapshot).value, "stopKey")).toBe("disarmed")
        expect(v.emitted).toEqual(["stop.warn", "stop.run", "stop.warn"])
      }),
    ))

  test("UI3 liveness: absent with no status, ended on the ended tag, live within 15 s of the heartbeat, else still", () =>
    run(
      Effect.gen(function* () {
        const liveness = (steps: ReadonlyArray<Step>) =>
          Effect.gen(function* () {
            const v = yield* view(steps)
            yield* settle
            return stateOf((yield* v.snapshot).value, "liveness")
          })
        expect(yield* liveness([gone()])).toBe("absent")
        expect(yield* liveness([file(statusText({ tags: ["ended"], aliveAt: NOW }))])).toBe("ended")
        expect(yield* liveness([file(statusText({ tags: ["active"], aliveAt: NOW - 15_000 }))])).toBe("live")
        expect(yield* liveness([file(statusText({ tags: ["active"], aliveAt: NOW - 15_001 }))])).toBe("still")
        // A new-format status with no heartbeat and no ended tag, and a file from before the tags.
        expect(yield* liveness([file(statusText({ tags: ["active"] }))])).toBe("still")
        expect(yield* liveness([file(statusText())])).toBe("still")
        expect(yield* liveness([file(statusText({ state: "refused", tags: ["ended", "stopped"] }))])).toBe("ended")
      }),
    ))

  test("a text that does not parse keeps the last status; a failed read rests and reads again; a gone file is absent", () =>
    run(
      Effect.gen(function* () {
        const good = statusText({ tags: ["active"], aliveAt: NOW })
        const v = yield* view([file(good), file("{"), "fail", gone()])
        yield* settle
        const first = (yield* v.context).status
        expect(Option.isSome(first)).toBe(true)
        yield* v.advance(1_000)
        expect((yield* v.context).status).toEqual(first)
        yield* v.advance(1_000)
        expect(v.reads.count).toBe(3)
        expect(stateOf((yield* v.snapshot).value, "feed")).toBe("resting")
        expect((yield* v.context).status).toEqual(first)
        yield* v.advance(1_000)
        expect(v.reads.count).toBe(4)
        expect((yield* v.context).status).toEqual(Option.none())
        expect(stateOf((yield* v.snapshot).value, "liveness")).toBe("absent")
      }),
    ))

  test("an input design that is not a design starts the view on design 1", () =>
    run(
      Effect.gen(function* () {
        for (const design of [0, 8, 9]) {
          const v = yield* view([file(statusText())], design)
          expect((yield* v.context).design).toBe(1)
        }
      }),
    ))

  test("watch off resets the target; a kept choice leaves it; design.cycle wraps 7 to 1; design.set 8 is ignored", () =>
    run(
      Effect.gen(function* () {
        const v = yield* view([file(statusText())], 7)
        yield* v.send({ type: "watch.set", on: true })
        yield* v.send({ type: "watch.target", session: "ses_builder", keep: false })
        yield* v.send({ type: "watch.target", session: "", keep: true })
        expect((yield* v.context).target).toBe("ses_builder")
        yield* v.send({ type: "watch.set", on: false })
        expect((yield* v.context).target).toBe("")
        yield* v.send({ type: "design.cycle" })
        expect((yield* v.context).design).toBe(1)
        yield* v.send({ type: "design.set", id: 8 })
        expect((yield* v.context).design).toBe(1)
      }),
    ))

  test("a chosen task the status lacks falls back to the focus task, not the first row; nextRunning with nothing running keeps it", () =>
    run(
      Effect.gen(function* () {
        // T1.1 ended, T1.2 in work, T1.3 waiting: the focus task is T1.2, the first row T1.1.
        const tasks = {
          "T1.1": { state: "trusted", tags: ["ended"], attempts: 1, waitingOn: [] },
          "T1.2": { state: "building", tags: ["active"], attempts: 1, waitingOn: [] },
          "T1.3": { state: "waiting", tags: ["waiting"], attempts: 0, waitingOn: ["T1.2"] },
        }
        const { "T1.3": _gone, ...without } = tasks
        const v = yield* view([file(statusText({}, tasks)), file(statusText({}, without))])
        yield* settle
        yield* v.send({ type: "select", id: "T9" })
        expect(TaskView.selected(yield* v.context)).toEqual(Option.some("T1.2"))
        yield* v.send({ type: "select", id: "T1.3" })
        expect(TaskView.selected(yield* v.context)).toEqual(Option.some("T1.3"))
        yield* v.advance(1_000)
        expect(TaskView.selected(yield* v.context)).toEqual(Option.some("T1.2"))
        const idle = statusText({}, { "T1.1": { state: "trusted", tags: ["ended"], attempts: 1, waitingOn: [] } })
        const w = yield* view([file(idle)])
        yield* settle
        yield* w.send({ type: "select", id: "T1.1" })
        yield* w.send({ type: "select.nextRunning" })
        expect((yield* w.context).chosen).toEqual(Option.some("T1.1"))
      }),
    ))

  test("the armed stop key disarms when the run stops being live or the route moves, with no stop", () =>
    run(
      Effect.gen(function* () {
        const live = statusText({ tags: ["active"], aliveAt: NOW })
        const v = yield* view([file(live), file(statusText({ state: "done", tags: ["ended"], aliveAt: NOW }))])
        yield* v.actor.on("*", (event) => Effect.sync(() => v.emitted.push(event.type)))
        yield* settle
        yield* v.send({ type: "stop.key" })
        yield* v.advance(1_000)
        expect(stateOf((yield* v.snapshot).value, "stopKey")).toBe("disarmed")
        yield* v.send({ type: "stop.key" })
        expect(v.emitted).toEqual(["stop.warn"])
        const w = yield* view([file(live)])
        yield* w.actor.on("*", (event) => Effect.sync(() => w.emitted.push(event.type)))
        yield* settle
        yield* w.send({ type: "stop.key" })
        yield* w.send({ type: "route.changed", session: "ses_other" })
        yield* w.send({ type: "stop.key" })
        expect(w.emitted).toEqual(["stop.warn", "stop.warn"])
      }),
    ))
})

describe("fromActor", () => {
  test("follows the actor's snapshots in one signal", () =>
    run(
      Effect.gen(function* () {
        const v = yield* view([file(statusText())], 2)
        const seen = createRoot((dispose) => ({ dispose, snapshot: fromActor(v.actor) }))
        expect(seen.snapshot().context.design).toBe(2)
        yield* v.send({ type: "design.set", id: 4 })
        yield* Effect.promise(() => Bun.sleep(10))
        expect(seen.snapshot().context.design).toBe(4)
        seen.dispose()
        // Once its owner is gone, the adapter follows nothing more.
        yield* v.send({ type: "design.set", id: 6 })
        yield* Effect.promise(() => Bun.sleep(10))
        expect(seen.snapshot().context.design).toBe(4)
      }),
    ))
})

describe("the feed's read", () => {
  test("reads the status text, its mtime and the proof logs, and gives no text for a missing file", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "task-view-"))
    try {
      expect(await Effect.runPromise(TaskView.read(directory))).toMatchObject({
        exists: false,
        text: "",
        mtime: 0,
        logs: [],
      })
      mkdirSync(path.join(directory, ".opencode/task/proofs"), { recursive: true })
      writeFileSync(path.join(directory, ".opencode/task/status.json"), statusText())
      writeFileSync(path.join(directory, ".opencode/task/proofs/T1.1.log"), "$ bun test\n")
      const got = await Effect.runPromise(TaskView.read(directory))
      expect(got).toMatchObject({ exists: true, text: statusText() })
      expect(got.mtime).toBeGreaterThan(0)
      expect(got.logs.map((log) => log.name)).toEqual(["T1.1"])
      expect(got.now).toBeGreaterThan(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
