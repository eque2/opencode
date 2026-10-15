// The closing summary (T4.11: D18, AD-18, SD-18): the markdown the `summary` actor builds from the run's status, its
// stop and spec checks, and the run's usage; the run supervisor's last step; and the job that no longer carries an end
// message.
import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, Option } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Plan } from "@/task/core/model"
import { TaskHarness } from "@/task/core/harness"
import { TaskStatus } from "@/task/core/status"
import { TaskSummary } from "@/task/core/summary"
import { RunSupervisor } from "@/task/core/supervise/run"
import { TaskWorkers } from "@/task/core/workers"
import { testEffect } from "../lib/effect"
import { facts, fold, loadPlan, observed } from "./lib/machine"
import { eventually, runOf } from "./lib/supervise"

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

type Status = TaskStatus.Status
type Mutable = { -readonly [K in keyof Status]: Status[K] }

// The observed release-notes run (T1.1–T1.3 trusted, T1.4 exhausted, T1 and T1.5 blocked), changed by `change`.
const statusOf = (plan: Plan, change: (status: Mutable) => void = () => {}): Status => {
  const status: Mutable = structuredClone(TaskStatus.project(plan, fold(plan, observed(plan))))
  change(status)
  return status
}

const REJECTED = "the test checks <h2> only | and *bold* `code` [link] _under_ \\ back"

// The run of the EXPERIENCE mock: budget exhausted after 24m 10s; S1–S3 trusted, S4 rejected, S13 parked on the
// outside T8, the rest blocked by T1.4; durations on each task that started.
const ended = (plan: Plan) =>
  statusOf(plan, (status) => {
    Object.assign(status.run, {
      state: "budget_exhausted",
      tags: ["ended", "stopped"],
      reason: "T1.4 budget exhausted\nT1 blocked by T1.4\nT1.5 blocked by T1.4",
      startedAt: 0,
      endedAt: 1_450_000,
    })
    const times: Record<string, [number, number]> = {
      "T1.1": [0, 182_000],
      "T1.2": [0, 160_000],
      "T1.3": [0, 312_000],
      "T1.4": [0, 400_000],
    }
    for (const [id, [startedAt, endedAt]] of Object.entries(times))
      Object.assign(status.tasks[id] ?? {}, { startedAt, endedAt })
    for (const [id, scenario] of Object.entries(status.scenarios)) {
      const number = Number(id.slice(1))
      if (number <= 3)
        Object.assign(scenario, { state: "trusted", tags: ["ended"], waitingOn: [], waitingOnOutside: [] })
      else if (number === 4)
        Object.assign(scenario, { state: "rejected", tags: ["ended", "stopped"], reason: REJECTED, waitingOn: [] })
      else if (number === 13)
        Object.assign(scenario, { state: "waiting", tags: ["waiting"], waitingOn: ["T8"], waitingOnOutside: ["T8"] })
      else
        Object.assign(scenario, {
          state: "blocked",
          tags: ["ended", "stopped", "blocked"],
          reason: "blocked by T1.4: budget exhausted",
          waitingOn: [],
        })
    }
  })

const spent = { tokens: 1_400_000, cost: 2.31 }
const none = Option.none<TaskSummary.Stop>()

