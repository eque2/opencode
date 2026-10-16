import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Option, Predicate, Schema, Semaphore } from "effect"
import fs from "fs"
import path from "path"
import type { Tool as AITool } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { TaskCommand } from "@/task/core/command"
import { TaskHarness } from "@/task/core/harness"
import { TaskHooks } from "@/task/core/hooks"
import type { Fact, Plan, Verdict } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import { RunSupervisor } from "@/task/core/supervise/run"
import type { TaskWorkers } from "@/task/core/workers"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { backgroundOf, jobsOf } from "./lib/command"
import { facts, judge, loadPlan, obligationsOf, trustLeaf } from "./lib/machine"
import { BASE, boundary, eventually, repository, storedFacts, type Turn } from "./lib/supervise"

// Scenario SV13 (spec task-harness-feedback, AD-8, AD-11, AD-19; tasks T2.5, T2.6, T2.8, T2.11): harness tool calls
// reach the supervisor that owns the session.
//
//   Given a builder session claimed by its task supervisor
//   When the builder calls task_ready, the verifier calls verdict, or the builder repeats a call past the limit
//   Then the owner receives the event and records its fact when the turn ends
//   And a session that no supervisor owns records nothing and the tool says so
//   And every claim of a run is removed when the run ends
//
// Everything that runs is the real code: a real harness root (its session index and hook routing), the real run
// supervisor spawned in it as `run:<runID>`, the real task and scenario supervisors it spawns, which claim each session
// through `TaskHarness.claimSession` before each turn, a real Recorder over the real event store, and a scratch git
// repository for the worktrees. The model side is scripted, and it calls the REAL harness tools: `task_ready` and
// `verdict` come from `SessionPrompt.createTaskHarnessTools` with the harness root's `hooks`, as `prompt.ts` builds
// them for a turn, and the repetition stop is `TaskHooks.repetitionStop`, which `prompt.ts` calls before each model
// request of a watched session. Each turn holds after its tool call until the test releases it, so the test sees the
// owner hold the event before the turn ends and record the fact after. The last test runs the real `TaskCommand.job`
// to the end of its run (the run wall clock, and a cancel) and reads the session index after it.
//
// The run is the release-notes plan folded from a stored slice in which T1.1 and T1.2 are trusted, S2 waits for its
// judge, and S3 and S7 failed (as in SV2): T1.3 is the one ready leaf. The S2 judge's turn runs until it is stopped.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC_DIR = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")
const NO_OWNER = "No task harness run owns this session. Nothing was recorded."
const REPEATED = "repetition: 3 identical bash calls in a row"
// The scripted bounds, with a stream idle time longer than any test, so a held turn never stalls here.
const LIMITS: TaskLimits.Limits = { ...TaskLimits.scripted, streamIdle: Duration.seconds(600) }

// T1.1 and T1.2 trusted; S2 passed its tests and waits for its judge; S3 and S7 failed theirs.
const givenSlice = (plan: Plan, f = facts()): ReadonlyArray<Fact> => [
  f.runStarted(plan.path),
  ...trustLeaf(plan, f, "T1.1"),
  ...trustLeaf(plan, f, "T1.2"),
  f.scenarioProved("S2", "passed"),
  f.scenarioProved("S3", "failed", "no test"),
  f.scenarioProved("S7", "failed", "no test"),
]

const ToolResult = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  metadata: Schema.Struct({ valid: Schema.Boolean }),
})

// Runs a harness tool's `execute` as the AI SDK does for a tool call, and reads its result.
const exec = (tool: AITool | undefined, input: unknown) =>
  Effect.promise(() => {
    if (tool?.execute === undefined) throw new Error("no such harness tool")
    return Promise.resolve(tool.execute(input, { toolCallId: "call_1", messages: [] }))
  }).pipe(Effect.map(Schema.decodeUnknownSync(ToolResult)))

// The harness tools `prompt.ts` gives a turn of `agent` in `session`.
const toolsOf = (harness: TaskHarness.Interface, agent: string, session: string) =>
  SessionPrompt.createTaskHarnessTools(agent, SessionID.make(session), harness.hooks)

