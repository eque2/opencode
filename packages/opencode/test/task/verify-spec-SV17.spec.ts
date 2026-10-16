import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Exit, FileSystem, Layer, Option, Predicate, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Fact, Plan } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskView } from "../../../tui/src/task-ui/machine"
import { older, parse } from "../../../tui/src/task-ui/store"
import { testEffect } from "../lib/effect"
import { loadPlan, observed } from "./lib/machine"

// Scenario SV17 (spec task-harness-feedback, AD-13, D8, SD-10; tasks T2.3, T4.2): the TUI decodes the status file that
// the harness writes.
//
//   Given the shared status fixture written by the harness projection with a fixed clock
//   When the TUI decodes the fixture and a status file from before the change
//   Then both decode
//   And the fixture equals the projection of the observed facts byte for byte
//
// The shared fixture is packages/tui/test/task-ui/fixture-projected.json; the status file from before the change is
// packages/tui/test/task-ui/fixture-status.json, written by the harness before the AD-13 contract (it has none of the
// AD-13 fields: no tags, spec id, title, times, spans or outside regions; the test checks that). The observed facts
// are the release-notes run of the problem statement: T1.1 to T1.3 trusted, T1.4 budget exhausted after three
// attempts (`observed` in lib/machine).
//
// The harness side is the real code: a real Recorder resumes the observed facts on a clock fixed at the fixture's
// heartbeat, and its own status writer writes `status.json` with `TaskStatus.write`; and the projection of the observed
// facts through the engine API (`TaskEngineXState.initial`, `apply`) written by `TaskStatus.write` with the same clock.
// Each must equal the fixture byte for byte. The TUI side is the real task-ui code, imported by relative path: the
// store's `parse` on each file's text, and the real `taskView` actor, whose feed reads `<directory>/.opencode/task/
// status.json` from disk with its own `read` and decodes it with `parse`.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const UI_TESTS = path.resolve(import.meta.dir, "../../../tui/test/task-ui")
const FIXTURE = path.join(UI_TESTS, "fixture-projected.json")
const BEFORE = path.join(UI_TESTS, "fixture-status.json")
/** The fixed clock of the fixture: the heartbeat its writer stamped. */
const ALIVE_AT = 1_791_000_000_000

const statusPath = (directory: string) => path.join(directory, ".opencode", "task", "status.json")

const engineProjection = (plan: Plan, list: ReadonlyArray<Fact>) =>
  TaskStatus.project(
    plan,
    list.reduce((snapshot, fact) => TaskEngineXState.apply(plan, snapshot, fact), TaskEngineXState.initial(plan)),
  )

// Waits on the real timer (the test clock is fixed) until `ready` holds.
const until = Effect.fnUntraced(function* (ready: Effect.Effect<boolean>, what: string) {
  for (let tries = 0; tries < 1000; tries++) {
    if (yield* ready) return yield* Effect.void
    yield* Effect.promise(() => Bun.sleep(10))
  }
  return yield* Effect.die(new Error(`never: ${what}`))
})

// The unit ids of one map of a status file.
const keysOf = (raw: unknown, unit: string) => {
  const map = Predicate.hasProperty(raw, unit) ? raw[unit] : undefined
  return typeof map === "object" && map !== null ? Object.keys(map) : []
}

