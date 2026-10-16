import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Duration, Effect, FileSystem } from "effect"
import path from "path"
import type { Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { ProofProcess } from "@/task/proof/process"
import { testEffect } from "../lib/effect"
import { delegate } from "./lib/delegate"
import { loadPlan, observed } from "./lib/machine"

// Scenario RM26 (spec task-harness-feedback, SD-2, SD-12, T1.12 and T1.13): the unchanged task-ui shows a phase-1
// blocked task with its cause.
//
//   Given the phase-1 status of the observed facts
//   When the task-ui of the checkpoint renders it on the Board
//   Then T1.5 and T1 sit in STOPPED with the label blocked
//   And each card shows "blocked by T1.4: budget exhausted"
//
// The checkpoint is the AC 7 merge of phase 1 into dev, c30fc83bb0. Phase 4 has changed the task-ui since, so the
// checkpoint's task-ui is taken from git: `git archive` of the checkpoint's packages/tui into a scoped temporary
// directory, with this tree's node_modules linked in. A TUI test, written into that copy, renders the checkpoint's
// own `BoardView` with the checkpoint's phase-1 status file, and the delegate helper runs it in a nested `bun test`
// (packages/opencode must not import the task-ui). The phase-1 status is the checkpoint's
// `packages/tui/test/task-ui/fixture-phase1.json`, which the checkpoint's core-status test required to be
// byte-equal to the phase-1 projection of the observed facts; this file also compares it with the engine's view of
// the observed facts. T2.3 moved the TUI's own RM26 test to the projected status: the last test runs that one on the
// task-ui of this tree.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const ROOT = path.resolve(import.meta.dir, "../../../..")
/** The AC 7 checkpoint: the merge of phase 1 of this goal into dev. */
const CHECKPOINT = "c30fc83bb07f2ca6586ce4c685fb0db42f4d1608"
const PHASE1 = "packages/tui/test/task-ui/fixture-phase1.json"
const REASON = "blocked by T1.4: budget exhausted"

const git = (args: ReadonlyArray<string>) =>
  ProofProcess.run("git", args, { cwd: ROOT, timeout: Duration.seconds(60), cancelDeadline: Duration.seconds(5) })

/** The output of a git command that must succeed. */
const gitOut = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const result = yield* git(args)
  expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 0 })
  return result.stdout
})

interface TaskRecord {
  readonly state: string
  readonly reason?: string
}
interface StatusFile {
  readonly run: { readonly state: string }
  readonly tasks: Readonly<Record<string, TaskRecord>>
}

const phaseOne = Effect.fnUntraced(function* () {
  const status: StatusFile = JSON.parse(yield* gitOut(["show", `${CHECKPOINT}:${PHASE1}`]))
  return status
})

// A TUI test for the checkpoint's copy of packages/tui: it renders the checkpoint's Board with the phase-1 status
// and reads each column's cards from the captured frame.
const CHECKPOINT_TEST = `/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Option, Result } from "effect"
import { createRoot } from "solid-js"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { createView, parse } from "../../src/task-ui/store"
import { BoardView } from "../../src/task-ui/designs/3-board"
import phase1 from "./fixture-phase1.json"

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none = { children: () => () => [], activity: () => () => [], all: () => () => [] }

// Each Board column of a frame: its heading, and the text inside each of its cards, line by line.
const columns = (frame: string) => {
  const lines = frame.split("\\n")
  const header = lines[0] ?? ""
  return [...header.matchAll(/[A-Z]+ \\d+/g)].map((match) => {
    const at = match.index ?? 0
    const cards: string[][] = []
    let card: string[] | undefined
    for (const line of lines.slice(1)) {
      if (line[at] === "╭") card = []
      else if (line[at] === "╰") {
        if (card) cards.push(card)
        card = undefined
      } else if (line[at] === "│" && card) card.push(line.slice(at + 1, line.indexOf("│", at + 1)).trim())
    }
    return { heading: match[0], cards }
  })
}

test("RM26 the checkpoint's Board shows T1.5 and T1 in STOPPED with the label blocked and their cause", async () => {
  const input = Option.getOrThrow(parse(JSON.stringify(phase1)))
  const props = createRoot(() => ({
    theme: () => theme,
    sessions: none,
    leader: "ctrl+x",
    view: createView({ status: () => input, now: () => 0, design: 3 }),
  }))
  const app = await testRender(() => <BoardView {...props} width={110} />, { width: 110, height: 40 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const board = columns(frame)
    expect(board.map((column) => column.heading)).toEqual([
      "WAITING 0",
      "BUILDING 0",
      "PROVING 0",
      "VERIFYING 0",
      "TRUSTED 3",
      "STOPPED 3",
    ])
    const stopped = board[5]
    for (const id of ["T1.5", "T1"]) {
      const card = stopped.cards.find((lines) => lines[0]?.endsWith(" " + id))
      expect({ id, card }).toMatchObject({ id, card: expect.any(Array) })
      // The card's state label is "blocked", and its lines carry the cause.
      expect(card?.[1]).toBe("blocked")
      expect(card?.join(" ")).toContain("${REASON}")
      // The card is in STOPPED only.
      for (const column of board.slice(0, 5))
        expect(column.cards.filter((lines) => lines[0]?.endsWith(" " + id))).toEqual([])
    }
  } finally {
    app.renderer.destroy()
  }
})
`