describe("the closing summary's markdown (D18, UI7)", () => {
  it.live("summary: holds the outcome, counts, stopped tasks, failed scenarios, not run, warning and task table", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const status = ended(plan)
      const s4 = status.scenarios["S4"]?.title ?? ""
      const s13 = status.scenarios["S13"]?.title ?? ""
      expect(TaskSummary.markdown({ plan, status, stop: none, warned: true, usage: spent })).toBe(
        [
          "Spec **Release notes from conventional commits** — budget exhausted",
          "",
          "Tasks 3/6 trusted · 1 budget exhausted · 2 blocked · Scenarios 3/13 trusted · 1 rejected · 8 blocked · 1 not run · 24m 10s · 1.4M tokens · $2.31",
          "",
          "**Stopped**",
          "",
          "- ⊘ **T1.4** budget exhausted after 3 attempts · 6m 40s",
          "  T1.4.c7: the test asserts only that 'topic change' appears",
          "- ⊖ **T1**, **T1.5** blocked by T1.4: budget exhausted",
          "",
          "**Scenarios that did not pass**",
          "",
          `- ✗ **S4** rejected · ${s4}`,
          "  the test checks \\<h2\\> only \\| and \\*bold\\* \\`code\\` \\[link\\] \\_under\\_ \\\\ back",
          "",
          "**Not run**",
          "",
          `- ○ **S13** ${s13} — waiting on T8 (outside)`,
          "",
          "The spec stopped validating during the run. The run kept the plan it loaded.",
          "",
          "**Tasks**",
          "",
          "| Task | State | Attempts | Time |",
          "|---|---|---|---|",
          "| T1 | blocked | 0 | — |",
          "| T1.1 | trusted | 1 | 3m 2s |",
          "| T1.2 | trusted | 1 | 2m 40s |",
          "| T1.3 | trusted | 1 | 5m 12s |",
          "| T1.4 | budget exhausted | 3 | 6m 40s |",
          "| T1.5 | blocked | 0 | — |",
        ].join("\n"),
      )
    }),
  )

  it.live("summary: the outcome line follows the outcome rules, in the AC 4 order (UI20, SD-18)", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const head = (status: Status, stop: Option.Option<TaskSummary.Stop> = none) =>
        TaskSummary.markdown({ plan, status, stop, warned: false, usage: spent }).split("\n")[0]
      const allTrusted = (status: Mutable) => {
        for (const task of Object.values(status.tasks))
          Object.assign(task, { state: "trusted", tags: ["ended"], reason: undefined, blockedBy: undefined })
      }
      const cancelled = { state: "cancelled" as const, reason: "user stop\nsecond line" }
      // A cancel with no dead task: the stop's state and its first reason line.
      const cancel = statusOf(plan, (status) => {
        allTrusted(status)
        Object.assign(status.run, { state: "cancelled", tags: ["ended", "stopped"], reason: "user stop\nsecond line" })
      })
      expect(head(cancel, Option.some(cancelled))).toBe(
        "Spec **Release notes from conventional commits** — cancelled: user stop",
      )
      // A cancel after a dead task, and a dead task: the dead task's state (AC 4).
      const dead = statusOf(plan, (status) =>
        Object.assign(status.run, { state: "budget_exhausted", tags: ["ended", "stopped"] }),
      )
      expect(head(dead, Option.some(cancelled))).toBe(
        "Spec **Release notes from conventional commits** — budget exhausted",
      )
      expect(head(dead)).toBe("Spec **Release notes from conventional commits** — budget exhausted")
      // A rejected scenario with every task trusted: acceptance not proved (owner ruling 1).
      const rejected = statusOf(plan, (status) => {
        allTrusted(status)
        Object.assign(status.run, { state: "failed", tags: ["ended", "stopped"] })
        for (const scenario of Object.values(status.scenarios))
          Object.assign(scenario, { state: "trusted", tags: ["ended"] })
        Object.assign(status.scenarios["S4"] ?? {}, { state: "rejected", tags: ["ended", "stopped"], reason: "weak" })
      })
      expect(head(rejected)).toBe("Spec **Release notes from conventional commits** — failed: acceptance not proved")
      // Done, with one parked scenario; rule 3 with one adds it too.
      const done = statusOf(plan, (status) => {
        allTrusted(status)
        Object.assign(status.run, { state: "done", tags: ["ended"] })
        for (const scenario of Object.values(status.scenarios))
          Object.assign(scenario, { state: "trusted", tags: ["ended"] })
        Object.assign(status.scenarios["S13"] ?? {}, { state: "waiting", tags: ["waiting"], waitingOn: ["T8"] })
      })
      expect(head(done)).toBe("Spec **Release notes from conventional commits** — done · 1 scenario not run")
      const parked = statusOf(plan, (status) => {
        allTrusted(status)
        Object.assign(status.run, { state: "failed", tags: ["ended", "stopped"] })
        for (const scenario of Object.values(status.scenarios))
          Object.assign(scenario, { state: "trusted", tags: ["ended"] })
        Object.assign(status.scenarios["S4"] ?? {}, { state: "rejected", tags: ["ended", "stopped"], reason: "weak" })
        for (const id of ["S12", "S13"])
          Object.assign(status.scenarios[id] ?? {}, { state: "waiting", tags: ["waiting"], waitingOn: ["T8"] })
      })
      expect(head(parked)).toBe(
        "Spec **Release notes from conventional commits** — failed: acceptance not proved · 2 scenarios not run",
      )
      // A subtree run names its task first.
      const subtree = statusOf(plan, (status) => {
        allTrusted(status)
        Object.assign(status.run, {
          state: "done",
          tags: ["ended"],
          task: { id: "T1.2", title: "Compute the next version" },
        })
        for (const scenario of Object.values(status.scenarios))
          Object.assign(scenario, { state: "trusted", tags: ["ended"] })
      })
      expect(head(subtree)).toBe(
        "**T1.2 Compute the next version** from spec **Release notes from conventional commits** — done",
      )
    }),
  )

  it.live(
    "summary: a clean run leaves the empty sections out; a reason's newlines become spaces and are never cut",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const clean = statusOf(plan, (status) => {
          for (const task of Object.values(status.tasks))
            Object.assign(task, { state: "trusted", tags: ["ended"], reason: undefined, blockedBy: undefined })
          Object.assign(status.run, { state: "done", tags: ["ended"], startedAt: 0, endedAt: 45_000 })
          Object.assign(status, { scenarios: {} })
        })
        const text = TaskSummary.markdown({
          plan,
          status: clean,
          stop: none,
          warned: false,
          usage: { tokens: 0, cost: 0 },
        })
        expect(text.split("\n").slice(0, 3)).toEqual([
          "Spec **Release notes from conventional commits** — done",
          "",
          // No scenario part when the run has none; no usage before a session reports tokens.
          "Tasks 6/6 trusted · 45s",
        ])
        for (const section of ["**Stopped**", "**Scenarios that did not pass**", "**Not run**", "stopped validating"])
          expect({ section, found: text.includes(section) }).toEqual({ section, found: false })
        expect(text).toContain("**Tasks**")
        const long = "x".repeat(300)
        const multiline = statusOf(plan, (status) =>
          Object.assign(status.tasks["T1.4"] ?? {}, { reason: `first line\nsecond ${long}` }),
        )
        expect(TaskSummary.markdown({ plan, status: multiline, stop: none, warned: false, usage: spent })).toContain(
          `  first line second ${long}`,
        )
        // A free model that spent tokens shows $0.00.
        expect(
          TaskSummary.markdown({ plan, status: clean, stop: none, warned: false, usage: { tokens: 61_000, cost: 0 } }),
        ).toContain("Tasks 6/6 trusted · 45s · 61.0K tokens · $0.00")
      }),
  )

  test("summary: the usage sums the input, output and reasoning tokens and the cost of the run's sessions; no cache", () => {
    const session = (input: number, output: number, reasoning: number, cost?: number) => ({
      tokens: { input, output, reasoning, cache: { read: 1_000_000, write: 1_000_000 } },
      ...(cost === undefined ? {} : { cost }),
    })
    expect(TaskSummary.usage([session(1000, 200, 50, 0.5), session(100, 20, 5, 0.25), {}])).toEqual({
      tokens: 1375,
      cost: 0.75,
    })
    expect(TaskSummary.usage([])).toEqual({ tokens: 0, cost: 0 })
  })

  test("summary: model text is escaped for CommonMark (EDGE-11)", () => {
    expect(TaskSummary.escape("Type 'Promise<void>' | x")).toBe("Type 'Promise\\<void\\>' \\| x")
    expect(TaskSummary.escape("a\\b*c_d`e[f]g")).toBe("a\\\\b\\*c\\_d\\`e\\[f\\]g")
  })
})

