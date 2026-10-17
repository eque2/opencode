import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Logger, Option } from "effect"
import { createMachine, fromEffect } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { RunSupervisor } from "@/task/core/supervise/run"
import type { TaskSupervisor } from "@/task/core/supervise/task"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { backgroundOf, git, type Jobs, jobsOf, seed, services, SESSION, SPEC } from "./lib/command"
import { loadPlan } from "./lib/machine"
import { eventually, repository, runOf, storedFacts } from "./lib/supervise"

// Scenario SV26 (spec task-harness-feedback, AD-8, AD-9, RM28, SD-16; tasks T2.4, T2.8, T2.10, T2.11): an actor error
// ends its unit or its run, never strands it.
//
//   Given a live run whose task supervisor, run supervisor or run actor reaches the error status
//   When the error happens
//   Then a failed unit supervisor counts as three worker failures, so its unit records task.failed with
//     "harness error: <defect>"
//   And a failed run supervisor or run actor ends the job's wait, the Recorder stores nothing more, the defect is
//     logged and the directory lease is released
//   And a later /task on that spec treats a slice whose fold dies as ended, logs it, and says in its start message
//     that it starts a new slice
//
// The real code has no reachable actor error (the machine checks and the graph proof keep it out), so each Given puts
// one defect into one actor and runs everything else for real:
// - a task supervisor or the run supervisor that dies at once: the real `/task` and its real background job (the
//   Recorder over the real event store, the cancel finalizer, the lease, the job's wait); the harness root is real,
//   and it is wrapped only to hand the run supervisor that one broken actor logic;
// - a run actor that errors: the real Recorder (its `machine` option takes a copy of the plan's machine config whose
//   T1.1 building row reads an unknown state, so the actor errors when T1.1 starts), the real run supervisor with its
//   real task supervisors, started and awaited by `RunSupervisor.supervise` (the job's wait), on a lease of the real
//   harness root. The job itself cannot take another machine;
// - a slice whose fold dies: a plan whose machine cannot be built (two tasks with one id) through the command's own
//   slice choice and start message (`TaskCommand.sliceOf`, `TaskCommand.headerParts`). No valid spec loads to such a
//   plan, so `/task` itself cannot be driven into it.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const HEADER = "Implementing spec **Release notes from conventional commits**"

// The log messages of an effect, and of every actor made inside it (an actor logs with the context it was made in).
const capture = (messages: Array<unknown>) =>
  Logger.layer([
    Logger.make<unknown, void>((options) => {
      messages.push(options.message)
    }),
  ])
const logged = (messages: ReadonlyArray<unknown>, text: string) =>
  messages.some((message) => JSON.stringify(message).includes(text))

// The `/task` command's ops: the replies are recorded; a model turn never ends.
const opsOf = (replies: Array<string>): TaskOps.Ops => ({
  prompt: (input) =>
    input.noReply === true
      ? Effect.sync(() => {
          replies.push(input.parts.map((part) => part.text).join("\n"))
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command never reads the reply message, and a real WithParts needs a stored session
          return {} as SessionV1.WithParts
        })
      : Effect.never,
  cancel: () => Effect.void,
  currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
  say: () => Effect.void,
})

// `/task <args>` in the instance, with the job registry `background` (lib/command's by default).
const runTask = (
  harness: TaskHarness.Interface,
  jobs: Jobs,
  background: BackgroundJob.Interface = backgroundOf(jobs),
) =>
  Effect.gen(function* () {
    const replies: Array<string> = []
    yield* TaskCommand.run({ sessionID: SESSION, arguments: SPEC }, opsOf(replies), harness).pipe(
      Effect.provideService(BackgroundJob.Service, background),
      Effect.provide(services(jobs)),
    )
    return replies
  })

// The job's fiber has ended: its wait is over.
const jobEnded = (jobs: Jobs) =>
  Effect.gen(function* () {
    expect(jobs.fibers).toHaveLength(1)
    const fiber = jobs.fibers[0]
    if (fiber === undefined) return yield* Effect.die(new Error("no job ran"))
    return yield* Fiber.await(fiber).pipe(Effect.timeout("60 seconds"))
  })

