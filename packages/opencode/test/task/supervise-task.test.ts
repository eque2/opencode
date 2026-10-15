import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Clock, Deferred, Duration, Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect"
import path from "path"
import { type AnyActorLogic, createActor, fromEffect, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { BackgroundJob } from "@/background/job"
import type { BlendModel } from "@/task/blend/model"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { InstanceStore } from "@/project/instance-store"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import { TaskHooks } from "@/task/core/hooks"
import type { Fact, Plan, Verdict } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import type { TaskSessions } from "@/task/core/sessions"
import { TaskSupervisor } from "@/task/core/supervise/task"
import { TaskWorkers } from "@/task/core/workers"
import { TaskWorkspace } from "@/task/core/workspace"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, loadPlan } from "./lib/machine"

// The task supervisor (spine AD-8, AD-10, AD-11, D7). Each test plays the run supervisor's part: it sends
// `unit.moved` for the task's newest history entry, read from the run actor. The facts go through a real Recorder
// into the real event store; the session side is a scripted boundary whose prompts can call the harness tools.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const scripted = TaskLimits.scripted
const BASE = "dev"
const PHASES = ["ready", "building", "proving", "verifying"]

const git = (cwd: string, ...args: ReadonlyArray<string>) => TaskWorkspace.git(cwd, scripted, ...args)

const repository = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  yield* git(root, "init", "-q", "-b", BASE)
  yield* fs.writeFileString(path.join(root, "tracked.ts"), "export const tracked = 1\n")
  yield* git(root, "add", "-A")
  yield* git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "seed")
  yield* TaskWorkspace.ensureExcluded(root, scripted)
  return root
})

/** What one prompt of the session boundary does while it runs: it may call a harness tool, then it ends or hangs. */
type Turn = (prompt: { readonly session: string; readonly agent: string; readonly text: string }) => Effect.Effect<void>

interface Seen {
  readonly order: Array<string>
  readonly prompts: Array<{ readonly session: string; readonly agent: string; readonly text: string }>
  readonly cancels: Array<string>
  readonly claims: Array<{ readonly session: string; readonly owner: string; readonly watch: boolean }>
}

// A session boundary whose prompts follow `turns` in order (a prompt past the end just ends).
const boundary = (turns: ReadonlyArray<Turn>, messages: ReadonlyArray<unknown> = []) => {
  const seen: Seen = { order: [], prompts: [], cancels: [], claims: [] }
  let created = 0
  const sessions = {
    create: () => Effect.sync(() => ({ id: SessionID.make(`ses_judge_${++created}`) })),
    messages: () => Effect.succeed(messages),
  }
  const instances = {
    provide: <A, E, R>(_load: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) => effect,
  }
  const env: TaskSessions.Env = {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers call only create and messages
    sessions: sessions as unknown as Session.Interface,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers never read the status service
    status: {} as SessionStatus.Interface,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers call only provide
    instances: instances as unknown as InstanceStore.Interface,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the session events come from the supervisor's input
    events: {} as TaskSessions.Env["events"],
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers never read the background jobs
    background: {} as BackgroundJob.Interface,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers never read the database
    db: {} as TaskSessions.Env["db"],
    ops: {
      prompt: (input) => {
        const prompt = { session: input.sessionID, agent: input.agent, text: input.parts[0]?.text ?? "" }
        const turn = turns[seen.prompts.length] ?? (() => Effect.void)
        return Effect.sync(() => {
          seen.prompts.push(prompt)
          seen.order.push(`prompt ${prompt.session}`)
        }).pipe(
          Effect.andThen(turn(prompt)),
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers never read the turn's last message
          Effect.as({} as SessionV1.WithParts),
        )
      },
      cancel: (session) => Effect.sync(() => seen.cancels.push(session)),
      currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
      say: () => Effect.void,
    },
  }
  return { env, seen }
}

let runs = 0

interface Setup {
  readonly plan: Plan
  readonly directory: string
  readonly stored: ReadonlyArray<Fact>
  readonly turns?: ReadonlyArray<Turn>
  readonly messages?: ReadonlyArray<unknown>
  readonly limits?: TaskLimits.Limits
  readonly claim?: TaskWorkers.Run["claim"]
}

// A run: its Recorder over the stored facts, its locks, and the scripted session boundary.
const runOf = Effect.fnUntraced(function* (setup: Setup) {
  const id = `task_supervise${(runs++).toString(16).padStart(4, "0")}`
  const events = yield* EventV2Bridge.Service
  const recorder = yield* TaskRecorder.make({
    plan: setup.plan,
    runID: id,
    directory: setup.directory,
    stored: setup.stored,
    events,
    write: () => Effect.void,
  })
  const { env, seen } = boundary(setup.turns ?? [], setup.messages)
  const run: TaskWorkers.Run = {
    env,
    id,
    directory: setup.directory,
    base: BASE,
    specDir: setup.directory,
    plan: setup.plan,
    root: SessionID.make("ses_supervise_root"),
    model: { providerID: "test", modelID: "test" },
    limits: setup.limits ?? scripted,
    locks: { checkout: yield* Semaphore.make(1), git: yield* Semaphore.make(1) },
    recorder,
    claim:
      setup.claim ??
      ((claim) =>
        Effect.sync(() => {
          seen.claims.push(claim)
          seen.order.push(`claim ${claim.session}`)
        })),
  }
  return { run, seen, recorder, events, id }
})

