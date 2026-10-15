import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Clock, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Path, Semaphore } from "effect"
import path from "path"
import { type AnyEventObject, assign, createActor, setup } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { InstanceStore } from "@/project/instance-store"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import { TaskHooks } from "@/task/core/hooks"
import type { Fact, Plan } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import type { TaskSessions } from "@/task/core/sessions"
import { TaskWorkers } from "@/task/core/workers"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, trustLeaf } from "./lib/machine"

// The stateless workers of a run (spine AD-8, AD-11, D7, AD-19): each runs one Effect and returns. The git side runs
// on scratch repositories; the session side runs against a recording session boundary (create, prompt, cancel,
// messages), because a real session needs a model.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const limits = TaskLimits.scripted
const BASE = "dev"
const ROOT_SESSION = SessionID.make("ses_worker_root")

const git = (cwd: string, ...args: ReadonlyArray<string>) => TaskWorkspace.git(cwd, limits, ...args)

const repository = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  yield* git(root, "init", "-q", "-b", BASE)
  yield* fs.writeFileString(path.join(root, "tracked.ts"), "export const tracked = 1\n")
  yield* git(root, "add", "-A")
  yield* git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "seed")
  // As `/task` does before its first status write: the harness's own files are not changes of the checkout.
  yield* TaskWorkspace.ensureExcluded(root, limits)
  return root
})

// What the session boundary saw, in order.
interface Seen {
  readonly order: Array<string>
  readonly created: Array<{ readonly directory: string; readonly title: string; readonly agent: string }>
  readonly prompts: Array<{ readonly session: string; readonly agent: string; readonly text: string }>
  readonly cancels: Array<string>
  readonly claims: Array<{ readonly session: string; readonly owner: string; readonly watch: boolean }>
}

interface Boundary {
  /** What the session's messages read returns (the builder history and the spend-cap check read it). */
  readonly messages?: ReadonlyArray<unknown>
  /** Runs inside the prompt, after it is recorded: a turn that never ends is `Effect.never`. */
  readonly during?: Effect.Effect<void>
  /** Runs inside the cancel, after it is recorded. */
  readonly cancelling?: Effect.Effect<void>
}

// A session boundary that records each call. The workers call only these members of each service.
const recording = (boundary: Boundary = {}) => {
  const seen: Seen = { order: [], created: [], prompts: [], cancels: [], claims: [] }
  const sessions = {
    create: (input: { readonly title?: string; readonly agent?: string }) =>
      Effect.sync(() => {
        const id = SessionID.make(`ses_worker_${seen.created.length + 1}`)
        seen.created.push({ directory: seen.order.at(-1) ?? "", title: input.title ?? "", agent: input.agent ?? "" })
        seen.order.push(`create ${id}`)
        return { id }
      }),
    messages: () => Effect.succeed(boundary.messages ?? []),
  }
  const instances = {
    provide: <A, E, R>(load: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) =>
      Effect.sync(() => seen.order.push(`in ${load.directory}`)).pipe(Effect.andThen(effect)),
  }
  const env: TaskSessions.Env = {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers call only create and messages
    sessions: sessions as unknown as Session.Interface,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers never read the status service
    status: {} as SessionStatus.Interface,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers call only provide
    instances: instances as unknown as InstanceStore.Interface,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) only sessionEvents reads events, with its own input
    events: {} as TaskSessions.Env["events"],
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers never read the background jobs
    background: {} as BackgroundJob.Interface,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers never read the database
    db: {} as TaskSessions.Env["db"],
    ops: {
      prompt: (input) =>
        Effect.sync(() => {
          seen.prompts.push({ session: input.sessionID, agent: input.agent, text: input.parts[0]?.text ?? "" })
          seen.order.push(`prompt ${input.sessionID}`)
        }).pipe(
          Effect.andThen(boundary.during ?? Effect.void),
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers never read the turn's last message
          Effect.as({} as SessionV1.WithParts),
        ),
      cancel: (session) =>
        Effect.sync(() => {
          seen.cancels.push(session)
          seen.order.push(`cancel ${session}`)
        }).pipe(Effect.andThen(boundary.cancelling ?? Effect.void)),
      currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
    },
  }
  return { env, seen }
}

let runs = 0