it.live("[RM26] the checkpoint is the phase-1 merge into dev, and it left the task-ui unchanged", () =>
  Effect.gen(function* () {
    expect((yield* gitOut(["log", "-1", "--format=%s", CHECKPOINT])).trim()).toBe(
      "Merge goal/task-harness-feedback: phase 1, one run machine",
    )
    // The merge put no change under the task-ui's sources on dev: the task-ui of the checkpoint is the unchanged one.
    const diff = yield* git(["diff", "--quiet", `${CHECKPOINT}^1`, CHECKPOINT, "--", "packages/tui/src/task-ui"])
    expect(diff.exitCode).toBe(0)
    // The phase-1 work it merged is in this branch.
    const ancestor = yield* git(["merge-base", "--is-ancestor", `${CHECKPOINT}^2`, "HEAD"])
    expect(ancestor.exitCode).toBe(0)
    // The checkpoint's core-status test wrote the phase-1 status file from the projection of the observed facts.
    const writer = yield* gitOut(["show", `${CHECKPOINT}:packages/opencode/test/task/core-status.test.ts`])
    expect(writer).toContain('"../../../tui/test/task-ui/fixture-phase1.json"')
    expect(writer).toContain("project(plan, observed(plan))")
  }),
)

it.live("[RM26] the phase-1 status of the observed facts has T1.5 and T1 blocked by T1.4 budget exhausted", () =>
  Effect.gen(function* () {
    const status = yield* phaseOne()
    for (const id of ["T1.5", "T1"]) expect(status.tasks[id]).toMatchObject({ state: "blocked", reason: REASON })
    expect(status.tasks["T1.4"]?.state).toBe("budget_exhausted")
    for (const id of ["T1.1", "T1.2", "T1.3"]) expect(status.tasks[id]?.state).toBe("trusted")
    // Each task's state and reason are the engine's view of the observed facts.
    const plan: Plan = yield* loadPlan("release-notes.spec")
    const view = engine.view(
      observed(plan).reduce((each, fact) => engine.apply(plan, each, fact), engine.initial(plan)),
    )
    const of = (tasks: Readonly<Record<string, TaskRecord>>) =>
      Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, { state: task.state, reason: task.reason }]))
    expect(of(status.tasks)).toEqual(of(view.tasks))
  }),
)

it.live(
  "[RM26] the checkpoint's task-ui renders it on the Board: T1.5 and T1 in STOPPED, labelled blocked, with their cause",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const copy = yield* fs.makeTempDirectoryScoped()
      const tar = path.join(copy, "checkpoint.tar")
      yield* gitOut(["archive", "--format=tar", "-o", tar, CHECKPOINT, "packages/tui"])
      const untar = yield* ProofProcess.run("tar", ["-xf", tar, "-C", copy], {
        cwd: copy,
        timeout: Duration.seconds(60),
        cancelDeadline: Duration.seconds(5),
      })
      expect(untar.exitCode).toBe(0)
      const tui = path.join(copy, "packages", "tui")
      // The copy resolves its packages from this tree's installs.
      yield* fs.symlink(path.join(ROOT, "node_modules"), path.join(copy, "node_modules"))
      yield* fs.symlink(path.join(ROOT, "packages", "tui", "node_modules"), path.join(tui, "node_modules"))
      // The copy's task-ui sources and phase-1 status are the checkpoint's.
      expect(yield* fs.readFileString(path.join(tui, "test", "task-ui", "fixture-phase1.json"))).toBe(
        yield* gitOut(["show", `${CHECKPOINT}:${PHASE1}`]),
      )
      expect(yield* fs.readFileString(path.join(tui, "src", "task-ui", "designs", "3-board.tsx"))).toBe(
        yield* gitOut(["show", `${CHECKPOINT}:packages/tui/src/task-ui/designs/3-board.tsx`]),
      )
      yield* fs.writeFileString(path.join(tui, "test", "task-ui", "verify-rm26-checkpoint.test.tsx"), CHECKPOINT_TEST)
      const report = yield* delegate(tui, "test/task-ui/verify-rm26-checkpoint.test.tsx", "RM26")
      expect(report.passed).toEqual([
        "RM26 the checkpoint's Board shows T1.5 and T1 in STOPPED with the label blocked and their cause",
      ])
    }),
  150_000,
)

it.live(
  "[RM26] the task-ui of this tree still shows the blocked T1.5 and T1 of the projected status in STOPPED with their cause (T2.3)",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // The projected status file is the projection of the observed facts: T1.5 and T1 blocked by T1.4.
      const projected: StatusFile = JSON.parse(
        yield* fs.readFileString(path.join(ROOT, "packages/tui/test/task-ui/fixture-projected.json")),
      )
      const plan: Plan = yield* loadPlan("release-notes.spec")
      const snapshot = observed(plan).reduce((each, fact) => engine.apply(plan, each, fact), engine.initial(plan))
      const now = TaskStatus.project(plan, snapshot)
      for (const id of ["T1.5", "T1"]) {
        expect(projected.tasks[id]).toMatchObject({ state: "blocked", reason: REASON })
        expect(now.tasks[id]).toMatchObject({ state: "blocked", reason: REASON })
      }
      const report = yield* delegate("packages/tui", "test/task-ui/task-ui.test.tsx", "RM26")
      expect(report.passed).toEqual([
        "RM26 the Board shows the blocked tasks of the projected status in STOPPED with their cause",
      ])
    }),
  150_000,
)