type Run = Effect.Success<ReturnType<typeof runOf>>

const taskOf = (plan: Plan, id: string) => {
  const task = plan.spec.tasks.find((each) => each.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  return task
}

// A unit as the run supervisor sees it: its newest entry, state, tags and session.
const unitOf = (snapshot: RunSnapshot, id: string) => {
  const entry = snapshot.context.log.findLastIndex((item) => item.unit === id)
  const session = TaskEngineXState.view(snapshot).tasks[id]?.session
  return {
    entry,
    at: snapshot.context.log[entry]?.at ?? 0,
    state: TaskEngineXState.unitState(snapshot, id) ?? "",
    tags: [...TaskEngineXState.tags(snapshot, id), ...PHASES.filter((tag) => snapshot.hasTag(`${id}:${tag}`))],
    ...(session === undefined ? {} : { session }),
  }
}

// The newest entry the test has sent (or spawned with) for each run's task.
const sent = new Map<string, number>()

interface SpawnOptions {
  readonly clock?: SimulatedClock
  readonly actors?: Parameters<typeof TaskSupervisor.machine.provide>[0]["actors"]
  readonly runStart?: number
  readonly start?: { readonly start: number; readonly now: number }
  readonly owner?: string
}

// The spawn input of `task`'s supervisor for the unit as the run actor holds it now.
const inputOf = Effect.fnUntraced(function* (
  setup: Run & { readonly plan: Plan },
  task: string,
  options: SpawnOptions,
) {
  const unit = unitOf(yield* setup.recorder.actor.getSnapshot, task)
  sent.set(`${setup.id}:${task}`, unit.entry)
  return {
    run: setup.run,
    events: setup.events,
    task: taskOf(setup.plan, task),
    spec: setup.plan.spec,
    owner: options.owner ?? `task:${setup.id}:${task}`,
    entry: unit.entry,
    tags: unit.tags,
    ...(unit.session === undefined ? {} : { session: unit.session }),
    runStart: options.runStart ?? 0,
    ...(options.start === undefined ? {} : { clock: options.start }),
  } satisfies TaskSupervisor.Input
})

// Spawns the supervisor of `task` for the unit as the run actor holds it now.
const spawn = Effect.fnUntraced(function* (
  setup: Run & { readonly plan: Plan },
  task: string,
  options: SpawnOptions = {},
) {
  const logic = options.actors ? TaskSupervisor.machine.provide({ actors: options.actors }) : TaskSupervisor.machine
  const actor = yield* createActor(logic, {
    input: yield* inputOf(setup, task, options),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  yield* actor.start
  return actor
})

type Supervisor = Effect.Success<ReturnType<typeof spawn>>

const quiet = (actor: Supervisor) =>
  eventually(
    Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches({ live: { work: "quiet" } })),
    "the supervisor is quiet",
  )

// The run supervisor's part: `unit.moved` for the task's newest entry. A record from a worker reaches the run actor
// through its mailbox, so the move waits until the run actor holds an entry newer than the last one sent.
const move = Effect.fnUntraced(function* (
  setup: Run,
  actor: { send: (event: TaskSupervisor.UnitMoved) => Effect.Effect<void> },
  task: string,
) {
  const key = `${setup.id}:${task}`
  const after = sent.get(key) ?? -1
  for (let tries = 0; tries < 400; tries++) {
    if (unitOf(yield* setup.recorder.actor.getSnapshot, task).entry > after) break
    yield* Effect.sleep(10)
  }
  const unit = unitOf(yield* setup.recorder.actor.getSnapshot, task)
  if (unit.entry <= after) return yield* Effect.die(new Error(`no new entry of ${task} after ${after}`))
  sent.set(key, unit.entry)
  const event: TaskSupervisor.UnitMoved = { type: "unit.moved", unit: task, latest: true, ...unit }
  yield* actor.send(event)
  return event
})

// The facts the run recorded: its stored slice is given to the Recorder, never published, so only new facts show.
const storedTypes = Effect.fnUntraced(function* (id: string) {
  const db = yield* Database.Service
  return (yield* TaskEvents.read(db.db, id)).map((fact) => fact.type)
})

const storedFacts = Effect.fnUntraced(function* (id: string) {
  const db = yield* Database.Service
  return yield* TaskEvents.read(db.db, id)
})

// Waits until `check` holds (the workers and the relay run on their own fibers).
const eventually = Effect.fnUntraced(function* (
  check: Effect.Effect<boolean, unknown, Database.Service>,
  what: string,
) {
  for (let tries = 0; tries < 400; tries++) {
    if (yield* check) return yield* Effect.void
    yield* Effect.sleep(10)
  }
  return yield* Effect.die(new Error(`never: ${what}`))
})

const stored = (id: string, count: number) =>
  eventually(
    Effect.map(storedTypes(id), (types) => types.length >= count),
    `${count} stored facts`,
  )

const prompted = (seen: Seen, count: number) =>
  eventually(
    Effect.sync(() => seen.prompts.length >= count),
    `${count} prompts`,
  )

// A worktree of `task` in `root`, and the task.started fact that names it.
const started = Effect.fnUntraced(function* (root: string, runID: string, task: string, at: number) {
  const tree = yield* TaskWorkspace.ensureWorktree(root, runID, task, BASE, scripted)
  const fact: Fact = {
    type: "task.started",
    at,
    task,
    worktree: tree.worktree,
    branch: tree.branch,
    base: tree.base,
    session: `ses_${task}`,
  }
  return { tree, fact }
})

const obligationIds = (plan: Plan, task: string) =>
  plan.spec.obligations.filter((item) => item.task === task).map((item) => item.id)

// A proof stand-in for the orchestration tests: it records the given results (the proofs are tested in workers).
const proving = (
  results: (
    task: string,
  ) => ReadonlyArray<{ id: string; status: "passed" | "failed" | "needs-judge"; reason?: string }>,
) =>
  fromEffect(({ input }: { input: { run: TaskWorkers.Run; task: BlendModel.Task; spec: BlendModel.Spec } }) =>
    Effect.gen(function* () {
      // The real proof needs the file system; so does its stand-in's type.
      yield* FileSystem.FileSystem
      yield* Path.Path
      yield* TaskWorkers.record(input.run, {
        type: "task.proved",
        task: input.task.id,
        results: results(input.task.id),
      })
    }),
  )

describe("the task supervisor's phases", () => {
  it.live(
    "begins a ready leaf, builds until task_ready, proves, verifies with ask, collect and askMissing, then merges",
    () =>
      Effect.gen(function* () {
        const root = yield* repository()
        const plan = yield* loadPlan("release-notes.spec")
        const ids = obligationIds(plan, "T1.1")
        const holder: { actor?: { send: (event: TaskHooks.HookEvent) => Effect.Effect<void> } } = {}
        const hook = (event: TaskHooks.HookEvent) => (holder.actor ? holder.actor.send(event) : Effect.void)
        const trusted = (list: ReadonlyArray<string>): ReadonlyArray<Verdict> =>
          list.map((id) => ({ id, verdict: "trusted" }))
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        const turns: ReadonlyArray<Turn> = [
          // The builder writes its work and calls task_ready.
          (prompt) =>
            Effect.gen(function* () {
              const tree = TaskWorkspace.worktreePath(paths, root, setup.id, "T1.1")
              yield* fs.writeFileString(path.join(tree, "parser.ts"), "export const parse = 1\n").pipe(Effect.orDie)
              yield* hook({ type: "hook.ready", session: prompt.session, summary: "parser done" })
            }),
          // The verifier judges three of the five ids, then the other two when asked again.
          (prompt) => hook({ type: "hook.verdicts", session: prompt.session, verdicts: trusted(ids.slice(0, 3)) }),
          (prompt) => hook({ type: "hook.verdicts", session: prompt.session, verdicts: trusted(ids.slice(3)) }),
        ]
        const f = facts()
        const setup = { plan, ...(yield* runOf({ plan, directory: root, stored: [f.runStarted()], turns })) }
        const actor = yield* spawn(setup, "T1.1", {
          actors: { prove: proving((task) => obligationIds(plan, task).map((id) => ({ id, status: "needs-judge" }))) },
        })
        holder.actor = actor
        // ready → begin → task.started, then quiet: no prompt before the run supervisor's next unit.moved.
        yield* stored(setup.id, 1)
        yield* quiet(actor)
        expect(setup.seen.prompts).toEqual([])
        yield* move(setup, actor, "T1.1")
        yield* stored(setup.id, 2)
        // building → one builder turn with the attempt's message, claimed first, then task.ready.
        expect(setup.seen.prompts).toHaveLength(1)
        expect(setup.seen.prompts[0]?.agent).toBe(TaskHooks.BUILDER)
        expect(setup.seen.prompts[0]?.text.split("\n")[0]).toBe("task-harness role=builder task=T1.1")
        const builder = setup.seen.prompts[0]?.session ?? ""
        expect(setup.seen.claims[0]).toEqual({ session: builder, owner: `task:${setup.id}:T1.1`, watch: true })
        expect(setup.seen.order.slice(0, 2)).toEqual([`claim ${builder}`, `prompt ${builder}`])
        yield* quiet(actor)
        yield* move(setup, actor, "T1.1")
        yield* stored(setup.id, 3)
        yield* quiet(actor)
        yield* move(setup, actor, "T1.1")
        yield* stored(setup.id, 4)
        expect(yield* storedTypes(setup.id)).toEqual(["task.started", "task.ready", "task.proved", "task.verified"])
        // The verifier round: the judge message, then the missing ids in the same session.
        const [, ask, missing] = setup.seen.prompts
        expect(ask?.agent).toBe(TaskHooks.VERIFIER)
        expect(ask?.text.split("\n").filter((line) => line.startsWith("judge "))).toHaveLength(ids.length)
        expect(missing?.session).toBe(ask?.session)
        expect(missing?.text.split("\n").filter((line) => line.startsWith("judge "))).toEqual(
          ids.slice(3).map((id) => `judge ${id}: ${plan.spec.obligations.find((item) => item.id === id)?.text ?? ""}`),
        )
        const verified = (yield* storedFacts(setup.id)).at(-1)
        expect(verified).toMatchObject({ type: "task.verified", task: "T1.1", verdicts: trusted(ids) })
        // The proved head is on the base branch now.
        const ready = (yield* storedFacts(setup.id)).find((fact) => fact.type === "task.ready")
        const head = ready?.type === "task.ready" ? ready.head : ""
        expect(yield* TaskWorkspace.merged(root, scripted, BASE, head)).toBe(true)
        yield* eventually(
          Effect.map(
            setup.recorder.actor.getSnapshot,
            (snapshot) => TaskEngineXState.unitState(snapshot, "T1.1") === "trusted",
          ),
          "T1.1 trusted",
        )
        yield* quiet(actor)
      }),
  )
})

// A prompt that never ends: the turn runs until the supervisor stops it.
const hang: Turn = () => Effect.never

const delta = (events: EventV2.Interface, session: string) =>
  events.publish(MessageV2.Event.PartDelta, {
    sessionID: SessionID.make(session),
    messageID: MessageID.ascending(),
    partID: PartID.ascending(),
    field: "text",
    delta: "x",
  })

const tool = (events: EventV2.Interface, session: string, status: "running" | "completed") =>
  events.publish(MessageV2.Event.PartUpdated, {
    sessionID: SessionID.make(session),
    part: {
      id: PartID.ascending(),
      sessionID: SessionID.make(session),
      messageID: MessageID.ascending(),
      type: "tool" as const,
      callID: "call_1",
      tool: "bash",
      state:
        status === "running"
          ? { status, input: {}, time: { start: 1 } }
          : { status, input: {}, output: "ok", title: "ls", metadata: {}, time: { start: 1, end: 2 } },
    },
    time: 1,
  })

// Lets the relay and the supervisor take what was just published.
const settle = Effect.sleep(60)

const CONTINUE = "Continue the task from where you stopped. When it is done, call task_ready once and end your turn."
const NUDGE = "Call task_ready when the task is done."

describe("the builder watch (D7)", () => {
  it.live(
    "SV10 stalls a silent turn after streamIdle, records task.stalled and continues once in the same attempt",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const f = facts()
        const clock = new SimulatedClock()
        const setup = {
          plan,
          ...(yield* runOf({
            plan,
            directory: "/root",
            stored: [f.runStarted(), f.started("T1.1")],
            turns: [hang, hang],
          })),
        }
        const actor = yield* spawn(setup, "T1.1", { clock })
        yield* prompted(setup.seen, 1)
        yield* settle
        // Activity after 1.5 s restarts the 2 s timer: 3 s in, nothing has stalled.
        yield* clock.increment(1_500)
        yield* delta(setup.events, "ses_T1.1")
        yield* settle
        yield* clock.increment(1_500)
        yield* settle
        expect(yield* storedTypes(setup.id)).toEqual([])
        yield* clock.increment(600)
        yield* stored(setup.id, 1)
        expect((yield* storedFacts(setup.id))[0]).toMatchObject({
          type: "task.stalled",
          task: "T1.1",
          reason: "stall: no stream activity for 2 s",
        })
        // The stalled turn was cancelled; the stall spends no nudge.
        expect(setup.seen.cancels).toEqual(["ses_T1.1"])
        yield* quiet(actor)
        expect((yield* actor.getSnapshot).context.nudges).toBe(0)
        // The entry of the stall: exactly one continue prompt, even when the same unit.moved comes twice.
        const event = yield* move(setup, actor, "T1.1")
        yield* prompted(setup.seen, 2)
        yield* actor.send(event)
        yield* settle
        expect(setup.seen.prompts.map((item) => item.text.split("\n")[0])).toEqual([
          "task-harness role=builder task=T1.1",
          CONTINUE,
        ])
        expect(yield* storedTypes(setup.id)).toEqual(["task.stalled"])
      }),
  )

  it.live("SV23 runs no stall timer while a tool runs, and starts it again when the tool ends", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const clock = new SimulatedClock()
      const setup = {
        plan,
        ...(yield* runOf({ plan, directory: "/root", stored: [f.runStarted(), f.started("T1.1")], turns: [hang] })),
      }
      yield* spawn(setup, "T1.1", { clock })
      yield* prompted(setup.seen, 1)
      yield* settle
      yield* tool(setup.events, "ses_T1.1", "running")
      yield* settle
      yield* clock.increment(10_000)
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* tool(setup.events, "ses_T1.1", "completed")
      yield* settle
      yield* clock.increment(1_900)
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* clock.increment(200)
      yield* stored(setup.id, 1)
      expect(yield* storedTypes(setup.id)).toEqual(["task.stalled"])
    }),
  )

  it.live("SV11 records task.needs_human for a spend-cap retry status, before any nudge, and cancels the turn", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const setup = {
        plan,
        ...(yield* runOf({ plan, directory: "/root", stored: [f.runStarted(), f.started("T1.1")], turns: [hang] })),
      }
      const actor = yield* spawn(setup, "T1.1")
      yield* prompted(setup.seen, 1)
      yield* settle
      yield* setup.events.publish(SessionStatus.Event.Status, {
        sessionID: SessionID.make("ses_T1.1"),
        status: { type: "retry", attempt: 1, message: "You exceeded your current quota", next: 0 },
      })
      yield* stored(setup.id, 1)
      expect(yield* storedFacts(setup.id)).toMatchObject([
        { type: "task.needs_human", task: "T1.1", reason: "spend cap: You exceeded your current quota" },
      ])
      expect(setup.seen.cancels).toEqual(["ses_T1.1"])
      yield* quiet(actor)
      expect(yield* storedTypes(setup.id)).toEqual(["task.needs_human"])
    }),
  )

  it.live("SV11 records task.needs_human for a spend cap that ended the turn, not a nudge", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const now = yield* Clock.currentTimeMillis
      const capped = {
        info: {
          role: "assistant",
          time: { created: now + 60_000 },
          error: { data: { message: "insufficient_quota" } },
        },
        parts: [],
      }
      const setup = {
        plan,
        ...(yield* runOf({
          plan,
          directory: "/root",
          stored: [f.runStarted(), f.started("T1.1")],
          messages: [capped],
        })),
      }
      const actor = yield* spawn(setup, "T1.1")
      yield* stored(setup.id, 1)
      yield* quiet(actor)
      expect(yield* storedFacts(setup.id)).toMatchObject([
        { type: "task.needs_human", task: "T1.1", reason: "spend cap: insufficient_quota" },
      ])
    }),
  )
})