describe("the run supervisor's closing summary (AD-18, UI7, UI23, UI24)", () => {
  it.live("summary: when the run is done the supervisor frees the lease, then says the summary once, then closes", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = { plan, ...(yield* runOf({ plan, directory: "/root", stored: [facts().runStarted()] })) }
      const order: string[] = []
      const said: Array<{ sessionID: string; text: string }> = []
      Object.assign(setup.run.env.ops, {
        say: (input: { sessionID: string; text: string }) =>
          Effect.sync(() => {
            said.push(input)
            order.push("say")
          }),
      })
      const harness = yield* TaskHarness.make
      yield* harness.spawnRun(setup.id, RunSupervisor.machine, {
        run: setup.run,
        events: setup.events,
        resumed: false,
        path: plan.path,
        trusts: Effect.succeed([]),
        externals: [],
        release: Effect.sync(() => void order.push("release")),
        writer: setup.recorder.writer,
      })
      yield* eventually(
        Effect.map(setup.recorder.actor.getSnapshot, () => true),
        "the run actor",
      )
      yield* TaskWorkers.record(setup.run, { type: "run.cancelled", reason: "user stop" })
      yield* RunSupervisor.awaitClosed(harness, setup.id).pipe(Effect.timeout(20_000))
      expect(order).toEqual(["release", "say"])
      expect(said).toHaveLength(1)
      expect(said[0]?.sessionID).toBe(setup.run.root)
      expect(said[0]?.text).toStartWith("Spec **Release notes from conventional commits** — cancelled: user stop")
      // No model turn: the summary is said, never prompted.
      expect(setup.seen.prompts).toEqual([])
    }),
  )

  it.live("summary: UI23 a say that fails is logged; the supervisor still closes and the lease is free", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = { plan, ...(yield* runOf({ plan, directory: "/root", stored: [facts().runStarted()] })) }
      Object.assign(setup.run.env.ops, { say: () => Effect.fail(new Error("the root session is gone")) })
      const messages: unknown[] = []
      let released = 0
      yield* Effect.gen(function* () {
        const harness = yield* TaskHarness.make
        yield* harness.spawnRun(setup.id, RunSupervisor.machine, {
          run: setup.run,
          events: setup.events,
          resumed: false,
          path: plan.path,
          trusts: Effect.succeed([]),
          externals: [],
          release: Effect.sync(() => void released++),
          writer: setup.recorder.writer,
        })
        yield* TaskWorkers.record(setup.run, { type: "run.cancelled", reason: "user stop" })
        yield* RunSupervisor.awaitClosed(harness, setup.id).pipe(Effect.timeout(20_000))
      }).pipe(
        Effect.provide(Logger.layer([Logger.make<unknown, void>((options) => void messages.push(options.message))])),
      )
      expect(released).toBe(1)
      expect(JSON.stringify(messages)).toContain("the closing summary could not be written")
    }),
  )

  it.live(
    "summary: a cancel that outlasts the deadline drops the summary waiting on a turn, logs it, and the lease is free",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const setup = { plan, ...(yield* runOf({ plan, directory: "/root", stored: [facts().runStarted()] })) }
        // The root's turn never ends, so the summary waits behind it.
        Object.assign(setup.run.env.ops, { say: () => Effect.never })
        const messages: unknown[] = []
        let released = 0
        yield* Effect.gen(function* () {
          const harness = yield* TaskHarness.make
          yield* harness.spawnRun(setup.id, RunSupervisor.machine, {
            run: setup.run,
            events: setup.events,
            resumed: false,
            path: plan.path,
            trusts: Effect.succeed([]),
            externals: [],
            release: Effect.sync(() => void released++),
            writer: setup.recorder.writer,
          })
          yield* RunSupervisor.cancel(harness, setup.run).pipe(Effect.timeout(20_000))
        }).pipe(
          Effect.provide(Logger.layer([Logger.make<unknown, void>((options) => void messages.push(options.message))])),
        )
        expect(released).toBe(1)
        expect(JSON.stringify(messages)).toContain("the closing summary was dropped")
      }),
  )
})

describe("the job of a run", () => {
  test("summary: the background job's output no longer carries an end message", async () => {
    const command = await Bun.file(path.join(import.meta.dir, "../../src/task/core/command.ts")).text()
    expect(command).not.toContain("ended ${state}")
    expect(command).toContain('Effect.as("")')
  })
})
