import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Schema } from "effect"
import path from "path"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, observed, trustLeaf } from "./lib/machine"

// The AD-13 status contract (SV15, SV17): `status.json` is `project(plan, snapshot)`, read only from the snapshot's
// meta, tags and context and the plan's static text. The shared fixture is written by `write` with a fixed clock, and
// the TUI decodes the same file (`packages/tui/test/task-ui`). `UPDATE_FIXTURE=1` rewrites it.

const it = testEffect(NodeServices.layer)

const FIXTURE = path.resolve(import.meta.dir, "../../../tui/test/task-ui/fixture-projected.json")
const ALIVE_AT = 1_791_000_000_000

const fold = (plan: Plan, list: ReadonlyArray<Fact>) =>
  list.reduce((snapshot, fact) => TaskEngineXState.apply(plan, snapshot, fact), TaskEngineXState.initial(plan))

const project = (plan: Plan, list: ReadonlyArray<Fact>) => TaskStatus.project(plan, fold(plan, list))

const CLASS_TAGS = ["waiting", "active", "ended", "stopped", "blocked", "dead"]

// Every `tags` array in a status, with the key path it sits at.
const tagLists = (value: unknown, at = ""): Array<readonly [string, ReadonlyArray<unknown>]> => {
  if (Array.isArray(value)) return value.flatMap((item, index) => tagLists(item, `${at}[${index}]`))
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([name, item]) => [
    ...(name === "tags" && Array.isArray(item) ? [[`${at}.tags`, item] as const] : []),
    ...tagLists(item, `${at}.${name}`),
  ])
}