let runs = 0

/** What a scripted turn may do: the harness root, and the run actor to read the task's worktree from. */
interface TurnEnv {
  readonly harness: TaskHarness.Interface
  readonly runActor: TaskWorkers.Run["recorder"]["actor"]
}

type Script = (env: TurnEnv, prompt: Parameters<Turn>[0]) => Effect.Effect<void>

// A live run of the scenario: the run supervisor spawned by the harness root as run:<runID>, as the job spawns it.
const liveRun = <R>(options: {
  readonly slice: (plan: Plan, root: string, id: string) => Effect.Effect<ReadonlyArray<Fact>, unknown, R>
  /** The builder turns of T1.3 in order; a builder turn past the end runs until it is stopped. */
  readonly builder?: ReadonlyArray<Script>
  /** The verifier turns of T1.3 in order. */
  readonly verifier?: ReadonlyArray<Script>
}) =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const root = yield* repository()
    const harness = yield* TaskHarness.make
    const events = yield* EventV2Bridge.Service
    const id = `task_sv13run${(runs++).toString(16).padStart(4, "0")}`
    const stored = yield* options.slice(plan, root, id)
    const recorder = yield* TaskRecorder.make({ plan, runID: id, directory: root, stored, events })
    const env: TurnEnv = { harness, runActor: recorder.actor }
    const count = { builder: 0, verifier: 0 }
    // Each prompt by its agent and its first line: T1.3's builder, T1.3's verifier, or another judge (S2's).
    const turn: Turn = (prompt) => {
      if (prompt.agent === TaskHooks.BUILDER)
        return (options.builder?.[count.builder++] ?? (() => Effect.never))(env, prompt)
      if (prompt.text.startsWith("task-harness role=verifier task=T1.3"))
        return (options.verifier?.[count.verifier++] ?? (() => Effect.never))(env, prompt)
      return Effect.never
    }
    const { env: sessions, seen } = boundary(
      Array.from({ length: 40 }, () => turn),
      [],
    )
    const run: TaskWorkers.Run = {
      env: sessions,
      id,
      directory: root,
      base: BASE,
      specDir: SPEC_DIR,
      plan,
      root: SessionID.make("ses_sv13_root"),
      model: { providerID: "test", modelID: "test" },
      limits: LIMITS,
      locks: { checkout: yield* Semaphore.make(1), git: yield* Semaphore.make(1) },
      recorder,
      claim: harness.claimSession,
    }
    yield* harness.spawnRun(id, RunSupervisor.machine, {
      run,
      events,
      resumed: true,
      path: plan.path,
      trusts: Effect.succeed([]),
      externals: [],
      release: Effect.void,
      writer: recorder.writer,
    } satisfies RunSupervisor.Input)
    const taskRef = TaskHarness.systemId.task(id, "T1.3")
    // The T1.3 supervisor's context, read from its snapshot in the harness system.
    const context = Effect.gen(function* () {
      const ref = yield* harness.system.get(taskRef)
      if (Option.isNone(ref)) return yield* Effect.die(new Error(`no actor ${taskRef}`))
      const snapshot: unknown = yield* ref.value.getSnapshot
      return Predicate.hasProperty(snapshot, "context") ? snapshot.context : undefined
    })
    const types = Effect.map(storedFacts(id), (list) => list.map((fact) => fact.type))
    return { plan, root, harness, events, id, recorder, seen, taskRef, context, types }
  })

const field = (value: unknown, key: string): unknown => (Predicate.hasProperty(value, key) ? value[key] : undefined)

const isNone = (value: unknown) => Option.isOption(value) && Option.isNone(value)

// The worktree of T1.3, as the run actor records it.
const worktreeOf = (runActor: TurnEnv["runActor"]) =>
  Effect.map(runActor.getSnapshot, (snapshot) => TaskEngineXState.view(snapshot).tasks["T1.3"]?.worktree ?? "")

// Lets the owner take an event, so that a fact it would record at once has time to show.
const settle = Effect.sleep(500)

