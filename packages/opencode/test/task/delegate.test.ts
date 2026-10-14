import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Duration, Effect, Exit, FileSystem } from "effect"
import path from "path"
import { testEffect } from "../lib/effect"
import { delegate } from "./lib/delegate"

// The delegate helper (SD-2): a scenario test in packages/opencode runs named tests of another package through a
// nested `bun test`, and passes only when that run exits 0 and at least one named test passed.

const it = testEffect(NodeServices.layer)

const NESTED = 120_000

// A package folder with one test file of each kind: passing, failing, skipped and hanging.
const tests = [
  'import { test, expect } from "bun:test"',
  'test("adds one and one", () => expect(1 + 1).toBe(2))',
  'test("breaks on purpose", () => expect(1 + 1).toBe(3))',
  'test.skip("is skipped on purpose", () => expect(true).toBe(true))',
  'test("hangs for ever", () => new Promise(() => {}), 60_000)',
].join("\n")

const folder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  yield* fs.writeFileString(path.join(dir, "sample.test.ts"), tests)
  return dir
})

const failure = <A, E>(exit: Exit.Exit<A, E>) => (Exit.isFailure(exit) ? String(exit.cause) : "no failure")

describe("delegate", () => {
  it.live(
    "runs named tests of the tui package and passes when one passed",
    () =>
      Effect.gen(function* () {
        const report = yield* delegate("packages/tui", "test/task-ui/task-ui.test.tsx", "RM26")
        expect(report.passed).toEqual(["RM26 the Board shows the phase-1 blocked tasks in STOPPED with their cause"])
      }),
    NESTED,
  )

  it.live(
    "fails when the pattern matches no test, and when the only match was skipped",
    () =>
      Effect.gen(function* () {
        const dir = yield* folder
        expect(failure(yield* Effect.exit(delegate(dir, "sample.test.ts", "matches nothing at all")))).toContain(
          "no test matched",
        )
        expect(failure(yield* Effect.exit(delegate(dir, "sample.test.ts", "is skipped")))).toContain("no test matched")
      }),
    NESTED,
  )

  it.live(
    "fails with the named test and its message when a named test fails",
    () =>
      Effect.gen(function* () {
        const dir = yield* folder
        const message = failure(yield* Effect.exit(delegate(dir, "sample.test.ts", "breaks on purpose")))
        expect(message).toContain("breaks on purpose")
        expect(message).toContain("expect(received).toBe(expected)")
        const passed = yield* delegate(dir, "sample.test.ts", "adds one")
        expect(passed.passed).toEqual(["adds one and one"])
      }),
    NESTED,
  )

  it.live(
    "stops a run that outlasts its timeout, and kills the child",
    () =>
      Effect.gen(function* () {
        const dir = yield* folder
        const started = Date.now()
        const message = failure(
          yield* Effect.exit(delegate(dir, "sample.test.ts", "hangs for ever", Duration.seconds(5))),
        )
        expect(message).toContain("timed out")
        expect(Date.now() - started).toBeLessThan(40_000)
      }),
    NESTED,
  )
})