// A run of `plan` whose run actor holds the fold of `stored`, with fresh locks and a recording session boundary.
const runOf = Effect.fnUntraced(function* (input: {
  readonly plan: Plan
  readonly directory: string
  readonly specDir?: string
  readonly stored?: ReadonlyArray<Fact>
  readonly boundary?: Boundary
}) {
  const id = `task_workers${(runs++).toString(16).padStart(4, "0")}`
  const events = yield* EventV2Bridge.Service
  const recorder = yield* TaskRecorder.make({
    plan: input.plan,
    runID: id,
    directory: input.directory,
    stored: input.stored ?? [],
    events,
    write: () => Effect.void,
  })
  const { env, seen } = recording(input.boundary)
  const run: TaskWorkers.Run = {
    env,
    id,
    directory: input.directory,
    base: BASE,
    specDir: input.specDir ?? input.directory,
    plan: input.plan,
    root: ROOT_SESSION,
    model: { providerID: "test", modelID: "test" },
    limits,
    locks: { checkout: yield* Semaphore.make(1), git: yield* Semaphore.make(1) },
    recorder,
    claim: (claim) =>
      Effect.sync(() => {
        seen.claims.push(claim)
        seen.order.push(`claim ${claim.session}`)
      }),
  }
  return { run, seen, recorder }
})

const taskOf = (plan: Plan, id: string) => {
  const task = plan.spec.tasks.find((each) => each.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  return task
}

// A lock held by another fiber until `release` succeeds; resolves once the lock is held.
const hold = Effect.fnUntraced(function* (lock: Semaphore.Semaphore) {
  const held = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const holder = yield* Effect.forkChild(
    lock.withPermit(Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))),
  )
  yield* Deferred.await(held)
  return { release: Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(holder))) }
})

// The fiber is still running after a pause: it waits on something.
const waiting = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.sleep(100).pipe(Effect.andThen(Effect.sync(() => fiber.pollUnsafe() === undefined)))

describe("begin", () => {
  it.live("makes the leaf's worktree and its builder session there, and returns the task.started payload", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const { run, seen } = yield* runOf({ plan, directory: root })
      const started = yield* TaskWorkers.begin(run, taskOf(plan, "T1.1"))
      expect(yield* fs.exists(started.worktree)).toBe(true)
      expect(started.worktree).toBe(TaskWorkspace.worktreePath(yield* Path.Path, root, run.id, "T1.1"))
      expect(started.branch).toBe(TaskWorkspace.branchOf(run.id, "T1.1"))
      expect(started.base).toBe(yield* TaskWorkspace.baseHead(root, limits, BASE))
      expect(yield* git(started.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(started.branch)
      // The builder session is a child session of the run's root, made in the worktree's instance.
      expect(seen.created).toEqual([
        { directory: `in ${started.worktree}`, title: "T1.1 builder", agent: TaskHooks.BUILDER },
      ])
      expect(started.session).toBe(SessionID.make("ses_worker_1"))
    }),
  )

  it.live("RM16 two sibling begins at the same moment both make their worktrees, each under the git lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const { run } = yield* runOf({ plan, directory: root })
      const lock = yield* hold(run.locks.git)
      const one = yield* Effect.forkChild(TaskWorkers.begin(run, taskOf(plan, "T1.1")))
      const two = yield* Effect.forkChild(TaskWorkers.begin(run, taskOf(plan, "T1.2")))
      // Neither makes its worktree while another holds the git lock.
      expect(yield* waiting(one)).toBe(true)
      expect(yield* waiting(two)).toBe(true)
      expect(yield* fs.exists(TaskWorkspace.worktreePath(yield* Path.Path, root, run.id, "T1.1"))).toBe(false)
      expect(yield* fs.exists(TaskWorkspace.worktreePath(yield* Path.Path, root, run.id, "T1.2"))).toBe(false)
      yield* lock.release
      const [a, b] = [yield* Fiber.join(one), yield* Fiber.join(two)]
      expect(a.worktree).not.toBe(b.worktree)
      expect(yield* fs.exists(a.worktree)).toBe(true)
      expect(yield* fs.exists(b.worktree)).toBe(true)
      expect(a.base).toBe(b.base)
    }),
  )
})

