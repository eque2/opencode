import { Effect, FileSystem, Semaphore } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { InstanceStore } from "@/project/instance-store"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionStatus } from "@/session/status"
import { TaskEvents } from "@/task/core/events"
import type { Fact, Plan } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import type { TaskSessions } from "@/task/core/sessions"
import type { TaskWorkers } from "@/task/core/workers"
import { TaskWorkspace } from "@/task/core/workspace"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import type { RunMachine } from "@/task/engine-xstate/machine"
import { TaskLimits } from "@/task/limits"

// Shared parts of the supervisor tests: a scratch repository, a run with a real Recorder over the real event store,
// a scripted session boundary, and the run supervisor's part (`unit.moved` for a unit's newest entry).

export const scripted = TaskLimits.scripted
export const BASE = "dev"
const PHASES = ["ready", "building", "proving", "verifying"]

const git = (cwd: string, ...args: ReadonlyArray<string>) => TaskWorkspace.git(cwd, scripted, ...args)

export const repository = Effect.fnUntraced(function* () {
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
export type Turn = (prompt: {
  readonly session: string
  readonly agent: string
  readonly text: string
}) => Effect.Effect<void>

export interface Seen {
  readonly order: Array<string>
  readonly prompts: Array<{ readonly session: string; readonly agent: string; readonly text: string }>
  readonly cancels: Array<string>
  readonly claims: Array<{ readonly session: string; readonly owner: string; readonly watch: boolean }>
}

// A session boundary whose prompts follow `turns` in order (a prompt past the end just ends).
export const boundary = (turns: ReadonlyArray<Turn>, messages: ReadonlyArray<unknown> = []) => {
  const seen: Seen = { order: [], prompts: [], cancels: [], claims: [] }
  let created = 0
  const sessions = {
    create: () => Effect.sync(() => ({ id: SessionID.make(`ses_judge_${++created}`) })),
    messages: () => Effect.succeed(messages),
    // The closing summary sums the run's sessions; none has spent anything here.
    children: () => Effect.succeed([]),
  }
  const instances = {
    provide: <A, E, R>(_load: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) => effect,
  }
  const env: TaskSessions.Env = {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the workers call only create, messages and children
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

export interface Setup {
  readonly plan: Plan
  readonly directory: string
  readonly stored: ReadonlyArray<Fact>
  readonly turns?: ReadonlyArray<Turn>
  readonly messages?: ReadonlyArray<unknown>
  readonly limits?: TaskLimits.Limits
  readonly claim?: TaskWorkers.Run["claim"]
  /** Write status.json for real (the default writes nothing). */
  readonly writes?: boolean
  /** The run actor's machine, when it is not the plan's. */
  readonly machine?: RunMachine
}

// A run: its Recorder over the stored facts, its locks, and the scripted session boundary.
export const runOf = Effect.fnUntraced(function* (setup: Setup) {
  const id = `task_supervise${(runs++).toString(16).padStart(4, "0")}`
  const events = yield* EventV2Bridge.Service
  const recorder = yield* TaskRecorder.make({
    plan: setup.plan,
    runID: id,
    directory: setup.directory,
    stored: setup.stored,
    events,
    ...(setup.writes ? {} : { write: () => Effect.void }),
    ...(setup.machine === undefined ? {} : { machine: setup.machine }),
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

export type Run = Effect.Success<ReturnType<typeof runOf>>

// A unit as the run supervisor sees it: its newest entry, state, tags and session.
export const unitOf = (snapshot: RunSnapshot, id: string) => {
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

// The newest entry the test has sent (or spawned with) for each run's unit.
export const sent = new Map<string, number>()

/** The run supervisor's part for a unit supervisor: `unit.moved` for the unit's newest entry, once the run actor holds an entry newer than the last one sent. */
export const move = Effect.fnUntraced(function* (
  setup: Run,
  actor: {
    send: (event: {
      readonly type: "unit.moved"
      readonly unit: string
      readonly entry: number
      readonly state: string
      readonly tags: ReadonlyArray<string>
      readonly latest: boolean
      readonly at: number
      readonly session?: string
    }) => Effect.Effect<void>
  },
  unit: string,
) {
  const key = `${setup.id}:${unit}`
  const after = sent.get(key) ?? -1
  for (let tries = 0; tries < 2000; tries++) {
    if (unitOf(yield* setup.recorder.actor.getSnapshot, unit).entry > after) break
    yield* Effect.sleep(10)
  }
  const now = unitOf(yield* setup.recorder.actor.getSnapshot, unit)
  if (now.entry <= after) return yield* Effect.die(new Error(`no new entry of ${unit} after ${after}`))
  sent.set(key, now.entry)
  const event = { type: "unit.moved" as const, unit, latest: true, ...now }
  yield* actor.send(event)
  return event
})

// The facts the run recorded: its stored slice is given to the Recorder, never published, so only new facts show.
export const storedTypes = Effect.fnUntraced(function* (id: string) {
  const db = yield* Database.Service
  return (yield* TaskEvents.read(db.db, id)).map((fact) => fact.type)
})

export const storedFacts = Effect.fnUntraced(function* (id: string) {
  const db = yield* Database.Service
  return yield* TaskEvents.read(db.db, id)
})

// Waits until `check` holds (the workers and the relay run on their own fibers).
export const eventually = Effect.fnUntraced(function* (
  check: Effect.Effect<boolean, unknown, Database.Service>,
  what: string,
) {
  for (let tries = 0; tries < 2000; tries++) {
    if (yield* check) return yield* Effect.void
    yield* Effect.sleep(10)
  }
  return yield* Effect.die(new Error(`never: ${what}`))
})

export const stored = (id: string, count: number) =>
  eventually(
    Effect.map(storedTypes(id), (types) => types.length >= count),
    `${count} stored facts`,
  )

export const prompted = (seen: Seen, count: number) =>
  eventually(
    Effect.sync(() => seen.prompts.length >= count),
    `${count} prompts`,
  )

// A worktree of `task` in `root`, and the task.started fact that names it.
export const started = Effect.fnUntraced(function* (root: string, runID: string, task: string, at: number) {
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

// A prompt that never ends: the turn runs until the supervisor stops it.
export const hang: Turn = () => Effect.never

// Lets the relay and the supervisor take what was just published.
export const settle = Effect.sleep(60)

export const deltaOf = (events: EventV2.Interface, session: string) =>
  events.publish(MessageV2.Event.PartDelta, {
    sessionID: SessionID.make(session),
    messageID: MessageID.ascending(),
    partID: PartID.ascending(),
    field: "text",
    delta: "x",
  })