it.live(
  "[SV13] task_ready in the claimed builder session reaches its task supervisor, which records task.ready only when the turn ends",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const answers: Array<typeof ToolResult.Type> = []
      const run = yield* liveRun({
        slice: (plan) => Effect.succeed(givenSlice(plan)),
        builder: [
          (env, prompt) =>
            Effect.gen(function* () {
              const worktree = yield* worktreeOf(env.runActor)
              fs.writeFileSync(path.join(worktree, "render.ts"), "export const render = () => ''\n")
              const tools = yield* toolsOf(env.harness, TaskHooks.BUILDER, prompt.session)
              answers.push(yield* exec(tools.task_ready, { summary: "renderer done" }))
              yield* Deferred.await(release)
            }),
        ],
      })
      // Given a builder session claimed by its task supervisor.
      yield* eventually(
        Effect.sync(() => answers.length === 1),
        "the builder called task_ready",
      )
      const session = run.seen.prompts.find((item) => item.agent === TaskHooks.BUILDER)?.session ?? ""
      expect(yield* run.harness.ownerOf(session)).toEqual(Option.some({ owner: run.taskRef, watch: true }))
      // The tool answered as the owner received it.
      expect(answers[0]).toEqual({
        title: "Task ready",
        output: "Ready recorded. End your turn now: the harness runs the proofs.",
        metadata: { valid: true },
      })
      // Then the owner holds the event, and records nothing while the turn runs.
      yield* eventually(
        Effect.map(run.context, (context) => field(context, "ready") === true),
        "the task supervisor holds task_ready",
      )
      yield* settle
      expect((yield* run.types).filter((type) => type === "task.ready")).toEqual([])
      // When the turn ends, the owner records task.ready with the head of the builder's committed work.
      const ended = yield* Clock.currentTimeMillis
      yield* Deferred.succeed(release, undefined)
      yield* eventually(
        Effect.map(run.types, (types) => types.includes("task.ready")),
        "task.ready",
      )
      const ready = (yield* storedFacts(run.id)).find((fact) => fact.type === "task.ready")
      if (ready?.type !== "task.ready") throw new Error("no task.ready")
      expect(ready.task).toBe("T1.3")
      expect(ready.at).toBeGreaterThanOrEqual(ended)
      const worktree = yield* worktreeOf(run.recorder.actor)
      expect(
        yield* TaskWorkspace.git(worktree, LIMITS, "show", `${ready.head}:render.ts`).pipe(
          Effect.map((text) => text.includes("render")),
        ),
      ).toBe(true)
      expect((yield* run.types).slice(0, 3)).toEqual(["run.resumed", "task.started", "task.ready"])
    }),
  120_000,
)