it.instance(
  "[SV26] a task supervisor that errors counts as three worker failures: its unit records task.failed with harness error: <defect> once, and the run still ends",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const plan = yield* loadPlan("release-notes.spec")
      const db = yield* Database.Service
      const runID = TaskEvents.runID(directory, SPEC)
      const real = yield* TaskHarness.make
      // Given a live run whose task supervisors reach the error status at once: the run supervisor is the real one,
      // with each unit's task supervisor a logic that dies with a defect. Each spawn is noted with its task.
      const spawned: Array<string> = []
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (b) a unit supervisor that errors at once takes the task supervisor's place
      const broken = fromEffect(({ input }: { input: { readonly task: { readonly id: string } } }) =>
        Effect.suspend(() => {
          spawned.push(input.task.id)
          return Effect.die(new Error("the supervisor broke"))
        }),
      ) as unknown as typeof TaskSupervisor.machine
      const given: Array<unknown> = []
      const harness: TaskHarness.Interface = {
        ...real,
        spawnRun: (id, logic, input) =>
          Effect.suspend(() => {
            given.push(logic)
            return real.spawnRun(id, RunSupervisor.machine.provide({ actors: { task: broken } }), input)
          }),
      }
      const jobs = jobsOf()
      jobs.mode = "run"
      expect(yield* runTask(harness, jobs)).toEqual([HEADER])

      // When the error happens, then the unit records task.failed with the defect.
      const stored = TaskEvents.read(db.db, runID)
      yield* eventually(
        Effect.map(stored, (list) => list.some((fact) => fact.type === "task.failed" && fact.task === "T1.1")),
        "T1.1 records task.failed",
      )
      // The job asked for the real run supervisor (only its task actor is the broken one), once.
      expect(given).toHaveLength(1)
      expect(given[0] === RunSupervisor.machine).toBe(true)
      // And the run is not stranded: the run machine ends, so the job's wait ends.
      const exit = yield* jobEnded(jobs)
      expect(Exit.isSuccess(exit)).toBe(true)
      const facts = yield* stored
      const failed = facts.flatMap((fact) => (fact.type === "task.failed" ? [fact] : []))
      for (const fact of failed) expect(fact.reason).toBe("harness error: the supervisor broke")
      // The leaves ready at the start are T1.1 and T1.2 (T1.3 to T1.5 come after them). One supervisor error counts
      // as all three worker failures: each of the two units gets one supervisor and records task.failed once, and is
      // never supervised again. No worker ran: no task.started.
      expect({ spawned: spawned.toSorted(), failed: failed.map((fact) => fact.task).toSorted() }).toEqual({
        spawned: ["T1.1", "T1.2"],
        failed: ["T1.1", "T1.2"],
      })
      expect(facts.some((fact) => fact.type === "task.started")).toBe(false)
      expect(facts.some((fact) => fact.type === "run.cancelled")).toBe(false)
      // The fold of the slice: T1.1 and T1.2 failed, the run ended failed.
      const snapshot = TaskEvents.fold(TaskEngineXState.XStateEngine, plan, facts)
      expect(TaskEngineXState.unitState(snapshot, "T1.1")).toBe("failed")
      expect(TaskEngineXState.unitState(snapshot, "T1.2")).toBe("failed")
      expect(TaskEngineXState.ended(snapshot)).toBe(true)
      expect(TaskEngineXState.view(snapshot).run.state).toBe("failed")
      // The lease is free and the run supervisor is gone.
      expect(yield* real.live(directory)).toEqual(Option.none())
      expect(yield* real.running(runID)).toBe(false)
    }),
  { git: true },
  120_000,
)