describe("builderTurn", () => {
  it.live("claims the session for its owner with watch, then prompts the attempt's message in the worktree", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const { run, seen } = yield* runOf({ plan, directory: "/root", stored: [f.runStarted(), f.started("T1.1")] })
      const turn = yield* TaskWorkers.builderTurn(run, {
        task: taskOf(plan, "T1.1"),
        spec: plan.spec,
        prompt: "attempt",
        owner: "task:run:T1.1",
      })
      // Claimed and indexed before the prompt, in the worktree's instance.
      expect(seen.order).toEqual(["claim ses_T1.1", "in /wt/T1.1", "prompt ses_T1.1"])
      expect(seen.claims).toEqual([{ session: "ses_T1.1", owner: "task:run:T1.1", watch: true }])
      expect(seen.prompts).toHaveLength(1)
      expect(seen.prompts[0]?.agent).toBe(TaskHooks.BUILDER)
      const text = seen.prompts[0]?.text ?? ""
      // A session with no marker gets the role line and the attempt line, then the task.
      expect(text.split("\n").slice(0, 2)).toEqual(["task-harness role=builder task=T1.1", "task-harness attempt=1"])
      expect(text).toContain("# Task T1.1: ")
      expect(text).toContain("T1.1.c1: ")
      expect(turn.session).toBe(SessionID.make("ses_T1.1"))
      expect(turn.spendCap).toEqual(Option.none())
      expect(turn.started).toBeGreaterThan(1_000_000_000_000)
    }),
  )

  it.live("continues a session that already has the attempt's message, and sends the continue and nudge texts", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const marked = {
        info: { role: "user" },
        parts: [{ type: "text", text: "task-harness role=builder task=T1.1\ntask-harness attempt=1\n\n# Task T1.1" }],
      }
      const { run, seen } = yield* runOf({
        plan,
        directory: "/root",
        stored: [f.runStarted(), f.started("T1.1")],
        boundary: { messages: [marked] },
      })
      const task = taskOf(plan, "T1.1")
      for (const prompt of ["attempt", "continue", "nudge"] as const)
        yield* TaskWorkers.builderTurn(run, { task, spec: plan.spec, prompt, owner: "task:run:T1.1" })
      expect(seen.prompts.map((item) => item.text)).toEqual([
        "Continue the task from where you stopped. When it is done, call task_ready once and end your turn.",
        "Continue the task from where you stopped. When it is done, call task_ready once and end your turn.",
        "Call task_ready when the task is done.",
      ])
      // Each turn claims the session first, so a resumed or respawned owner gets its hooks.
      expect(seen.claims).toHaveLength(3)
    }),
  )

  it.live("sends a new attempt's message, with its reopen lines, when the session holds an older attempt", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const marked = {
        info: { role: "user" },
        parts: [{ type: "text", text: "task-harness role=builder task=T1.1\ntask-harness attempt=1" }],
      }
      // Attempt 1 failed T1.1.c1 in its proof: the task is back in building for attempt 2.
      const stored = [
        f.runStarted(),
        f.started("T1.1"),
        f.ready("T1.1"),
        f.proved("T1.1", [{ id: "T1.1.c1", status: "failed", reason: "expected 2, got 3" }]),
      ]
      const { run, seen } = yield* runOf({ plan, directory: "/root", stored, boundary: { messages: [marked] } })
      yield* TaskWorkers.builderTurn(run, {
        task: taskOf(plan, "T1.1"),
        spec: plan.spec,
        prompt: "attempt",
        owner: "task:run:T1.1",
      })
      const lines = (seen.prompts[0]?.text ?? "").split("\n")
      expect(lines[0]).toBe("task-harness attempt=2")
      expect(lines).toContain("reopen T1.1.c1: expected 2, got 3")
    }),
  )

  it.live("SV11 reports the spend-cap error that ended the turn", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const now = yield* Clock.currentTimeMillis
      const capped = {
        info: {
          role: "assistant",
          time: { created: now + 60_000 },
          error: { data: { message: "You exceeded your current quota,\nplease check your plan" } },
        },
        parts: [],
      }
      const { run } = yield* runOf({
        plan,
        directory: "/root",
        stored: [f.runStarted(), f.started("T1.1")],
        boundary: { messages: [capped] },
      })
      const turn = yield* TaskWorkers.builderTurn(run, {
        task: taskOf(plan, "T1.1"),
        spec: plan.spec,
        prompt: "continue",
        owner: "task:run:T1.1",
      })
      expect(turn.spendCap).toEqual(Option.some("spend cap: You exceeded your current quota, | please check your plan"))
    }),
  )

  it.live(
    "cancels the turn's session when the worker is interrupted, and gives up on a hung cancel at the deadline",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const f = facts()
        const prompted = yield* Deferred.make<void>()
        const { run, seen } = yield* runOf({
          plan,
          directory: "/root",
          stored: [f.runStarted(), f.started("T1.1")],
          boundary: { during: Deferred.succeed(prompted, undefined).pipe(Effect.andThen(Effect.never)) },
        })
        const input = { task: taskOf(plan, "T1.1"), spec: plan.spec, prompt: "continue", owner: "o" } as const
        const fiber = yield* Effect.forkChild(TaskWorkers.builderTurn(run, input))
        yield* Deferred.await(prompted)
        yield* Fiber.interrupt(fiber)
        expect(seen.cancels).toEqual(["ses_T1.1"])
        expect(seen.order.at(-1)).toBe("cancel ses_T1.1")

        // A cancel that never returns is cut at limits.cancelDeadline (1 s for the scripted bounds).
        const hung = yield* Deferred.make<void>()
        const { run: stuck, seen: stuckSeen } = yield* runOf({
          plan,
          directory: "/root",
          stored: [f.runStarted(), f.started("T1.1")],
          boundary: {
            during: Deferred.succeed(hung, undefined).pipe(Effect.andThen(Effect.never)),
            cancelling: Effect.never,
          },
        })
        const second = yield* Effect.forkChild(TaskWorkers.builderTurn(stuck, input))
        yield* Deferred.await(hung)
        const before = yield* Clock.currentTimeMillis
        yield* Fiber.interrupt(second).pipe(Effect.timeout(5_000))
        const took = (yield* Clock.currentTimeMillis) - before
        expect(stuckSeen.cancels).toEqual(["ses_T1.1"])
        expect(took).toBeGreaterThanOrEqual(900)
      }),
  )

  it.live("fails with a WorkerError for a building task with no builder session", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const { run, seen } = yield* runOf({ plan, directory: "/root", stored: [facts().runStarted()] })
      const error = yield* Effect.flip(
        TaskWorkers.builderTurn(run, { task: taskOf(plan, "T1.1"), spec: plan.spec, prompt: "attempt", owner: "o" }),
      )
      expect(error).toEqual(new TaskWorkers.WorkerError({ message: "T1.1 is building without a builder session" }))
      expect(seen.prompts).toEqual([])
    }),
  )
})

