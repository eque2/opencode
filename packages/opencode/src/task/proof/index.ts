import { join } from "node:path"
import { Array as Arr, Clock, Duration, Effect, FileSystem, Option, Random, Schema } from "effect"
import type {
  Obligation as BlendObligation,
  Proof as BlendProof,
  Scenario as BlendScenario,
  Spec as BlendSpec,
  Task as BlendTask,
} from "@/task/blend"
import type { TaskLimits } from "@/task/limits"
import { Junit } from "./junit"
import { ProofProcess } from "./process"

// The shared proof runner. Every harness option turns a builder's "ready" into proof results through
// this module, so the options differ only in their harness design. It runs the proofs of one task (or
// one scenario) in a working tree between two commits and returns one result for each obligation, with
// the evidence that the spec policy asks for.
//
// The working tree must be the repository root: the touches, the `unchanged` paths and the paths that
// git reports are all relative to it. The working tree must hold the `head` commit.

export { killGroup, run, SpawnError, timedOutExitCode } from "./process"
export type { Bounds, Options, Result } from "./process"

// The fields of the blend model (`@/task/blend`) that the runner reads. A whole `Spec`, `Task`,
// `Obligation` or `Scenario` of the blend model fits each of them.

/** The proof of an obligation, normalised by the blend parser. */
export type Proof = BlendProof

export type ProofKind = Proof["kind"]

/** An obligation: its qualified id (for example `T2.2.c6`), its task and its proof. */
export type Obligation = Pick<BlendObligation, "id" | "task" | "proof">

/** A task: its id, its touches and the gates that must pass at its final commit. */
export type Task = Pick<BlendTask, "id" | "touches" | "gates">

/** A spec: its gates and the obligations of all its tasks. */
export interface Spec {
  readonly gates: BlendSpec["gates"]
  readonly obligations: ReadonlyArray<Obligation>
}

/** A scenario: its id, for example `S25`. Its tests carry the title tag `[S25]`. */
export type Scenario = Pick<BlendScenario, "id">

/** The result of one title tag. */
export type TagResult =
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "skipped" }

/** The result of one obligation. A `review` obligation is judged by a reviewer, not by the machine. */
export type ObligationResult = { readonly id: string; readonly proof: ProofKind } & (
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "needs-review" }
)

/** The result of one gate. */
export type GateResult = { readonly gate: string; readonly exitCode: number; readonly timedOut: boolean } & (
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly reason: string }
)

/** A changed path that breaks the structural rule. */
export interface Violation {
  readonly path: string
  readonly reason: string
}

/** The result of the structural rule `touches-plus-tests`. */
export interface StructuralResult {
  readonly rule: "touches-plus-tests"
  readonly status: "passed" | "failed"
  readonly violations: ReadonlyArray<Violation>
}

/** The evidence of one test run: the spec policy's `exit-code`, `counts`, `run-id` and `commit`. */
export interface Evidence {
  /** The exit code of `bun test`; 124 when the run timed out. */
  readonly exitCode: number
  readonly counts: { readonly pass: number; readonly fail: number; readonly skip: number }
  readonly runId: string
  /** The `head` commit, resolved to its full id. */
  readonly commit: string
}

export interface TaskProof {
  readonly task: string
  readonly obligations: ReadonlyArray<ObligationResult>
  readonly structural: StructuralResult
  readonly gates: ReadonlyArray<GateResult>
  readonly evidence: Evidence
}

export interface ScenarioProof {
  readonly scenario: string
  readonly result: TagResult
  readonly evidence: Evidence
}

export interface TaskInput {
  readonly spec: Spec
  readonly task: Task
  /** The working tree: the repository root, at `head`. */
  readonly cwd: string
  /** The commit before the task's first commit. */
  readonly base: string
  /** The task's final commit. */
  readonly head: string
  readonly limits: TaskLimits.Limits
}

