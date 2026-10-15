import { Duration, Effect, FileSystem, Option, Schema } from "effect"
import path from "path"
import { Junit } from "@/task/proof/junit"
import { ProofProcess } from "@/task/proof/process"

// Runs named tests of another package from a packages/opencode test (SD-2): `packages/tui` does not export the
// task-ui, and packages/opencode must not import its sources, so a UI scenario test delegates to the TUI tests that
// prove it. The nested `bun test` writes a JUnit report; the delegate passes only when the run exits 0 and at
// least one named test passed. A skipped test does not count.

export class DelegateError extends Schema.TaggedError<DelegateError>()("TaskTestDelegateError", {
  message: Schema.String,
}) {}

const root = path.resolve(import.meta.dir, "../../../../..")

/**
 * Runs `bun test --timeout 30000 <file> -t <pattern>` in the package folder `pkg` (relative to the repository
 * root, or absolute) and returns the full titles of the tests that passed. The child runs as its own process group:
 * it is killed when it outlasts `timeout`, and when the caller is interrupted.
 */
export const delegate = Effect.fn("TaskTest.delegate")(function* (
  pkg: string,
  file: string,
  pattern: string,
  timeout: Duration.Input = Duration.seconds(110),
) {
  const fs = yield* FileSystem.FileSystem
  const cwd = path.isAbsolute(pkg) ? pkg : path.join(root, pkg)
  const report = path.join(yield* fs.makeTempDirectoryScoped(), "junit.xml")
  const run = `${file} -t ${pattern}`
  const result = yield* ProofProcess.run(
    process.execPath,
    ["test", "--timeout", "30000", file, "-t", pattern, "--reporter=junit", `--reporter-outfile=${report}`],
    { cwd, timeout, cancelDeadline: Duration.seconds(5) },
  ).pipe(Effect.mapError((error) => new DelegateError({ message: `${run}: ${error.message}` })))
  if (result.timedOut) return yield* new DelegateError({ message: `${run}: timed out` })
  const cases = Junit.parse(yield* fs.readFileString(report).pipe(Effect.orElseSucceed(() => "")))
  const output = `${result.stdout}\n${result.stderr}`
  const failed = cases.filter((test) => test.status === "failed")
  if (failed.length > 0) {
    const failures = Junit.consoleFailures(output)
    const lines = failed.map(
      (test) =>
        `${Junit.fullTitle(test)}: ${Option.getOrElse(Junit.messageOf(test, failures), () => test.failureText)}`,
    )
    return yield* new DelegateError({ message: `${run}: ${lines.join("\n")}` })
  }
  const passed = cases.filter((test) => test.status === "passed").map(Junit.fullTitle)
  if (passed.length === 0) return yield* new DelegateError({ message: `${run}: no test matched` })
  if (result.exitCode !== 0)
    return yield* new DelegateError({ message: `${run}: bun test exited ${result.exitCode}: ${output.slice(-2000)}` })
  return { passed }
})