// The supervisor of a test, once spawned: a turn can start before `spawn` returns, so a turn waits for it.
const spawned = (holder: { actor?: Supervisor }): Effect.Effect<Supervisor> =>
  Effect.suspend(() =>
    holder.actor ? Effect.succeed(holder.actor) : Effect.sleep(5).pipe(Effect.andThen(spawned(holder))),
  )

const REPEATED = "repetition: 3 identical bash calls in a row"

describe("the end of a turn (AD-11)", () => {
  it.live("records task.repeated for a turn that repeated itself, before its task_ready and with no nudge", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const holder: { actor?: Supervisor } = {}
      // prompt.ts stopped the turn on the repetition after the builder had also called task_ready.
      const repeating: Turn = (prompt) =>
        Effect.gen(function* () {
          const actor = yield* spawned(holder)
          yield* actor.send({ type: "hook.ready", session: prompt.session })
          yield* actor.send({ type: "hook.repeated", session: prompt.session, reason: REPEATED })
        })
      const setup = {
        plan,
        ...(yield* runOf({
          plan,
          directory: "/root",
          stored: [f.runStarted(), f.started("T1.1")],
          turns: [repeating],
        })),
      }
      const actor = yield* spawn(setup, "T1.1")
      holder.actor = actor
      yield* stored(setup.id, 1)
      yield* quiet(actor)
      yield* settle
      expect(yield* storedFacts(setup.id)).toMatchObject([{ type: "task.repeated", task: "T1.1", reason: REPEATED }])
      expect(yield* storedTypes(setup.id)).toEqual(["task.repeated"])
      // The next building entry is a new attempt: its message, and no nudge spent.
      const context = (yield* actor.getSnapshot).context
      expect(context.prompt).toBe("attempt")
      expect(context.nudges).toBe(0)
    }),
  )

  it.live("records a spend cap that ended the turn before a repetition in the same turn", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const now = yield* Clock.currentTimeMillis
      const capped = {
        info: {
          role: "assistant",
          time: { created: now + 60_000 },
          error: { data: { message: "insufficient_quota" } },
        },
        parts: [],
      }
      const holder: { actor?: Supervisor } = {}
      const repeating: Turn = (prompt) =>
        Effect.flatMap(spawned(holder), (actor) =>
          actor.send({ type: "hook.repeated", session: prompt.session, reason: REPEATED }),
        )
      const setup = {
        plan,
        ...(yield* runOf({
          plan,
          directory: "/root",
          stored: [f.runStarted(), f.started("T1.1")],
          turns: [repeating],
          messages: [capped],
        })),
      }
      const actor = yield* spawn(setup, "T1.1")
      holder.actor = actor
      yield* stored(setup.id, 1)
      yield* quiet(actor)
      yield* settle
      expect(yield* storedFacts(setup.id)).toMatchObject([
        { type: "task.needs_human", task: "T1.1", reason: "spend cap: insufficient_quota" },
      ])
    }),
  )
})