export interface ScenarioInput {
  readonly scenario: Scenario
  readonly cwd: string
  readonly head: string
  readonly limits: TaskLimits.Limits
}

/** A proof could not run: a commit did not resolve, git failed, or a command could not start. */
export class ProofError extends Schema.TaggedError<ProofError>()("TaskProofError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The margin of a whole command's wall bound above the per-test timeout and the cancel deadline.
 * ponytail: a constant, sized from the fixture: its own `bun test` gate takes about 5 s at load 14, the scripted
 * proof timeout is 5 s. Scale it with the proof timeout if a slower fixture ever needs it.
 */
export const runMargin = Duration.seconds(10)

/** The wall bound of one whole command (the `bun test` run, a gate): the proof timeout, plus the cancel deadline, plus the margin. */
export const testRunBound = (limits: TaskLimits.Limits) =>
  Duration.sum(Duration.sum(limits.proofTimeout, limits.cancelDeadline), runMargin)

const commandBounds = (limits: TaskLimits.Limits): ProofProcess.Bounds => ({
  timeout: limits.proofTimeout,
  cancelDeadline: limits.cancelDeadline,
})

const tail = (text: string, size = 600) => {
  const trimmed = text.trim()
  return trimmed.length > size ? `…${trimmed.slice(trimmed.length - size)}` : trimmed
}

const startFailed = (error: ProofProcess.SpawnError) =>
  new ProofError({ message: `${error.command}: ${error.message}`, cause: error })

const runCommand = (command: string, args: ReadonlyArray<string>, cwd: string, bounds: ProofProcess.Bounds) =>
  ProofProcess.run(command, args, { cwd, ...bounds }).pipe(Effect.mapError(startFailed))

const git = (cwd: string, bounds: ProofProcess.Bounds, ...args: ReadonlyArray<string>) =>
  runCommand("git", args, cwd, bounds)

// The output of a git command that must succeed. A truncated output would drop paths, so it fails.
const gitText = Effect.fnUntraced(function* (cwd: string, bounds: ProofProcess.Bounds, ...args: ReadonlyArray<string>) {
  const result = yield* git(cwd, bounds, ...args)
  const command = `git ${args.join(" ")}`
  if (result.timedOut) return yield* new ProofError({ message: `${command}: timed out` })
  if (result.exitCode !== 0) {
    return yield* new ProofError({ message: `${command}: exit ${result.exitCode}: ${tail(result.stderr)}` })
  }
  if (result.truncated) return yield* new ProofError({ message: `${command}: the output is too long` })
  return result.stdout
})

const resolveCommit = Effect.fnUntraced(function* (cwd: string, bounds: ProofProcess.Bounds, revision: string) {
  if (revision === "" || revision.startsWith("-")) {
    return yield* new ProofError({ message: `not a revision: '${revision}'` })
  }
  const text = yield* gitText(cwd, bounds, "rev-parse", "--verify", "--quiet", `${revision}^{commit}`)
  return text.trim()
})

// The first of `tags` that the file holds at the commit; none when it holds none or the commit lacks it.
// `git grep` prints only the matched tags, so the size of the file does not matter.
const tagAt = Effect.fnUntraced(function* (
  cwd: string,
  bounds: ProofProcess.Bounds,
  commit: string,
  path: string,
  tags: ReadonlyArray<string>,
) {
  if (tags.length === 0) return Option.none<string>()
  const patterns = tags.flatMap((tag) => ["-e", tag])
  const args = ["grep", "-a", "-h", "-o", "-F", "--no-color", ...patterns, commit, "--", `:(literal)${path}`]
  const result = yield* git(cwd, bounds, ...args)
  if (result.timedOut) return yield* new ProofError({ message: `git grep ${commit} -- ${path}: timed out` })
  if (result.exitCode === 1) return Option.none<string>()
  if (result.exitCode !== 0) {
    return yield* new ProofError({
      message: `git grep ${commit} -- ${path}: exit ${result.exitCode}: ${tail(result.stderr)}`,
    })
  }
  return Arr.findFirst(tags, (tag) => result.stdout.includes(tag))
})

const makeRunId = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis
  const random = yield* Random.nextIntBetween(0, 0x7fffffff)
  return `proof-${millis.toString(36)}-${random.toString(36).padStart(6, "0")}`
})