describe("verifierPrompt", () => {
  it.live("asks in a new verifier session, claimed without watch, then asks again in the same session", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const { run, seen } = yield* runOf({ plan, directory: "/root", stored: [facts().runStarted()] })
      const ask = yield* TaskWorkers.verifierPrompt(run, {
        directory: "/wt/T1.1",
        session: Option.none(),
        title: "T1.1 verifier",
        text: "judge T1.1.c1",
        owner: "task:run:T1.1",
      })
      expect(seen.created).toEqual([{ directory: "in /wt/T1.1", title: "T1.1 verifier", agent: TaskHooks.VERIFIER }])
      expect(seen.claims).toEqual([{ session: ask.session, owner: "task:run:T1.1", watch: false }])
      const again = yield* TaskWorkers.verifierPrompt(run, {
        directory: "/wt/T1.1",
        session: Option.some(ask.session),
        title: "T1.1 verifier",
        text: "judge T1.1.c2",
        owner: "task:run:T1.1",
      })
      expect(again.session).toBe(ask.session)
      expect(seen.created).toHaveLength(1)
      expect(seen.prompts).toEqual([
        { session: ask.session, agent: TaskHooks.VERIFIER, text: "judge T1.1.c1" },
        { session: ask.session, agent: TaskHooks.VERIFIER, text: "judge T1.1.c2" },
      ])
      expect(seen.order.filter((line) => line.startsWith("claim") || line.startsWith("prompt"))).toEqual([
        `claim ${ask.session}`,
        `prompt ${ask.session}`,
        `claim ${ask.session}`,
        `prompt ${ask.session}`,
      ])
    }),
  )
})