describe("nudges and attempts", () => {
  it.live("SV12 nudges twice, then commits the work and fails its proofs with the builder's missing task_ready", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const id = "task_supervisenudges"
      const begun = yield* started(root, id, "T1.1", 2)
      const setup = { plan, ...(yield* runOf({ plan, directory: root, stored: [f.runStarted(), begun.fact] })) }
      const actor = yield* spawn(setup, "T1.1")
      // The supervisor holds the hooks' state: the repetition limit prompt.ts reads, the nudge count.
      expect((yield* actor.getSnapshot).context.limit).toBe(3)
      yield* stored(setup.id, 1)
      yield* quiet(actor)
      expect((yield* actor.getSnapshot).context.nudges).toBe(1)
      const first = yield* move(setup, actor, "T1.1")
      yield* stored(setup.id, 2)
      // A repeated unit.moved for an entry already taken starts no second turn.
      yield* actor.send(first)
      yield* quiet(actor)
      yield* move(setup, actor, "T1.1")
      yield* stored(setup.id, 4)
      yield* quiet(actor)
      const recorded = yield* storedFacts(setup.id)
      expect(recorded.map((fact) => fact.type)).toEqual(["task.nudged", "task.nudged", "task.ready", "task.proved"])
      expect(recorded[0]).toMatchObject({ nudge: 1, reason: "the builder ended without task_ready" })
      expect(recorded[1]).toMatchObject({ nudge: 2, reason: "the builder ended without task_ready" })
      const head = yield* TaskWorkspace.commit(begun.tree.worktree, scripted, "HEAD")
      expect(recorded[2]).toMatchObject({ type: "task.ready", head })
      const tests = plan.spec.obligations.filter((item) => item.task === "T1.1" && item.proof.kind === "test")
      expect(recorded[3]).toMatchObject({
        type: "task.proved",
        reason: "the builder ended without task_ready",
        results: tests.map((item) => ({
          id: item.id,
          status: "failed",
          reason: "the builder ended without task_ready",
        })),
      })
      expect(setup.seen.prompts.map((item) => item.text.split("\n")[0])).toEqual([
        "task-harness role=builder task=T1.1",
        NUDGE,
        NUDGE,
      ])
      // SV13: each turn claims its session first.
      expect(setup.seen.order).toEqual(
        setup.seen.prompts.flatMap((item) => [`claim ${item.session}`, `prompt ${item.session}`]),
      )
      expect(setup.seen.claims.every((claim) => claim.watch && claim.owner === `task:${setup.id}:T1.1`)).toBe(true)
    }),
  )

  it.live("starts attempt 2 after a failed proof with no nudge spent and no task_ready left from attempt 1", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const begun = yield* started(root, "task_superviseattempt", "T1.1", 2)
      const holder: { actor?: Supervisor } = {}
      const turns: ReadonlyArray<Turn> = [
        () => Effect.void,
        (prompt) => (holder.actor ? holder.actor.send({ type: "hook.ready", session: prompt.session }) : Effect.void),
        () => Effect.void,
      ]
      const setup = { plan, ...(yield* runOf({ plan, directory: root, stored: [f.runStarted(), begun.fact], turns })) }
      const actor = yield* spawn(setup, "T1.1", {
        actors: {
          prove: proving((task) =>
            obligationIds(plan, task).map((id) =>
              id === "T1.1.c1" ? { id, status: "failed", reason: "expected 2, got 3" } : { id, status: "needs-judge" },
            ),
          ),
        },
      })
      holder.actor = actor
      yield* stored(setup.id, 1) // nudge 1
      yield* quiet(actor)
      yield* move(setup, actor, "T1.1")
      yield* stored(setup.id, 2) // task.ready
      yield* quiet(actor)
      yield* move(setup, actor, "T1.1")
      yield* stored(setup.id, 3) // task.proved, c1 failed
      yield* quiet(actor)
      // A task_ready that arrives between the attempts must not count for attempt 2.
      yield* actor.send({ type: "hook.ready", session: "ses_T1.1" })
      yield* move(setup, actor, "T1.1")
      yield* stored(setup.id, 4)
      yield* quiet(actor)
      const recorded = yield* storedFacts(setup.id)
      expect(recorded.map((fact) => fact.type)).toEqual(["task.nudged", "task.ready", "task.proved", "task.nudged"])
      expect(recorded[3]).toMatchObject({ nudge: 1 })
      const third = (setup.seen.prompts[2]?.text ?? "").split("\n")
      expect(third).toContain("task-harness attempt=2")
      expect(third).toContain("reopen T1.1.c1: expected 2, got 3")
      expect((yield* actor.getSnapshot).context.nudges).toBe(1)
    }),
  )
})