interface TestRun {
  readonly result: ProofProcess.Result
  /** The test cases of the JUnit report; none when the run wrote no report. */
  readonly cases: Option.Option<ReadonlyArray<Junit.TestCase>>
  readonly failures: ReadonlyArray<Junit.ConsoleFailure>
}

// Runs `bun test` once in the working tree, with the JUnit reporter and the per-test timeout.
const runTests = Effect.fnUntraced(
  function* (cwd: string, limits: TaskLimits.Limits) {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs
      .makeTempDirectoryScoped({ prefix: "opencode-proof-" })
      .pipe(Effect.mapError((cause) => new ProofError({ message: "could not make the report folder", cause })))
    const report = join(directory, "junit.xml")
    const perTest = Math.max(1, Math.round(Duration.toMillis(limits.proofTimeout)))
    const result = yield* runCommand(
      "bun",
      ["test", "--reporter=junit", `--reporter-outfile=${report}`, `--timeout=${perTest}`],
      cwd,
      { timeout: testRunBound(limits), cancelDeadline: limits.cancelDeadline },
    )
    const xml = result.timedOut ? Option.none<string>() : yield* fs.readFileString(report).pipe(Effect.option)
    return {
      result,
      cases: Option.map(xml, Junit.parse),
      failures: Junit.consoleFailures(`${result.stderr}\n${result.stdout}`),
    } satisfies TestRun
  },
  Effect.scoped,
)

const failedCase = (test: Junit.TestCase, run: TestRun) =>
  `${Junit.fullTitle(test)}: ${Option.getOrElse(Junit.messageOf(test, run.failures), () => test.failureText || test.failureType || "failed")}`

/**
 * The result of the title tag `[tag]`. It passes when at least one test title starts with `[tag]` and
 * every such test passed. It is skipped when every such test was skipped. Otherwise it fails.
 */
const tagResult = (tag: string, run: TestRun): TagResult => {
  const label = `[${tag}]`
  if (run.result.timedOut) return { status: "failed", reason: "timed out: the test run passed its wall bound" }
  if (Option.isNone(run.cases)) {
    return {
      status: "failed",
      reason: `no test report (exit ${run.result.exitCode}): ${tail(run.result.stderr || run.result.stdout)}`,
    }
  }
  const tests = run.cases.value.filter((test) => test.name.startsWith(label))
  if (tests.length === 0) return { status: "failed", reason: `no test titled ${label}` }
  const hung = tests.filter(Junit.timedOut)
  if (hung.length > 0) {
    return { status: "failed", reason: `timed out: ${hung.map(Junit.fullTitle).join("; ")}` }
  }
  const failing = tests.filter((test) => test.status === "failed")
  if (failing.length > 0) return { status: "failed", reason: failing.map((test) => failedCase(test, run)).join("\n") }
  const skipped = tests.filter((test) => test.status === "skipped")
  if (skipped.length === tests.length) return { status: "skipped" }
  if (skipped.length > 0) {
    return { status: "failed", reason: `skipped: ${skipped.map(Junit.fullTitle).join("; ")}` }
  }
  return { status: "passed" }
}

const evidenceOf = Effect.fnUntraced(function* (run: TestRun, commit: string) {
  const cases = Option.getOrElse(run.cases, (): ReadonlyArray<Junit.TestCase> => [])
  return {
    exitCode: run.result.exitCode,
    counts: {
      pass: cases.filter((test) => test.status === "passed").length,
      fail: cases.filter((test) => test.status === "failed").length,
      skip: cases.filter((test) => test.status === "skipped").length,
    },
    runId: yield* makeRunId,
    commit,
  } satisfies Evidence
})