it.live(
  "[SV13] verdict in the claimed verifier session reaches the task supervisor, which records task.verified only when the turn ends",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const answers: Array<typeof ToolResult.Type> = []
      const sent: Array<Verdict> = []
      const run = yield* liveRun({
        // T1.3 built, ready and proved: every obligation waits for its verifier.
        slice: (plan, root, id) =>
          Effect.gen(function* () {
            const f = facts()
            const before = givenSlice(plan, f)
            const tree = yield* TaskWorkspace.ensureWorktree(root, id, "T1.3", BASE, LIMITS)
            fs.writeFileSync(path.join(tree.worktree, "render.ts"), "export const render = () => ''\n")
            const head = yield* TaskWorkspace.commitAll(tree.worktree, LIMITS, "T1.3: attempt 1")
            return [
              ...before,
              {
                ...f.started("T1.3"),
                worktree: tree.worktree,
                branch: tree.branch,
                base: tree.base,
                session: "ses_T1.3",
              },
              f.ready("T1.3", head),
              f.proved("T1.3", obligationsOf(plan, "T1.3").map(judge)),
            ]
          }),
        verifier: [
          (env, prompt) =>
            Effect.gen(function* () {
              const ids = prompt.text
                .split("\n")
                .filter((line) => line.startsWith("judge "))
                .map((line) => line.slice("judge ".length, line.indexOf(":")))
              const verdicts: ReadonlyArray<Verdict> = ids.map((id, index) =>
                index === 0
                  ? { id, verdict: "rejected", reason: "the empty string renders nothing" }
                  : { id, verdict: "trusted" },
              )
              sent.push(...verdicts)
              const tools = yield* toolsOf(env.harness, TaskHooks.VERIFIER, prompt.session)
              answers.push(yield* exec(tools.verdict, { verdicts }))
              yield* Deferred.await(release)
            }),
        ],
      })
      yield* eventually(
        Effect.sync(() => answers.length === 1),
        "the verifier called verdict",
      )
      const session =
        run.seen.prompts.find((item) => item.text.startsWith("task-harness role=verifier task=T1.3"))?.session ?? ""
      // The verifier's session is claimed by the same task supervisor, unwatched.
      expect(yield* run.harness.ownerOf(session)).toEqual(Option.some({ owner: run.taskRef, watch: false }))
      expect(sent.map((item) => item.id)).toEqual(obligationsOf(run.plan, "T1.3"))
      expect(answers[0]).toEqual({
        title: "Verdict",
        output: `Recorded ${sent.length} verdicts.`,
        metadata: { valid: true },
      })
      // The owner holds the verdicts, and records nothing while the turn runs.
      yield* eventually(
        Effect.map(run.context, (context) => {
          const held = field(context, "verdicts")
          return Array.isArray(held) && held.length === sent.length
        }),
        "the task supervisor holds the verdicts",
      )
      expect(field(yield* run.context, "verdicts")).toEqual(sent)
      yield* settle
      expect(yield* run.types).toEqual(["run.resumed"])
      // When the turn ends, the owner records task.verified with the verdicts it received.
      const ended = yield* Clock.currentTimeMillis
      yield* Deferred.succeed(release, undefined)
      yield* eventually(
        Effect.map(run.types, (types) => types.includes("task.verified")),
        "task.verified",
      )
      const verified = (yield* storedFacts(run.id)).find((fact) => fact.type === "task.verified")
      if (verified?.type !== "task.verified") throw new Error("no task.verified")
      expect(verified).toMatchObject({ task: "T1.3", verdicts: sent })
      expect(verified.at).toBeGreaterThanOrEqual(ended)
      expect((yield* run.types).slice(0, 2)).toEqual(["run.resumed", "task.verified"])
    }),
  120_000,
)

it.live(
  "[SV13] a call repeated past the limit in the claimed builder session reaches its task supervisor, which records task.repeated only when the turn ends",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const bash = { tool: "bash", input: { command: "ls" } }
      const checks: Array<{ calls: number; limit: Option.Option<number>; reason: Option.Option<string> }> = []
      const run = yield* liveRun({
        slice: (plan) => Effect.succeed(givenSlice(plan)),
        builder: [
          (env, prompt) =>
            Effect.gen(function* () {
              // prompt.ts runs the repetition stop before each model request of a watched session.
              for (const calls of [[bash], [bash, bash], [bash, bash, bash]])
                checks.push({
                  calls: calls.length,
                  limit: yield* env.harness.hooks.limitOf(prompt.session),
                  reason: yield* TaskHooks.repetitionStop(env.harness.hooks, prompt.session, calls),
                })
              yield* Deferred.await(release)
            }),
        ],
      })
      yield* eventually(
        Effect.sync(() => checks.length === 3),
        "the repetition stop ran three times",
      )
      const session = run.seen.prompts.find((item) => item.agent === TaskHooks.BUILDER)?.session ?? ""
      expect(yield* run.harness.ownerOf(session)).toEqual(Option.some({ owner: run.taskRef, watch: true }))
      // The limit is read from the owner's context; only the third identical call trips it.
      expect(checks).toEqual([
        { calls: 1, limit: Option.some(3), reason: Option.none() },
        { calls: 2, limit: Option.some(3), reason: Option.none() },
        { calls: 3, limit: Option.some(3), reason: Option.some(REPEATED) },
      ])
      expect(field(yield* run.context, "limit")).toBe(3)
      // The owner holds the repetition, and records nothing while the turn runs.
      yield* eventually(
        Effect.map(run.context, (context) => {
          const repeated = field(context, "repeated")
          return Option.isOption(repeated) && Option.isSome(repeated) && repeated.value === REPEATED
        }),
        "the task supervisor holds hook.repeated",
      )
      yield* settle
      expect((yield* run.types).filter((type) => type === "task.repeated")).toEqual([])
      // When the turn ends, the owner records task.repeated with the reason.
      const ended = yield* Clock.currentTimeMillis
      yield* Deferred.succeed(release, undefined)
      yield* eventually(
        Effect.map(run.types, (types) => types.includes("task.repeated")),
        "task.repeated",
      )
      const repeated = (yield* storedFacts(run.id)).find((fact) => fact.type === "task.repeated")
      if (repeated?.type !== "task.repeated") throw new Error("no task.repeated")
      expect(repeated).toMatchObject({ task: "T1.3", reason: REPEATED })
      expect(repeated.at).toBeGreaterThanOrEqual(ended)
      expect((yield* run.types).slice(0, 3)).toEqual(["run.resumed", "task.started", "task.repeated"])
    }),
  120_000,
)