describe("worker failures (SV6, SV9, SV27)", () => {
  it.live("SV6 records task.failed with harness error after three failures in a row", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const clock = new SimulatedClock()
      const setup = {
        plan,
        ...(yield* runOf({ plan, directory: "/root", stored: [f.runStarted(), f.started("T1.1"), f.ready("T1.1")] })),
      }
      let tries = 0
      const failing = fromEffect(
        ({ input }: { input: { run: TaskWorkers.Run; task: BlendModel.Task; spec: BlendModel.Spec } }) =>
          Effect.gen(function* () {
            yield* FileSystem.FileSystem
            yield* Path.Path
            tries++
            return yield* new TaskWorkers.WorkerError({ message: `the proof of ${input.task.id} broke` })
          }).pipe(Effect.asVoid),
      )
      yield* spawn(setup, "T1.1", { clock, actors: { prove: failing } })
      yield* eventually(
        Effect.sync(() => tries === 1),
        "the first try",
      )
      yield* settle
      yield* clock.increment(1_000)
      yield* eventually(
        Effect.sync(() => tries === 2),
        "the second try",
      )
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* clock.increment(1_000)
      yield* stored(setup.id, 1)
      expect(tries).toBe(3)
      expect(yield* storedFacts(setup.id)).toMatchObject([
        { type: "task.failed", task: "T1.1", reason: "harness error: the proof of T1.1 broke" },
      ])
    }),
  )

  it.live("resets the failure count on a success", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const clock = new SimulatedClock()
      const setup = {
        plan,
        ...(yield* runOf({ plan, directory: "/root", stored: [f.runStarted(), f.started("T1.1"), f.ready("T1.1")] })),
      }
      let proofs = 0
      // Fails twice, succeeds on the third try, then fails on every later try.
      const flaky = fromEffect(
        ({ input }: { input: { run: TaskWorkers.Run; task: BlendModel.Task; spec: BlendModel.Spec } }) =>
          Effect.gen(function* () {
            yield* FileSystem.FileSystem
            yield* Path.Path
            proofs++
            if (proofs !== 3) return yield* new TaskWorkers.WorkerError({ message: "flaky" })
            const results = obligationIds(plan, input.task.id).map((id) => ({ id, status: "needs-judge" as const }))
            return yield* TaskWorkers.record(input.run, { type: "task.proved", task: input.task.id, results })
          }).pipe(Effect.asVoid),
      )
      const actor = yield* spawn(setup, "T1.1", { clock, actors: { prove: flaky } })
      yield* eventually(
        Effect.sync(() => proofs === 1),
        "proof 1",
      )
      yield* settle
      yield* clock.increment(1_000)
      yield* eventually(
        Effect.sync(() => proofs === 2),
        "proof 2",
      )
      yield* settle
      yield* clock.increment(1_000)
      yield* stored(setup.id, 1)
      yield* quiet(actor)
      expect((yield* actor.getSnapshot).context.failures).toBe(0)
      // A later proving entry: two more failures stay under the limit, as the count started again at the success.
      yield* actor.send({
        type: "unit.moved",
        unit: "T1.1",
        entry: 100,
        state: "proving",
        tags: ["active", "proving"],
        latest: true,
        at: 0,
      })
      yield* eventually(
        Effect.sync(() => proofs === 4),
        "proof 4",
      )
      yield* settle
      yield* clock.increment(1_000)
      yield* eventually(
        Effect.sync(() => proofs === 5),
        "proof 5",
      )
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual(["task.proved"])
      expect((yield* actor.getSnapshot).context.failures).toBe(2)
    }),
  )

  it.live("SV9 a task_ready during the proofs records nothing: only the proof's fact follows", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const release = yield* Deferred.make<void>()
      const setup = {
        plan,
        ...(yield* runOf({ plan, directory: "/root", stored: [f.runStarted(), f.started("T1.1"), f.ready("T1.1")] })),
      }
      const held = fromEffect(
        ({ input }: { input: { run: TaskWorkers.Run; task: BlendModel.Task; spec: BlendModel.Spec } }) =>
          Effect.gen(function* () {
            yield* FileSystem.FileSystem
            yield* Path.Path
            yield* Deferred.await(release)
            const results = obligationIds(plan, input.task.id).map((id) => ({ id, status: "needs-judge" as const }))
            return yield* TaskWorkers.record(input.run, { type: "task.proved", task: input.task.id, results })
          }),
      )
      const actor = yield* spawn(setup, "T1.1", { actors: { prove: held } })
      yield* settle
      yield* actor.send({ type: "hook.ready", session: "ses_T1.1" })
      yield* actor.send({
        type: "hook.repeated",
        session: "ses_T1.1",
        reason: "repetition: 3 identical bash calls in a row",
      })
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* Deferred.succeed(release, undefined)
      yield* stored(setup.id, 1)
      yield* quiet(actor)
      expect(yield* storedTypes(setup.id)).toEqual(["task.proved"])
    }),
  )

  it.live("SV27 a stopped supervisor cancels its turn, counts no failure and records nothing", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const setup = {
        plan,
        ...(yield* runOf({ plan, directory: "/root", stored: [f.runStarted(), f.started("T1.1")], turns: [hang] })),
      }
      const actor = yield* spawn(setup, "T1.1")
      yield* prompted(setup.seen, 1)
      yield* actor.stop
      yield* eventually(
        Effect.sync(() => setup.seen.cancels.length === 1),
        "the cancel",
      )
      yield* Effect.sleep(200)
      expect(setup.seen.cancels).toEqual(["ses_T1.1"])
      expect(yield* storedTypes(setup.id)).toEqual([])
      expect((yield* actor.getSnapshot).status).toBe("stopped")
    }),
  )
})