/** True for a test file: under a `test/` folder, or named `*.test.*` or `*.spec.*`. */
export const isTestFile = (path: string) =>
  path.startsWith("test/") || path.includes("/test/") || /\.(test|spec)\.[^/]+$/.test(path)

const changedPaths = Effect.fnUntraced(function* (
  cwd: string,
  bounds: ProofProcess.Bounds,
  base: string,
  head: string,
) {
  const text = yield* gitText(cwd, bounds, "diff", "--name-only", "-z", "--no-renames", base, head, "--")
  return text.split("\0").filter((path) => path !== "")
})

/**
 * The structural rule `touches-plus-tests`: every path changed between `base` and `head` is in the
 * task's touches, or is a test file that holds no title tag of another task's obligation in its `base`
 * content or its `head` content.
 */
const checkStructural = Effect.fnUntraced(function* (
  input: TaskInput,
  bounds: ProofProcess.Bounds,
  base: string,
  head: string,
) {
  const touched = input.task.touches.map((touch) => touch.path)
  const foreign = input.spec.obligations.filter((obligation) => obligation.task !== input.task.id)
  const foreignTags = Arr.dedupe(
    foreign.flatMap((obligation) =>
      obligation.proof.kind === "test" ? [`[${obligation.id}]`, `[${obligation.proof.tag}]`] : [`[${obligation.id}]`],
    ),
  )
  const paths = yield* changedPaths(input.cwd, bounds, base, head)
  const judged = yield* Effect.forEach(paths, (path) =>
    Effect.gen(function* () {
      if (touched.includes(path)) return Option.none<Violation>()
      if (!isTestFile(path)) {
        const violation: Violation = { path, reason: `not in the touches of ${input.task.id} and not a test file` }
        return Option.some(violation)
      }
      for (const [side, commit] of [
        ["base", base],
        ["head", head],
      ] as const) {
        const tag = yield* tagAt(input.cwd, bounds, commit, path, foreignTags)
        if (Option.isSome(tag)) {
          const violation: Violation = {
            path,
            reason: `a test file whose ${side} content holds ${tag.value} of another task`,
          }
          return Option.some(violation)
        }
      }
      return Option.none<Violation>()
    }),
  )
  const violations = judged.flatMap((violation) => Option.toArray(violation))
  return {
    rule: "touches-plus-tests",
    status: violations.length === 0 ? "passed" : "failed",
    violations,
  } satisfies StructuralResult
})

const runGate = Effect.fnUntraced(function* (input: TaskInput, gate: string) {
  const definition = Option.fromNullishOr(input.spec.gates[gate])
  if (Option.isNone(definition)) {
    // The gate never ran; 127 is the shell's "command not found".
    return { gate, exitCode: 127, timedOut: false, status: "failed", reason: `unknown gate ${gate}` } satisfies GateResult
  }
  // A gate is a whole command, like the tagged-test run, so it gets the same wall bound; the proof timeout bounds
  // each test inside it.
  const result = yield* runCommand("sh", ["-c", definition.value.command], input.cwd, {
    timeout: testRunBound(input.limits),
    cancelDeadline: input.limits.cancelDeadline,
  })
  const base = { gate, exitCode: result.exitCode, timedOut: result.timedOut }
  if (result.timedOut) return { ...base, status: "failed", reason: "timed out" } satisfies GateResult
  if (result.exitCode === 0) return { ...base, status: "passed" } satisfies GateResult
  return {
    ...base,
    status: "failed",
    reason: `exit ${result.exitCode}: ${tail(result.stderr || result.stdout)}`,
  } satisfies GateResult
})