it.instance(
  "[SV26] a run supervisor that errors ends the job's wait: the Recorder stores nothing more, the defect is logged and the lease is released",
  () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = []
      const directory = yield* seed(SPEC)
      const db = yield* Database.Service
      const runID = TaskEvents.runID(directory, SPEC)
      const real = yield* TaskHarness.make.pipe(Effect.provide(capture(messages)))
      // Given a live run whose run supervisor reaches the error status: the logic the harness spawns for the run dies.
      const harness: TaskHarness.Interface = {
        ...real,
        spawnRun: (id, _logic, input) =>
          real.spawnRun(
            id,
            fromEffect(() => Effect.die(new Error("the run supervisor broke"))),
            input,
          ),
      }
      // The job registry of lib/command, with the job run under the test's logger.
      const jobs = jobsOf()
      jobs.mode = "run"
      const registry = backgroundOf(jobs)
      const background: BackgroundJob.Interface = {
        ...registry,
        start: (input) => registry.start({ ...input, run: input.run.pipe(Effect.provide(capture(messages))) }),
      }
      expect(yield* runTask(harness, jobs, background)).toEqual([HEADER])
      expect(jobs.starts.map((start) => start.id)).toEqual([runID])

      // When the error happens, then the job's wait ends.
      const exit = yield* jobEnded(jobs)
      expect(Exit.isSuccess(exit)).toBe(true)
      // The defect is logged.
      expect(logged(messages, "task harness: the run supervisor stopped with an error")).toBe(true)
      expect(logged(messages, "the run supervisor broke")).toBe(true)
      // The directory lease is released and the run is gone from the harness.
      expect(yield* real.live(directory)).toEqual(Option.none())
      expect(yield* real.running(runID)).toBe(false)
      // The Recorder stores nothing more: the broken supervisor recorded nothing, and nothing comes later.
      expect(yield* TaskEvents.read(db.db, runID)).toEqual([])
      yield* Effect.sleep(500)
      expect(yield* TaskEvents.read(db.db, runID)).toEqual([])
      // The released lease lets the next /task start: it gets the run header, not the busy reply.
      expect(yield* runTask(real, jobsOf())).toEqual([HEADER])
    }),
  { git: true },
  120_000,
)

it.live(
  "[SV26] a run actor that errors ends the run: the job's wait ends, the Recorder stores nothing more, the defect is logged and the lease is released",
  () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = []
      yield* Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const directory = yield* repository()
        // A copy of the plan's machine config whose T1.1 building row reads an unknown state: the run actor errors
        // in the macrostep of T1.1's task.started.
        const config = TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
          node.id === "T1_1/building"
            ? {
                ...node,
                always: [
                  { guard: { type: "xstate.stateIn", params: { stateValue: "#nowhere/at_all" } }, target: "proving" },
                ],
              }
            : node,
        )
        const machine = createMachine(config, { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS })
        // The run: the real harness root (made under the test's logger, so its actors log there), its lease, the real
        // Recorder over the real event store writing status.json, and the real run supervisor with its real task
        // supervisors.
        const harness = yield* TaskHarness.make
        const setup = yield* runOf({ plan, directory, stored: [], machine, writes: true })
        const claimed = yield* harness.claim({ directory, runID: setup.id, spec: SPEC, path: SPEC })
        expect(claimed.kind).toBe("claimed")
        expect(yield* harness.live(directory)).toEqual(Option.some({ runID: setup.id, spec: SPEC, path: SPEC }))

        // Given a live run; when T1.1's task supervisor records task.started, the run actor errors. Then the job's
        // wait (`RunSupervisor.supervise`) ends.
        yield* RunSupervisor.supervise(harness, {
          run: setup.run,
          events: setup.events,
          resumed: false,
          path: SPEC,
          trusts: Effect.succeed([]),
          externals: [],
          release: harness.release(directory, setup.id),
          writer: setup.recorder.writer,
        }).pipe(Effect.timeout("60 seconds"))
        expect((yield* setup.recorder.actor.getSnapshot).status).toBe("error")
        const facts = yield* storedFacts(setup.id)
        expect(facts[0]).toMatchObject({ type: "run.started", path: SPEC })
        expect(facts.at(-1)).toMatchObject({ type: "task.started", task: "T1.1" })
        // The defect is logged.
        expect(logged(messages, "task harness: the run actor stopped with an error")).toBe(true)
        // The directory lease is released, and the run supervisor has closed.
        expect(yield* harness.live(directory)).toEqual(Option.none())
        const supervisor = yield* harness.system.get(TaskHarness.systemId.run(setup.id))
        if (Option.isSome(supervisor)) expect((yield* supervisor.value.getSnapshot).status).toBe("done")
        // The Recorder stores nothing more: a record fails, and the store keeps the facts it had.
        const refused = yield* Effect.flip(setup.recorder.record({ type: "task.ready", task: "T1.1", head: "h" }))
        expect(refused).toMatchObject({
          _tag: "TaskRecorderError",
          message: `the run actor of ${setup.id} stopped with an error`,
        })
        yield* Effect.sleep(500)
        expect(yield* storedFacts(setup.id)).toEqual(facts)
      }).pipe(Effect.provide(capture(messages)))
    }),
  120_000,
)