describe("scenarioJudge", () => {
  it.live(
    "asks a scenario's judge in the root checkout for its owner, again in a new session, and for a missing verdict",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const { run, seen } = yield* runOf({ plan, directory: "/root", stored: [facts().runStarted()] })
        const scenario = plan.spec.scenarios.find((item) => item.id === "S2")
        if (scenario === undefined) throw new Error("no S2")
        const owner = "scenario:run:S2"
        const ask = yield* TaskWorkers.scenarioJudge(run, { scenario, session: Option.none(), attempt: 1, owner })
        expect(seen.created).toEqual([{ directory: "in /root", title: "S2 verifier", agent: TaskHooks.VERIFIER }])
        expect(seen.claims).toEqual([{ session: ask.session, owner, watch: false }])
        const lines = (seen.prompts[0]?.text ?? "").split("\n")
        expect(lines[0]).toBe("task-harness role=verifier scenario=S2")
        expect(lines[1]).toBe(`judge S2: ${scenario.title}`)
        expect(lines).toContain(`You judge scenario S2: ${scenario.title}.`)
        for (const step of scenario.steps) expect(lines).toContain(step)
        // The judge gave no verdict: the second attempt asks in a new session.
        const again = yield* TaskWorkers.scenarioJudge(run, { scenario, session: Option.none(), attempt: 2, owner })
        expect(again.session).not.toBe(ask.session)
        expect(seen.created[1]).toEqual({
          directory: "in /root",
          title: "S2 verifier (again)",
          agent: TaskHooks.VERIFIER,
        })
        // A missing verdict is asked for in the same session, with no marker.
        const missing = yield* TaskWorkers.scenarioJudge(run, {
          scenario,
          session: Option.some(again.session),
          attempt: 2,
          owner,
        })
        expect(missing.session).toBe(again.session)
        expect(seen.created).toHaveLength(2)
        expect(seen.prompts[2]?.text.split("\n")[0]).toBe(`judge S2: ${scenario.title}`)
        expect(seen.prompts[2]?.text).not.toContain("task-harness role=")
        expect(seen.prompts.map((item) => item.agent)).toEqual([
          TaskHooks.VERIFIER,
          TaskHooks.VERIFIER,
          TaskHooks.VERIFIER,
        ])
      }),
  )
})

describe("merge", () => {
  it.live("merges the proved head, not a later commit on the branch, once, under the checkout lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const { run } = yield* runOf({ plan, directory: root })
      const tree = yield* TaskWorkspace.ensureWorktree(root, run.id, "T1.1", BASE, limits)
      yield* fs.writeFileString(path.join(tree.worktree, "proved.ts"), "export const proved = 1\n")
      const head = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 1")
      yield* fs.writeFileString(path.join(tree.worktree, "unproved.ts"), "export const unproved = 1\n")
      yield* TaskWorkspace.commitAll(tree.worktree, limits, "after ready")
      // The merge waits while another holds the checkout lock.
      const lock = yield* hold(run.locks.checkout)
      const merging = yield* Effect.forkChild(TaskWorkers.merge(run, head))
      expect(yield* waiting(merging)).toBe(true)
      expect(yield* TaskWorkspace.merged(root, limits, BASE, head)).toBe(false)
      yield* lock.release
      yield* Fiber.join(merging)
      const files = (yield* git(root, "ls-tree", "--name-only", `refs/heads/${BASE}`)).split("\n")
      expect(files).toContain("proved.ts")
      expect(files).not.toContain("unproved.ts")
      // A head already on the base branch is not merged again.
      const tip = yield* TaskWorkspace.baseHead(root, limits, BASE)
      yield* TaskWorkers.merge(run, head)
      expect(yield* TaskWorkspace.baseHead(root, limits, BASE)).toBe(tip)
    }),
  )

  it.live("retries a merge that fails while git's index lock is held, and fails once the retries run out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const { run } = yield* runOf({ plan, directory: root })
      const tree = yield* TaskWorkspace.ensureWorktree(root, run.id, "T1.1", BASE, limits)
      yield* fs.writeFileString(path.join(tree.worktree, "proved.ts"), "export const proved = 1\n")
      const head = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 1")
      const indexLock = path.join(root, ".git", "index.lock")
      // A concurrent git call holds the index for 300 ms: the first try fails, a retry merges.
      yield* fs.writeFileString(indexLock, "")
      yield* Effect.forkChild(Effect.sleep(300).pipe(Effect.andThen(fs.remove(indexLock))))
      yield* TaskWorkers.merge(run, head)
      expect(yield* TaskWorkspace.merged(root, limits, BASE, head)).toBe(true)

      // A lock that never clears: MERGE_RETRY more tries (200, 400 and 800 ms apart), then the error.
      yield* fs.writeFileString(path.join(tree.worktree, "next.ts"), "export const next = 1\n")
      const next = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 2")
      yield* fs.writeFileString(indexLock, "")
      const before = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(TaskWorkers.merge(run, next))
      const took = (yield* Clock.currentTimeMillis) - before
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("index.lock")
      expect(took).toBeGreaterThanOrEqual(1_300)
      expect(TaskWorkers.MERGE_RETRY).toBe(3)
      expect(yield* TaskWorkspace.merged(root, limits, BASE, next)).toBe(false)
    }),
  )
})

// A copy of the release-notes spec folder, its plan, and a run whose actor holds T1.1 trusted.
const specCopy = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const specDir = path.join(directory, "release-notes.spec")
  yield* fs.copy(path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec"), specDir)
  const loaded = yield* Blend.load(specDir)
  if (!loaded.spec) return yield* Effect.die(new Error("the copy did not load"))
  const plan = TaskCommand.plan({
    spec: loaded.spec,
    specPath: "release-notes.spec",
    path: "release-notes.spec",
    root: Option.none(),
  })
  return { directory, specDir, plan }
})