const checkUnchanged = Effect.fnUntraced(function* (
  input: TaskInput,
  bounds: ProofProcess.Bounds,
  base: string,
  head: string,
  path: string,
) {
  const result = yield* git(input.cwd, bounds, "diff", "--quiet", base, head, "--", path)
  if (result.timedOut) return { status: "failed", reason: "timed out" } as const
  if (result.exitCode === 0) return { status: "passed" } as const
  if (result.exitCode === 1) return { status: "failed", reason: `changed between base and head: ${path}` } as const
  return { status: "failed", reason: `git diff exit ${result.exitCode}: ${tail(result.stderr)}` } as const
})

/**
 * Runs the proofs of one task in its working tree between `base` and `head`. It runs `bun test` once,
 * each gate of the task, each `unchanged` check and the structural rule. A structural violation fails
 * every `test` obligation with "structural: <path>". A `review` obligation is `needs-review`.
 */
export const proveTask = Effect.fn("TaskProof.proveTask")(function* (input: TaskInput) {
  const bounds = commandBounds(input.limits)
  const base = yield* resolveCommit(input.cwd, bounds, input.base)
  const head = yield* resolveCommit(input.cwd, bounds, input.head)
  const obligations = input.spec.obligations.filter((obligation) => obligation.task === input.task.id)
  const run = yield* runTests(input.cwd, input.limits)
  const structural = yield* checkStructural(input, bounds, base, head)
  const gateIds = Arr.dedupe([
    ...input.task.gates,
    ...obligations.flatMap((obligation) => (obligation.proof.kind === "gate" ? [obligation.proof.gate] : [])),
  ])
  const gates = yield* Effect.forEach(gateIds, (gate) => runGate(input, gate))
  const structuralReason = `structural: ${structural.violations.map((violation) => violation.path).join(", ")}`
  const results = yield* Effect.forEach(obligations, (obligation) =>
    Effect.gen(function* () {
      const proof = obligation.proof
      const id = { id: obligation.id, proof: proof.kind }
      switch (proof.kind) {
        case "review":
          return { ...id, status: "needs-review" } satisfies ObligationResult
        case "test": {
          if (structural.status === "failed") {
            return { ...id, status: "failed", reason: structuralReason } satisfies ObligationResult
          }
          const tag = tagResult(proof.tag, run)
          if (tag.status === "skipped") {
            return { ...id, status: "failed", reason: `skipped: every test titled [${proof.tag}] was skipped` } satisfies ObligationResult
          }
          return { ...id, ...tag } satisfies ObligationResult
        }
        case "gate": {
          // Every gate proof is in `gateIds`, so `gates` holds its result.
          const gate = Arr.findFirst(gates, (candidate) => candidate.gate === proof.gate)
          if (Option.isSome(gate) && gate.value.status === "passed") {
            return { ...id, status: "passed" } satisfies ObligationResult
          }
          const reason = Option.match(gate, {
            onNone: () => `unknown gate ${proof.gate}`,
            onSome: (result) => (result.status === "failed" ? `${proof.gate}: ${result.reason}` : proof.gate),
          })
          return { ...id, status: "failed", reason } satisfies ObligationResult
        }
      }
      return { ...id, ...(yield* checkUnchanged(input, bounds, base, head, proof.path)) } satisfies ObligationResult
    }),
  )
  return {
    task: input.task.id,
    obligations: results,
    structural,
    gates,
    evidence: yield* evidenceOf(run, head),
  } satisfies TaskProof
})

/** Runs `bun test` once at `head` and returns the result of the scenario's title tag `[S<n>]`. */
export const proveScenario = Effect.fn("TaskProof.proveScenario")(function* (input: ScenarioInput) {
  const head = yield* resolveCommit(input.cwd, commandBounds(input.limits), input.head)
  const run = yield* runTests(input.cwd, input.limits)
  return {
    scenario: input.scenario.id,
    result: tagResult(input.scenario.id, run),
    evidence: yield* evidenceOf(run, head),
  } satisfies ScenarioProof
})

export * as TaskProof from "."