it.instance(
  "[SV26] a later /task treats a slice whose fold dies as ended, logs it, and its start message says a new slice starts",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
      const plan = yield* loadPlan("release-notes.spec")
      const db = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const runID = TaskEvents.runID(directory, SPEC)
      // A stored slice that has not ended: with a plan whose machine is sound, a /task of that path resumes it.
      const slice: ReadonlyArray<Fact> = [
        { type: "run.started", at: 1, base: branch, path: SPEC },
        {
          type: "task.started",
          at: 2,
          task: "T1.1",
          worktree: "/wt/T1.1",
          branch: "task/T1.1",
          base: branch,
          session: "ses_T1.1",
        },
      ]
      for (const fact of slice) yield* TaskEvents.publish(events, runID, fact)
      const stored = yield* TaskEvents.read(db.db, runID)
      expect(yield* TaskCommand.sliceOf(plan, stored, SPEC)).toEqual({ kind: "resume", facts: stored })
      expect(TaskCommand.headerParts(plan, { kind: "resume", facts: stored }).map((part) => part.text)).toEqual([
        HEADER,
      ])

      // A plan whose machine has a defect (two tasks with one id): the fold of the same slice dies.
      const broken: Plan = { ...plan, tasks: [...plan.tasks, ...plan.tasks.slice(0, 1)] }
      expect(
        Exit.isFailure(
          Effect.runSyncExit(Effect.sync(() => TaskEvents.fold(TaskEngineXState.XStateEngine, broken, stored))),
        ),
      ).toBe(true)
      const messages: Array<unknown> = []
      const chosen = yield* TaskCommand.sliceOf(broken, stored, SPEC).pipe(Effect.provide(capture(messages)))
      // Then the slice counts as ended: a new slice, with the defect named.
      if (chosen.kind !== "new" || Option.isNone(chosen.died)) throw new Error(`the fold did not die: ${chosen.kind}`)
      expect(chosen.died.value).toContain("duplicate")
      expect(TaskCommand.unfinishedBase(chosen)).toEqual(Option.none())
      // It is logged.
      expect(logged(messages, "task harness: the stored run could not be folded")).toBe(true)
      expect(logged(messages, chosen.died.value.slice(0, 40))).toBe(true)
      // And the start message says that a new slice starts instead of the stored one: the header, then one line that
      // names the defect.
      const parts = TaskCommand.headerParts(plan, chosen).map((part) => part.text)
      expect(parts).toHaveLength(2)
      expect(parts[0]).toBe(HEADER)
      const note = parts[1] ?? ""
      expect(note.startsWith("The stored run could not be resumed (")).toBe(true)
      expect(note.endsWith("), so a new run started.")).toBe(true)
      expect(note).not.toContain("\n")
      expect(note).toContain((chosen.died.value.split("\n")[0] ?? "").trim())
    }),
  { git: true },
  120_000,
)