describe("the status contract (AD-13)", () => {
  it.live("projects the observed facts with every contract field", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const status = project(plan, observed(plan))
      expect(status.run).toMatchObject({
        state: "running",
        tags: ["active"],
        spec: "task-formats/blend/release-notes.spec",
        specId: "release-notes.spec",
        path: "task-formats/blend/release-notes.spec",
        title: plan.spec.title,
        startedAt: 1,
      })
      expect(status.run.endedAt).toBeUndefined()
      expect("aliveAt" in status.run).toBe(false)
      expect("task" in status.run).toBe(false)
      // A task: its class tags, waits, cause, times and spans.
      expect(status.tasks["T1.5"]).toMatchObject({
        state: "blocked",
        tags: ["ended", "stopped", "blocked"],
        attempts: 0,
        waitingOn: [],
        waitingOnOutside: [],
        reason: "blocked by T1.4: budget exhausted",
        blockedBy: { id: "T1.4", state: "budget_exhausted" },
      })
      expect(status.tasks["T1.5"]?.spans.map((span) => span.state)).toEqual(["waiting", "blocked"])
      expect(status.tasks["T1.4"]).toMatchObject({
        state: "budget_exhausted",
        tags: ["ended", "stopped", "dead"],
        attempts: 3,
      })
      expect(status.tasks["T1.4"]?.startedAt).toBeGreaterThan(0)
      expect(status.tasks["T1.4"]?.endedAt).toBeGreaterThan(status.tasks["T1.4"]?.startedAt ?? 0)
      expect(status.tasks["T1.1"]).toMatchObject({ state: "trusted", tags: ["ended"] })
      // An obligation: state, tags, times.
      expect(status.obligations["T1.1.c1"]).toMatchObject({ state: "trusted", tags: ["ended"] })
      expect(status.obligations["T1.4.c7"]).toMatchObject({ state: "failed", tags: ["active"] })
      // A scenario: the loader's title with no leading id; a parked one shows waiting.
      expect(status.scenarios["S13"]).toMatchObject({ state: "blocked", tags: ["ended", "stopped", "blocked"] })
      expect(status.scenarios["S2"]).toMatchObject({ state: "pending", tags: ["active"], waitingOn: [] })
      expect(status.scenarios["S2"]?.title).toBe(plan.scenarios.find((item) => item.id === "S2")?.title ?? "no title")
      expect(status.scenarios["S2"]?.title.startsWith("S2")).toBe(false)
      // The outside preconditions, and no external region in a whole-spec run.
      expect(status.outside).toEqual({
        T8: { state: "untrusted", tags: ["waiting"] },
        T9: { state: "untrusted", tags: ["waiting"] },
      })
      expect(status.external).toEqual({})
      expect(status.history.length).toBeGreaterThan(0)
    }),
  )

  it.live("tags each class as the AD-13 table says, in the AD-1 order, with no phase or waits tag", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const tasks = [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        ...trustLeaf(plan, f, "T1.2"),
        ...trustLeaf(plan, f, "T1.3"),
        ...trustLeaf(plan, f, "T1.4"),
        f.outside("T9"),
        f.started("T1.5"),
      ]
      const status = project(plan, tasks)
      // A parked scenario (S13 waits only on the outside T8) shows waiting.
      expect(status.scenarios["S13"]).toMatchObject({ state: "waiting", tags: ["waiting"], waitingOn: ["T8"] })
      expect(status.scenarios["S13"]?.waitingOnOutside).toEqual(["T8"])
      expect(status.tasks["T1.5"]).toMatchObject({ state: "building", tags: ["active"], waitingOn: [] })
      expect(status.run).toMatchObject({ state: "running", tags: ["active"] })
      for (const [where, list] of tagLists(status)) {
        expect({ where, unknown: list.filter((tag) => !CLASS_TAGS.includes(String(tag))) }).toEqual({
          where,
          unknown: [],
        })
        const order = list.map((tag) => CLASS_TAGS.indexOf(String(tag)))
        expect({ where, order }).toEqual({ where, order: order.toSorted((a, b) => a - b) })
      }
      const cancelled = project(plan, [f.runStarted(), f.cancelled("user stop")])
      expect(cancelled.run).toMatchObject({ state: "cancelled", tags: ["ended", "stopped"] })
      expect(cancelled.tasks["T1.1"]).toMatchObject({ state: "cancelled", tags: ["ended", "stopped"] })
    }),
  )

  it.live("lists waits only for a waiting unit, splits out the outside ones, and never writes a null", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const start = project(plan, [f.runStarted()])
      // T1.1 is ready (shown waiting) with nothing to wait on; T1.5 waits on tasks and on the outside T9.
      expect(start.tasks["T1.1"]).toMatchObject({ state: "waiting", tags: ["waiting"], waitingOn: [] })
      expect(start.tasks["T1.5"]).toMatchObject({ waitingOn: ["T1.3", "T1.4", "T9"], waitingOnOutside: ["T9"] })
      expect(start.scenarios["S13"]).toMatchObject({ waitingOn: ["T1.4", "T8"], waitingOnOutside: ["T8"] })
      const building = project(plan, [f.runStarted(), f.started("T1.1")])
      expect(building.tasks["T1.1"]).toMatchObject({ waitingOn: [], waitingOnOutside: [] })
      // An absent optional value is an absent key.
      const text = JSON.stringify(start)
      expect(text).not.toContain("null")
      expect("worktree" in (start.tasks["T1.1"] ?? {})).toBe(false)
      expect("blockedBy" in (start.tasks["T1.5"] ?? {})).toBe(false)
      expect("reason" in start.run).toBe(false)
    }),
  )

  it.live("names a subtree run's root task with its title, and its external regions", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec", "T1.5")
      const status = project(plan, [facts().runStarted()])
      const root = plan.spec.tasks.find((task) => task.id === "T1.5")
      expect(status.run.task).toEqual({ id: "T1.5", title: root?.title ?? "no title" })
      expect(status.external).toEqual({
        "T1.3": { state: "untrusted", tags: ["waiting"] },
        "T1.4": { state: "untrusted", tags: ["waiting"] },
      })
      expect(status.tasks["T1.5"]?.waitingOnOutside).toEqual(["T9"])
    }),
  )

  it.live("writes the refused form with its tags, spec id and title, and no records", () =>
    Effect.sync(() => {
      const status = TaskStatus.refused({
        spec: "task-formats/blend/release-notes.spec",
        path: "task-formats/blend/release-notes.spec",
        reason: "R7 .: cycle",
      })
      expect(status).toEqual({
        run: {
          state: "refused",
          tags: ["ended", "stopped"],
          reason: "R7 .: cycle",
          spec: "task-formats/blend/release-notes.spec",
          specId: "release-notes.spec",
          path: "task-formats/blend/release-notes.spec",
          title: "release-notes.spec",
        },
        tasks: {},
        obligations: {},
        scenarios: {},
        outside: {},
        external: {},
        history: [],
      })
      expect(TaskStatus.refused({ spec: "a.spec", path: "a.spec", reason: "R1", title: "A title" }).run.title).toBe(
        "A title",
      )
    }),
  )

  it.live("stamps aliveAt on write only, and keeps it through the encoder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const plan = yield* loadPlan("example-scenarios.spec")
      const status = project(plan, [facts().runStarted()])
      expect("aliveAt" in status.run).toBe(false)
      yield* TaskStatus.write(directory, status, ALIVE_AT)
      const file = path.join(directory, ".opencode", "task", "status.json")
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(yield* fs.readFileString(file))
      expect(decoded.run.aliveAt).toBe(ALIVE_AT)
      yield* TaskStatus.write(directory, status)
      const again = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(yield* fs.readFileString(file))
      expect(again.run.aliveAt).toBeUndefined()
    }),
  )

  it.live("SV17 writes the shared projected fixture of the observed facts, byte for byte", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const plan = yield* loadPlan("release-notes.spec")
      yield* TaskStatus.write(directory, project(plan, observed(plan)), ALIVE_AT)
      const written = yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))
      if (process.env.UPDATE_FIXTURE === "1") yield* fs.writeFileString(FIXTURE, written)
      expect(yield* fs.readFileString(FIXTURE)).toBe(written)
    }),
  )
})