// The keys at every depth of a JSON value, as `a.b.c` paths (record keys of units collapsed to `*`).
const keyPaths = (value: unknown, at = ""): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${at}[]`))
  if (typeof value !== "object" || value === null) return []
  const units = ["tasks", "obligations", "scenarios", "outside", "external"]
  return Object.entries(value).flatMap(([name, item]) => {
    const here = units.includes(at.split(".").at(-1) ?? "") ? `${at}.*` : `${at}.${name}`
    return [here, ...keyPaths(item, here)]
  })
}

it.effect(
  "[SV17] the harness's own status writer, resuming the observed facts on the fixed clock, writes the shared fixture byte for byte",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const plan = yield* loadPlan("release-notes.spec")
      const events = yield* EventV2Bridge.Service
      // Given a clock fixed at the fixture's heartbeat, a Recorder that resumes the observed facts writes the run's
      // restored snapshot through its status writer.
      yield* TestClock.setTime(ALIVE_AT)
      const scope = yield* Scope.make()
      yield* TaskRecorder.make({
        plan,
        runID: "task_sv17fixture",
        directory,
        stored: observed(plan),
        events,
      }).pipe(Scope.provide(scope))
      yield* until(
        Effect.map(fs.readFileString(statusPath(directory)).pipe(Effect.orElseSucceed(() => "")), (text) =>
          text.endsWith("\n"),
        ),
        "the status writer wrote status.json",
      )
      yield* Scope.close(scope, Exit.void)
      const written = yield* fs.readFileString(statusPath(directory))
      // Then the fixture equals the file that the harness wrote, byte for byte.
      const fixture = yield* fs.readFileString(FIXTURE)
      expect(written).toBe(fixture)
      expect(Buffer.from(written).equals(Buffer.from(fixture))).toBe(true)
    }),
  60_000,
)

it.live(
  "[SV17] the fixture equals the projection of the observed facts through the engine API, written with the fixed clock, byte for byte",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const plan = yield* loadPlan("release-notes.spec")
      const projection = engineProjection(plan, observed(plan))
      // The projection holds the observed outcome: T1.4 budget exhausted, T1.5 and T1 blocked by it.
      expect(projection.tasks["T1.4"]).toMatchObject({ state: "budget_exhausted", attempts: 3 })
      expect(projection.tasks["T1.5"]).toMatchObject({ state: "blocked", blockedBy: { id: "T1.4" } })
      expect(projection.tasks["T1"]).toMatchObject({ state: "blocked" })
      expect("aliveAt" in projection.run).toBe(false)
      yield* TaskStatus.write(directory, projection, ALIVE_AT)
      const written = yield* fs.readFileString(statusPath(directory))
      const fixture = yield* fs.readFileString(FIXTURE)
      expect(written).toBe(fixture)
      expect(Buffer.from(written).equals(Buffer.from(fixture))).toBe(true)
    }),
  60_000,
)

it.live(
  "[SV17] the task-ui decodes the shared fixture and a status file from before the change, with its own parse",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixtureText = yield* fs.readFileString(FIXTURE)
      const beforeText = yield* fs.readFileString(BEFORE)
      const fixtureRaw: unknown = JSON.parse(fixtureText)
      const beforeRaw: unknown = JSON.parse(beforeText)
      // The file from before the change has none of the AD-13 fields; the fixture has them.
      const ad13 = [
        ".run.tags",
        ".run.specId",
        ".run.title",
        ".run.startedAt",
        ".run.aliveAt",
        ".tasks.*.tags",
        ".tasks.*.waitingOnOutside",
        ".tasks.*.spans",
        ".tasks.*.blockedBy",
        ".scenarios.*.title",
        ".scenarios.*.tags",
        ".obligations.*.tags",
        ".outside",
        ".external",
      ]
      const beforeKeys = keyPaths(beforeRaw)
      const fixtureKeys = keyPaths(fixtureRaw)
      expect(ad13.filter((key) => beforeKeys.includes(key))).toEqual([])
      expect(ad13.filter((key) => !fixtureKeys.includes(key))).toEqual([])

      // When the TUI decodes each file, then both decode.
      const fixture = parse(fixtureText)
      const before = parse(beforeText)
      expect(Option.isSome(fixture)).toBe(true)
      expect(Option.isSome(before)).toBe(true)
      if (Option.isNone(fixture) || Option.isNone(before)) return
      // Every value the TUI reads is the value in the file, and no unit is lost.
      expect(fixtureRaw).toMatchObject(fixture.value)
      expect(beforeRaw).toMatchObject(before.value)
      for (const [decoded, raw] of [
        [fixture.value, fixtureRaw],
        [before.value, beforeRaw],
      ] as const) {
        expect(Object.keys(decoded.tasks)).toEqual(keysOf(raw, "tasks"))
        expect(Object.keys(decoded.obligations)).toEqual(keysOf(raw, "obligations"))
        expect(Object.keys(decoded.scenarios)).toEqual(keysOf(raw, "scenarios"))
        expect(decoded.history.length).toBe(
          Predicate.hasProperty(raw, "history") && Array.isArray(raw.history) ? raw.history.length : -1,
        )
      }
      // The fixture decodes with its AD-13 fields; the older file decodes as an older harness's file.
      expect(fixture.value.run).toMatchObject({
        state: "running",
        tags: ["active"],
        specId: "release-notes.spec",
        title: "Release notes from conventional commits",
        aliveAt: ALIVE_AT,
      })
      expect(fixture.value.tasks["T1.5"]).toMatchObject({
        state: "blocked",
        tags: ["ended", "stopped", "blocked"],
        blockedBy: { id: "T1.4", state: "budget_exhausted" },
      })
      expect(fixture.value.outside).toEqual({
        T8: { state: "untrusted", tags: ["waiting"] },
        T9: { state: "untrusted", tags: ["waiting"] },
      })
      expect(older(fixture.value)).toBe(false)
      expect(older(before.value)).toBe(true)
      expect(before.value.run).toMatchObject({
        state: "budget_exhausted",
        spec: "task-formats/blend/release-notes.spec",
      })
      // A text that is not a status file does not decode, so the two results above are real decodes.
      expect(Option.isNone(parse("{}"))).toBe(true)
      expect(Option.isNone(parse(fixtureText.slice(0, fixtureText.length / 2)))).toBe(true)
    }),
  60_000,
)

it.live(
  "[SV17] the task-ui's view actor reads each file from status.json on disk and decodes it",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      for (const source of [FIXTURE, BEFORE]) {
        const text = yield* fs.readFileString(source)
        const directory = yield* fs.makeTempDirectoryScoped()
        yield* fs.makeDirectory(path.dirname(statusPath(directory)), { recursive: true })
        yield* fs.writeFileString(statusPath(directory), text)
        // The real taskView machine with its own feed `read`, on a clock that never moves, so it reads once.
        const scope = yield* Scope.make()
        const actor = yield* createActor(TaskView.machine, {
          input: { directory, design: 1 },
          clock: new SimulatedClock(),
        }).pipe(Scope.provide(scope))
        yield* actor.start
        yield* until(
          Effect.map(actor.getSnapshot, (snapshot) => Option.isSome(snapshot.context.status)),
          `the view decoded ${path.basename(source)}`,
        )
        const context = (yield* actor.getSnapshot).context
        yield* Scope.close(scope, Exit.void)
        // Then the file decodes: the view holds the same status the store's parse gives, read from disk.
        expect(context.text).toBe(text)
        expect(context.status).toEqual(parse(text))
        const status = Option.getOrThrow(context.status)
        expect(Object.keys(status.tasks).length).toBeGreaterThan(0)
        expect(status.run.spec).toBe("task-formats/blend/release-notes.spec")
      }
    }),
  60_000,
)