const verifyFile = (specDir: string, task: "T1.1" | "T1.2") =>
  path.join(
    specDir,
    "T1-release-notes.task",
    task === "T1.1" ? "T1.1-commit-parser.task" : "T1.2-version-bump.task",
    "VERIFY.md",
  )

describe("staleCheck", () => {
  it.live("finds the trusted obligations whose hash changed, with the new hash, and returns the reloaded spec", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { directory, specDir, plan } = yield* specCopy()
      const f = facts()
      const { run } = yield* runOf({
        plan,
        directory,
        specDir,
        stored: [f.runStarted(), ...trustLeaf(plan, f, "T1.1")],
      })
      const quiet = yield* TaskWorkers.staleCheck(run)
      expect(quiet.stale).toEqual([])
      expect(quiet.failures).toEqual([])
      expect(Option.isSome(quiet.spec)).toBe(true)
      // T1.1 (trusted) and T1.2 (pending) both change their first obligation's text.
      for (const task of ["T1.1", "T1.2"] as const) {
        const file = verifyFile(specDir, task)
        const text = yield* fs.readFileString(file)
        yield* fs.writeFileString(file, text.replace(/text: "/, 'text: "Changed. '))
      }
      const found = yield* TaskWorkers.staleCheck(run)
      const spec = Option.getOrThrow(found.spec)
      const reloaded = (id: string) => spec.obligations.find((item) => item.id === id)?.hash
      expect(found.stale.length).toBeGreaterThan(0)
      expect(found.stale.map((item) => item.id)).toContain("T1.1.c1")
      // Only trusted or passed obligations go stale, each with its new hash.
      for (const item of found.stale) {
        expect(item.id.startsWith("T1.1.")).toBe(true)
        expect(item.hash).toBe(reloaded(item.id) ?? "")
        expect(item.hash).not.toBe(plan.spec.obligations.find((each) => each.id === item.id)?.hash)
      }
      expect(spec.obligations.find((item) => item.id === "T1.1.c1")?.text.startsWith("Changed. ")).toBe(true)
    }),
  )

  it.live("reads the spec only under the checkout lock, and reports a spec that stops loading with its failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { directory, specDir, plan } = yield* specCopy()
      const { run } = yield* runOf({ plan, directory, specDir, stored: [facts().runStarted()] })
      const lock = yield* hold(run.locks.checkout)
      const checking = yield* Effect.forkChild(TaskWorkers.staleCheck(run))
      expect(yield* waiting(checking)).toBe(true)
      // The spec changes while the check waits: the check reads it after the lock is free.
      yield* fs.remove(path.join(specDir, "SPEC.md"))
      yield* lock.release
      const broken = yield* Fiber.join(checking)
      expect(broken.spec).toEqual(Option.none())
      expect(broken.stale).toEqual([])
      expect(broken.failures.length).toBeGreaterThan(0)
    }),
  )
})