// Bounds with a task wall clock, and a stall bound long enough that no stall comes first.
const clocked = (minutes: number): TaskLimits.Limits => ({
  ...scripted,
  streamIdle: Duration.hours(24),
  taskWallClock: Option.some(Duration.minutes(minutes)),
})

describe("the task wall clock", () => {
  it.live(
    "SV22 fails the task whose clock expires, cancelling its turn, while an independent task keeps building",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const f = facts()
        const clock = new SimulatedClock()
        const setup = {
          plan,
          ...(yield* runOf({
            plan,
            directory: "/root",
            stored: [f.runStarted(), f.started("T1.1"), f.started("T1.2")],
            turns: [hang, hang],
            limits: clocked(1),
          })),
        }
        yield* spawn(setup, "T1.1", { clock })
        yield* prompted(setup.seen, 1)
        yield* clock.increment(30_000)
        yield* spawn(setup, "T1.2", { clock })
        yield* prompted(setup.seen, 2)
        yield* clock.increment(30_000)
        yield* stored(setup.id, 1)
        expect(yield* storedFacts(setup.id)).toMatchObject([
          { type: "task.failed", task: "T1.1", reason: "wall clock: the task took over 1 min" },
        ])
        expect(setup.seen.cancels).toEqual(["ses_T1.1"])
        yield* clock.increment(29_000)
        yield* settle
        expect(yield* storedTypes(setup.id)).toEqual(["task.failed"])
        yield* clock.increment(1_000)
        yield* stored(setup.id, 2)
        expect((yield* storedFacts(setup.id))[1]).toMatchObject({ type: "task.failed", task: "T1.2" })
      }),
  )

  it.live("gives the full clock after a resume, and the time left to a supervisor spawned again in one job", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const minute = 60_000
      for (const [start, left] of [
        // Started 50 min before a stop; the job resumed at minute 50: downtime does not count, 60 min left.
        [{ runStart: 50 * minute, start: { start: 0, now: 50 * minute } }, 60],
        // Respawned 40 min into the same job: 20 min left.
        [{ runStart: 0, start: { start: 0, now: 40 * minute } }, 20],
      ] as const) {
        const clock = new SimulatedClock()
        const setup = {
          plan,
          ...(yield* runOf({
            plan,
            directory: "/root",
            stored: [f.runStarted(), f.started("T1.1")],
            turns: [hang],
            limits: clocked(60),
          })),
        }
        yield* spawn(setup, "T1.1", { clock, ...start })
        yield* prompted(setup.seen, 1)
        yield* clock.increment((left - 1) * minute)
        yield* settle
        expect(yield* storedTypes(setup.id)).toEqual([])
        yield* clock.increment(minute)
        yield* stored(setup.id, 1)
        expect((yield* storedFacts(setup.id))[0]).toMatchObject({
          type: "task.failed",
          reason: "wall clock: the task took over 60 min",
        })
      }
    }),
  )
})