it.live(
  "[SV13] a tool call in a session that no supervisor owns records nothing, and the tool says so, while the run's own sessions stay owned",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const run = yield* liveRun({
        slice: (plan) => Effect.succeed(givenSlice(plan)),
        builder: [() => Deferred.await(release)],
      })
      yield* eventually(
        Effect.sync(() => run.seen.prompts.some((item) => item.agent === TaskHooks.BUILDER)),
        "the T1.3 builder turn",
      )
      const builder = run.seen.prompts.find((item) => item.agent === TaskHooks.BUILDER)?.session ?? ""
      expect(yield* run.harness.ownerOf(builder)).toEqual(Option.some({ owner: run.taskRef, watch: true }))
      const before = yield* run.types
      // A session that no supervisor claimed.
      const nobody = "ses_sv13_nobody"
      expect(yield* run.harness.ownerOf(nobody)).toEqual(Option.none())
      const ready = yield* exec((yield* toolsOf(run.harness, TaskHooks.BUILDER, nobody)).task_ready, { summary: "x" })
      expect(ready).toEqual({ title: "Task ready", output: NO_OWNER, metadata: { valid: false } })
      const verdict = yield* exec((yield* toolsOf(run.harness, TaskHooks.VERIFIER, nobody)).verdict, {
        verdicts: [{ id: "T1.3.c1", verdict: "trusted" }],
      })
      expect(verdict).toEqual({ title: "Verdict", output: NO_OWNER, metadata: { valid: false } })
      const bash = { tool: "bash", input: { command: "ls" } }
      expect(yield* run.harness.hooks.limitOf(nobody)).toEqual(Option.none())
      expect(yield* TaskHooks.repetitionStop(run.harness.hooks, nobody, [bash, bash, bash])).toEqual(Option.none())
      // Nothing was recorded, and the owner of the run's builder session received nothing.
      yield* settle
      expect(yield* run.types).toEqual(before)
      const context = yield* run.context
      expect(field(context, "ready")).toBe(false)
      expect(field(context, "verdicts")).toEqual([])
      expect(isNone(field(context, "repeated"))).toBe(true)
      expect(yield* run.harness.ownerOf(nobody)).toEqual(Option.none())
      expect(yield* run.harness.ownerOf(builder)).toEqual(Option.some({ owner: run.taskRef, watch: true }))
    }),
  120_000,
)

let jobs = 0