describe("proof", () => {
  it.live("judges a parent's review-only obligations without running anything, and empties its proof log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const { run } = yield* runOf({ plan, directory: root, stored: [f.runStarted()] })
      const log = path.join(root, ".opencode", "task", "proofs", "T1.log")
      yield* fs.makeDirectory(path.dirname(log), { recursive: true })
      yield* fs.writeFileString(log, "the previous pass")
      // The checkout lock is held: a review-only proof needs no lock, so it still returns.
      const lock = yield* hold(run.locks.checkout)
      const proved = yield* TaskWorkers.proof(run, taskOf(plan, "T1"), plan.spec)
      yield* lock.release
      expect(proved).toEqual({ results: [{ id: "T1.e1", status: "needs-judge" }], reason: Option.none() })
      expect(yield* fs.readFileString(log)).toBe("")
    }),
  )

  it.live("proves a leaf in its worktree between its base and head, and fails the obligations no test proves", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const tree = yield* TaskWorkspace.ensureWorktree(root, "task_workersproof", "T1.1", BASE, limits)
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(path.join(tree.worktree, "src.ts"), "export const parsed = 1\n")
      const head = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 1")
      const started: Fact = {
        type: "task.started",
        at: 2,
        task: "T1.1",
        worktree: tree.worktree,
        branch: tree.branch,
        base: tree.base,
        session: "ses_T1.1",
      }
      const ready: Fact = { type: "task.ready", at: 3, task: "T1.1", head }
      const { run } = yield* runOf({ plan, directory: root, stored: [f.runStarted(), started, ready] })
      // The leaf proof runs in its worktree, not the root checkout: it takes no checkout lock.
      const lock = yield* hold(run.locks.checkout)
      const proved = yield* TaskWorkers.proof(run, taskOf(plan, "T1.1"), plan.spec)
      yield* lock.release
      const own = plan.spec.obligations.filter((item) => item.task === "T1.1").map((item) => item.id)
      // No test in the worktree carries an obligation's tag, so every T1.1 test obligation fails, with a reason.
      for (const id of own) {
        const result = proved.results.find((item) => item.id === id)
        expect(result?.status).toBe("failed")
        expect(result?.reason ?? "").not.toBe("")
      }
      expect(yield* fs.exists(path.join(root, ".opencode", "task", "proofs", "T1.1.log"))).toBe(true)
    }),
  )

  it.live("proves a stale obligation on the base branch in the root checkout, under the checkout lock", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const { run } = yield* runOf({
        plan,
        directory: root,
        stored: [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.stale("T1.1.c1")],
      })
      const lock = yield* hold(run.locks.checkout)
      const proving = yield* Effect.forkChild(TaskWorkers.proof(run, taskOf(plan, "T1.1"), plan.spec))
      expect(yield* waiting(proving)).toBe(true)
      yield* lock.release
      const proved = yield* Fiber.join(proving)
      // Only the stale obligation is proved again; no test proves it on the base branch.
      expect(proved.results.find((item) => item.id === "T1.1.c1")?.status).toBe("failed")
      expect(proved.results.some((item) => item.id === "T1.1.c2")).toBe(false)
    }),
  )
})

describe("an interrupted proof", () => {
  it.live("kills the proof's process group when the worker is interrupted mid-process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const tree = yield* TaskWorkspace.ensureWorktree(root, "task_workershang", "T1.1", BASE, limits)
      // A tagged test that writes its process id, then never ends.
      const pidFile = path.join(yield* fs.makeTempDirectoryScoped(), "pid")
      yield* fs.makeDirectory(path.join(tree.worktree, "test"), { recursive: true })
      yield* fs.writeFileString(
        path.join(tree.worktree, "test", "hang.test.ts"),
        [
          'import { test } from "bun:test"',
          'import { writeFileSync } from "fs"',
          `test("[T1.1.c1] hangs", async () => {`,
          // A child in the same process group: only a group kill ends it, a kill of the leader alone would not.
          '  const child = Bun.spawn(["sleep", "600"])',
          `  writeFileSync(${JSON.stringify(pidFile)}, \`\${process.pid} \${child.pid}\`)`,
          "  await new Promise(() => {})",
          "}, 600_000)",
          "",
        ].join("\n"),
      )
      const head = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 1")
      const started: Fact = {
        type: "task.started",
        at: 2,
        task: "T1.1",
        worktree: tree.worktree,
        branch: tree.branch,
        base: tree.base,
        session: "ses_T1.1",
      }
      const { run } = yield* runOf({
        plan,
        directory: root,
        stored: [facts().runStarted(), started, { type: "task.ready", at: 3, task: "T1.1", head }],
      })
      const proving = yield* Effect.forkChild(TaskWorkers.proof(run, taskOf(plan, "T1.1"), plan.spec))
      for (let tries = 0; tries < 400 && !(yield* fs.exists(pidFile)); tries++) yield* Effect.sleep(25)
      for (let tries = 0; tries < 200 && !(yield* fs.readFileString(pidFile)).includes(" "); tries++)
        yield* Effect.sleep(25)
      const pids = (yield* fs.readFileString(pidFile)).split(" ").map(Number)
      expect(pids).toHaveLength(2)
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      expect(pids.map(alive)).toEqual([true, true])
      yield* Fiber.interrupt(proving).pipe(Effect.timeout(10_000))
      // SIGTERM to the group, then SIGKILL after limits.cancelDeadline (1 s): the test process and its child both go.
      for (let tries = 0; tries < 120 && pids.some(alive); tries++) yield* Effect.sleep(25)
      expect(pids.map(alive)).toEqual([false, false])
    }),
  )
})