describe("resume (SV24)", () => {
  it.live("a new supervisor claims the reused builder session before its prompt, and task_ready reaches it", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const harness = yield* TaskHarness.make
      const begun = yield* started(root, "task_superviseresume", "T1.1", 2)
      const atPrompt: Array<Option.Option<TaskHooks.Owner>> = []
      const turns: ReadonlyArray<Turn> = [
        (prompt) =>
          Effect.gen(function* () {
            atPrompt.push(yield* harness.ownerOf(prompt.session))
            expect(yield* harness.hooks.send({ type: "hook.ready", session: prompt.session })).toBe(true)
          }),
      ]
      const setup = {
        plan,
        ...(yield* runOf({
          plan,
          directory: root,
          stored: [f.runStarted(), begun.fact],
          turns,
          claim: harness.claimSession,
        })),
      }
      const runID = "task_superviseresume"
      const owner = TaskHarness.systemId.run(runID)
      yield* harness.spawnRun(runID, TaskSupervisor.machine as AnyActorLogic, yield* inputOf(setup, "T1.1", { owner }))
      yield* stored(setup.id, 1)
      expect(atPrompt).toEqual([Option.some({ owner, watch: true })])
      expect(yield* storedTypes(setup.id)).toEqual(["task.ready"])
    }),
  )
})