// A real job of the run (`TaskCommand.job`), on the lease the command would claim, resumed from the given slice.
const jobOf = Effect.fnUntraced(function* (limits: TaskLimits.Limits) {
  const plan = yield* loadPlan("release-notes.spec")
  const root = yield* repository()
  const harness = yield* TaskHarness.make
  const events = yield* EventV2Bridge.Service
  const db = yield* Database.Service
  const id = `task_sv13job${(jobs++).toString(16).padStart(4, "0")}`
  const claimed = yield* harness.claim({ directory: root, runID: id, spec: plan.specPath, path: plan.path })
  if (claimed.kind !== "claimed") return yield* Effect.die(new Error("the lease was not claimed"))
  const registry = jobsOf()
  registry.starts.push({ id, type: "task-harness", run: Effect.succeed("") })
  const { env, seen } = boundary(Array.from({ length: 40 }, () => () => Effect.never))
  // A claim of another run, which the end of this run must leave alone.
  const other = { session: "ses_sv13_other", owner: TaskHarness.systemId.task("task_sv13other", "T1.1"), watch: true }
  yield* harness.claimSession(other)
  const fiber = yield* Effect.forkChild(
    TaskCommand.job({
      harness,
      env: { ...env, events, db: db.db, background: backgroundOf(registry) },
      id,
      directory: root,
      base: BASE,
      specDir: SPEC_DIR,
      plan,
      path: plan.path,
      slice: { kind: "resume", facts: givenSlice(plan) },
      externals: [],
      root: SessionID.make("ses_sv13_root"),
      model: { providerID: "test", modelID: "test" },
      limits,
      locks: claimed.locks,
    }),
  )
  // The run's own claims: the T1.3 builder session (its task supervisor) and the S2 judge session (its scenario
  // supervisor), each claimed before its turn.
  yield* eventually(
    Effect.sync(() => seen.prompts.length >= 2),
    "the builder and judge turns",
  )
  const builder = seen.prompts.find((item) => item.agent === TaskHooks.BUILDER)?.session ?? ""
  const judgeSession = seen.prompts.find((item) => item.text.startsWith("task-harness role=verifier scenario=S2"))
  expect(yield* harness.ownerOf(builder)).toEqual(
    Option.some({ owner: TaskHarness.systemId.task(id, "T1.3"), watch: true }),
  )
  expect(yield* harness.ownerOf(judgeSession?.session ?? "")).toEqual(
    Option.some({ owner: TaskHarness.systemId.scenario(id, "S2"), watch: false }),
  )
  const claims = [builder, judgeSession?.session ?? ""]
  return { harness, id, fiber, registry, claims, other, root, db }
})

it.live(
  "[SV13] every claim of a run is removed when the run ends, by its wall clock or by a cancel, and a claim of another run stays",
  () =>
    Effect.gen(function* () {
      // The run ends on its own: its wall clock records run.ended failed, the run actor is done, the job returns.
      const timed = yield* jobOf({ ...LIMITS, runWallClock: Option.some(Duration.seconds(10)) })
      expect(yield* Fiber.join(timed.fiber)).toBe("failed")
      const timedFacts = yield* storedFacts(timed.id)
      expect(timedFacts.at(-1)).toMatchObject({ type: "run.ended", state: "failed" })
      for (const session of timed.claims) expect(yield* timed.harness.ownerOf(session)).toEqual(Option.none())
      expect(yield* timed.harness.ownerOf(timed.other.session)).toEqual(
        Option.some({ owner: timed.other.owner, watch: true }),
      )
      expect(yield* timed.harness.running(timed.id)).toBe(false)
      // A call in a session of the ended run is a call that no supervisor owns: the tool says so, nothing is recorded.
      const after = yield* exec(
        (yield* toolsOf(timed.harness, TaskHooks.BUILDER, timed.claims[0] ?? "")).task_ready,
        {},
      )
      expect(after).toEqual({ title: "Task ready", output: NO_OWNER, metadata: { valid: false } })
      expect((yield* storedFacts(timed.id)).length).toBe(timedFacts.length)

      // The run ends by a cancel: the job's cancel finalizer records run.cancelled and removes the run.
      const cancelled = yield* jobOf(LIMITS)
      cancelled.registry.status = "cancelled"
      yield* Fiber.interrupt(cancelled.fiber)
      expect((yield* storedFacts(cancelled.id)).map((fact) => fact.type)).toContain("run.cancelled")
      for (const session of cancelled.claims) expect(yield* cancelled.harness.ownerOf(session)).toEqual(Option.none())
      expect(yield* cancelled.harness.ownerOf(cancelled.other.session)).toEqual(
        Option.some({ owner: cancelled.other.owner, watch: true }),
      )
      expect(yield* cancelled.harness.running(cancelled.id)).toBe(false)
    }),
  150_000,
)