describe("scenarioProof", () => {
  it.live(
    "runs one batch on the base branch under the checkout lock: passed stays passed, an untested scenario fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* repository()
        yield* fs.makeDirectory(path.join(root, "test"), { recursive: true })
        yield* fs.writeFileString(
          path.join(root, "test", "scenarios.test.ts"),
          'import { test, expect } from "bun:test"\ntest("[S1] the notes render", () => expect(1).toBe(1))\n',
        )
        yield* git(root, "add", "-A")
        yield* git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "S1 test")
        const plan = yield* loadPlan("release-notes.spec")
        const { run } = yield* runOf({ plan, directory: root })
        const lock = yield* hold(run.locks.checkout)
        const proving = yield* Effect.forkChild(TaskWorkers.scenarioProof(run, ["S1", "S2"]))
        expect(yield* waiting(proving)).toBe(true)
        yield* lock.release
        const results = yield* Fiber.join(proving)
        expect(results.find((item) => item.id === "S1")).toEqual({ id: "S1", status: "passed" })
        expect(results.find((item) => item.id === "S2")?.status).toBe("failed")
        expect(results.map((item) => item.id).toSorted()).toEqual(["S1", "S2"])
      }),
  )
})

describe("record and touch", () => {
  it.live("record stores and folds through the run's Recorder; touch returns at once", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const { run, recorder } = yield* runOf({ plan, directory: "/root" })
      yield* TaskWorkers.record(run, { type: "run.started" })
      expect((yield* recorder.actor.getSnapshot).context.log.at(-1)?.to).toBeDefined()
      expect(yield* Effect.exit(TaskWorkers.touch(run))).toEqual(Exit.void)
    }),
  )
})

// A parent that keeps every event its invoked sessionEvents actor sends it.
const collector = (events: EventV2.Interface, session: string) =>
  setup({
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
    types: {} as { context: { got: ReadonlyArray<AnyEventObject> }; events: AnyEventObject },
    actors: { watch: TaskWorkers.sessionEvents },
  }).createMachine({
    context: { got: [] },
    invoke: { src: "watch", input: { events, session } },
    on: { "*": { actions: assign({ got: ({ context, event }) => [...context.got, event] }) } },
  })

describe("sessionEvents", () => {
  it.live("relays the session's part and status events as turn events, and ignores other sessions", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const session = SessionID.make("ses_worker_watch")
      const other = SessionID.make("ses_worker_other")
      const actor = yield* createActor(collector(events, session))
      yield* actor.start
      yield* Effect.sleep(50)
      const messageID = MessageID.ascending()
      const tool = (status: "running" | "completed") => ({
        id: PartID.ascending(),
        sessionID: session,
        messageID,
        type: "tool" as const,
        callID: "call_1",
        tool: "bash",
        state:
          status === "running"
            ? { status, input: {}, time: { start: 1 } }
            : { status, input: {}, output: "ok", title: "ls", metadata: {}, time: { start: 1, end: 2 } },
      })
      yield* events.publish(MessageV2.Event.PartDelta, {
        sessionID: other,
        messageID,
        partID: PartID.ascending(),
        field: "text",
        delta: "x",
      })
      yield* events.publish(MessageV2.Event.PartDelta, {
        sessionID: session,
        messageID,
        partID: PartID.ascending(),
        field: "text",
        delta: "x",
      })
      yield* events.publish(MessageV2.Event.PartUpdated, { sessionID: session, part: tool("running"), time: 1 })
      yield* events.publish(MessageV2.Event.PartUpdated, { sessionID: session, part: tool("completed"), time: 2 })
      yield* events.publish(SessionStatus.Event.Status, {
        sessionID: session,
        status: { type: "retry", attempt: 1, message: "insufficient_quota", next: 0 },
      })
      yield* events.publish(SessionStatus.Event.Status, { sessionID: session, status: { type: "idle" } })
      yield* events.publish(SessionStatus.Event.Status, { sessionID: other, status: { type: "busy" } })
      for (let tries = 0; tries < 200 && (yield* actor.getSnapshot).context.got.length < 7; tries++)
        yield* Effect.sleep(10)
      yield* Effect.sleep(50)
      expect((yield* actor.getSnapshot).context.got).toEqual([
        { type: "turn.activity" },
        { type: "turn.activity" },
        { type: "turn.tool", running: true },
        { type: "turn.activity" },
        { type: "turn.tool", running: false },
        { type: "turn.status", status: "retry", message: "insufficient_quota" },
        { type: "turn.status", status: "idle" },
      ])
      // Once the actor stops, its relay stops: later events reach nobody.
      yield* actor.stop
      yield* events.publish(SessionStatus.Event.Status, { sessionID: session, status: { type: "busy" } })
      yield* Effect.sleep(50)
      expect((yield* actor.getSnapshot).context.got).toHaveLength(7)
    }),
  )
})
