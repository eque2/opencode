import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Clock, Deferred, Duration, Effect, FileSystem, Layer, Option, Schema, Scope } from "effect"
import path from "path"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { TaskOps } from "@/task/core/ops"
import { TaskStatus } from "@/task/core/status"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { git, SESSION, seed, SPEC, statusFile } from "./lib/command"
import { boundary, eventually } from "./lib/supervise"

// Scenario SV4 (spec task-harness-feedback, AD-8, AD-19; tasks T2.10, T2.11): cancelling the job records the cancel
// even while a stale check runs.
//
//   Given a live run whose run supervisor is checking the spec under the checkout lock
//   When the background job is cancelled
//   Then run.cancelled is in the store and in the status file
//   And the run scope closes only after the run supervisor is final or stopped
//   And no session turn or proof process outlives the cancel deadline
//
// The run is a real `/task` of the release-notes spec in a seeded git instance, started by the real command on the
// real background job registry of opencode core, with the scripted bounds (cancel deadline 1 s). It resumes a stored
// slice in which T1.1 is proving: its worktree holds a committed test, tagged with T1.1's obligation, that starts a
// child process in its process group and never ends, so the proof is a live `bun test` process when the cancel comes.
// T1.2 begins, and its builder turn runs until it is stopped. The checkout lock of the run's lease is held from the
// claim on, so the run supervisor's stale check waits on it. The test sees the harness root through a thin wrapper
// that records, at each lease release and run removal, the run supervisor's status; the cancel is the registry's own.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const DEADLINE = Duration.toMillis(TaskLimits.scripted.cancelDeadline)

interface Turn {
  readonly session: string
  readonly started: number
  ended: number | undefined
}

interface Seen {
  readonly replies: Array<string>
  readonly turns: Array<Turn>
  readonly cancels: Array<{ readonly session: string; readonly at: number }>
}

// A reply in the root session ends at once; a child session's turn runs until it is interrupted, and records when.
const opsOf = (seen: Seen): TaskOps.Ops => ({
  prompt: (input) =>
    input.sessionID === SESSION
      ? Effect.sync(() => {
          seen.replies.push(input.parts.map((part) => part.text).join("\n"))
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command never reads the reply message
          return {} as SessionV1.WithParts
        })
      : Effect.gen(function* () {
          const turn: Turn = { session: input.sessionID, started: yield* Clock.currentTimeMillis, ended: undefined }
          seen.turns.push(turn)
          return yield* Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.flatMap(Clock.currentTimeMillis, (now) =>
                Effect.sync(() => {
                  turn.ended = now
                }),
              ),
            ),
          )
        }),
  cancel: (session) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.sync(() => seen.cancels.push({ session, at }))),
  currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
  say: () => Effect.void,
})

// The scripted bounds for the run that `/task` starts (`TaskLimits.load` reads the variable), restored afterwards.
const scriptedLimits = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[TaskLimits.variable]
      process.env[TaskLimits.variable] = "scripted"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[TaskLimits.variable]
        else process.env[TaskLimits.variable] = previous
      }),
  )

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))

it.instance(
  "[SV4] cancelling the job while the stale check waits on the checkout lock records run.cancelled in the store and the status file, closes the run scope only after the supervisor is final, and leaves no turn or proof process past the cancel deadline",
  () =>
    scriptedLimits(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const testScope = yield* Scope.Scope
        const directory = yield* seed(SPEC)
        const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
        const id = TaskEvents.runID(directory, SPEC)
        const db = yield* Database.Service
        const stored = Effect.map(TaskEvents.read(db.db, id), (list) => list.map((fact) => fact.type))

        // T1.1 proving a committed test that writes its process ids and never ends.
        const tree = yield* TaskWorkspace.ensureWorktree(directory, id, "T1.1", branch, TaskLimits.scripted)
        const pidFile = path.join(yield* fs.makeTempDirectoryScoped(), "pids")
        yield* fs.makeDirectory(path.join(tree.worktree, "test"), { recursive: true })
        yield* fs.writeFileString(
          path.join(tree.worktree, "test", "hang.test.ts"),
          [
            'import { test } from "bun:test"',
            'import { writeFileSync } from "fs"',
            'test("[T1.1.c1] never ends", async () => {',
            '  const child = Bun.spawn(["sleep", "600"])',
            `  writeFileSync(${JSON.stringify(pidFile)}, \`\${process.pid} \${child.pid}\`)`,
            "  await new Promise(() => {})",
            "}, 600_000)",
            "",
          ].join("\n"),
        )
        const head = yield* TaskWorkspace.commitAll(tree.worktree, TaskLimits.scripted, "T1.1: attempt 1")
        const events = yield* EventV2Bridge.Service
        for (const fact of [
          { type: "run.started" as const, at: 1, base: branch, path: SPEC },
          {
            type: "task.started" as const,
            at: 2,
            task: "T1.1",
            worktree: tree.worktree,
            branch: tree.branch,
            base: tree.base,
            session: "ses_T1.1",
          },
          { type: "task.ready" as const, at: 3, task: "T1.1", head },
        ])
          yield* TaskEvents.publish(events, id, fact)

        // The harness root, seen through a wrapper: the checkout lock is held from the claim on, and each release and
        // removal of the run notes the run supervisor's status at that moment.
        const real = yield* TaskHarness.make
        const lockHeld = yield* Deferred.make<void>()
        const unlock = yield* Deferred.make<void>()
        const order: Array<string> = []
        const statusNow = Effect.gen(function* () {
          const ref = yield* real.system.get(TaskHarness.systemId.run(id))
          return Option.isNone(ref) ? "absent" : (yield* ref.value.getSnapshot).status
        })
        // The supervisor's ref, kept once it is spawned, so its status can be read after its removal.
        const kept: { status: Effect.Effect<string> } = { status: statusNow }
        const harness: TaskHarness.Interface = {
          ...real,
          claim: (input) =>
            Effect.tap(real.claim(input), (claimed) =>
              claimed.kind === "claimed"
                ? claimed.locks.checkout
                    .withPermit(Deferred.succeed(lockHeld, undefined).pipe(Effect.andThen(Deferred.await(unlock))))
                    .pipe(Effect.forkIn(testScope), Effect.andThen(Deferred.await(lockHeld)))
                : Effect.void,
            ),
          release: (where, runID) =>
            Effect.flatMap(kept.status, (status) => Effect.sync(() => order.push(`release:${status}`))).pipe(
              Effect.andThen(real.release(where, runID)),
            ),
          removeRun: (runID) =>
            Effect.flatMap(kept.status, (status) => Effect.sync(() => order.push(`removeRun:${status}`))).pipe(
              Effect.andThen(real.removeRun(runID)),
            ),
        }

        const registry = yield* CoreBackgroundJob.make
        const seen: Seen = { replies: [], turns: [], cancels: [] }
        const { env } = boundary([])
        yield* TaskCommand.run({ sessionID: SESSION, arguments: SPEC }, opsOf(seen), harness).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Session.Service, env.sessions),
              Layer.succeed(SessionStatus.Service, env.status),
              Layer.succeed(InstanceStore.Service, env.instances),
              Layer.succeed(BackgroundJob.Service, registry),
            ),
          ),
        )
        expect(seen.replies).toEqual(["Implementing spec **Release notes from conventional commits**"])

        // The Given: a live run whose supervisor checks the spec and waits on the held checkout lock, with T1.1's
        // proof process and T1.2's builder turn in flight.
        yield* eventually(real.running(id), "the run supervisor")
        const ref = yield* real.system.get(TaskHarness.systemId.run(id))
        if (Option.isNone(ref)) throw new Error("no run supervisor")
        kept.status = Effect.map(ref.value.getSnapshot, (snapshot) => snapshot.status)
        yield* eventually(
          Effect.map(ref.value.getSnapshot, (snapshot) =>
            JSON.stringify(snapshot.value).includes('"staleCadence":"checking"'),
          ),
          "the stale check waits on the checkout lock",
        )
        yield* eventually(
          Effect.map(
            fs.readFileString(pidFile).pipe(Effect.orElseSucceed(() => "")),
            (text) => text.split(" ").filter((part) => part !== "").length === 2,
          ),
          "the proof process and its child",
        )
        const pids = (yield* fs.readFileString(pidFile)).split(" ").map(Number)
        expect(pids.map(alive)).toEqual([true, true])
        yield* eventually(
          Effect.sync(() => seen.turns.some((turn) => turn.ended === undefined)),
          "a builder turn in flight",
        )
        expect(yield* stored).toEqual(["run.started", "task.started", "task.ready", "run.resumed", "task.started"])
        expect((yield* ref.value.getSnapshot).value).toMatchObject({ running: { staleCadence: "checking" } })

        // When the background job is cancelled.
        const cancelledAt = yield* Clock.currentTimeMillis
        yield* registry.cancel(id)

        // Then run.cancelled is in the store, after this job's run.resumed, and in the status file.
        const types = yield* stored
        expect(types).toContain("run.cancelled")
        expect(types.indexOf("run.cancelled")).toBeGreaterThan(types.indexOf("run.resumed"))
        const status = decodeStatus(yield* fs.readFileString(statusFile(directory)))
        expect(status.run.state).toBe("cancelled")
        expect((yield* registry.get(id))?.status).toBe("cancelled")

        // And the run scope closes only after the run supervisor is final or stopped: the cancel finalizer removes
        // the run, and the scope's first finalizer (the lease release, its last step) sees the supervisor done or
        // stopped. A release before that (the supervisor's own, UI24) may come while it finishes.
        const removal = order.findIndex((item) => item.startsWith("removeRun:"))
        expect(removal).toBeGreaterThan(-1)
        expect(order.at(-1)?.startsWith("release:")).toBe(true)
        for (const item of order.slice(removal + 1)) expect(["release:done", "release:stopped"]).toContain(item)
        expect(["done", "stopped"]).toContain((yield* ref.value.getSnapshot).status)
        expect(yield* real.running(id)).toBe(false)
        expect(yield* real.live(directory)).toEqual(Option.none())

        // And no session turn or proof process outlives the cancel deadline.
        const bound = cancelledAt + DEADLINE
        expect(seen.turns.length).toBeGreaterThan(0)
        for (const turn of seen.turns) {
          expect({ session: turn.session, ended: turn.ended !== undefined }).toEqual({
            session: turn.session,
            ended: true,
          })
          expect({ session: turn.session, inTime: (turn.ended ?? Infinity) <= bound }).toEqual({
            session: turn.session,
            inTime: true,
          })
          expect(seen.cancels.map((cancel) => cancel.session)).toContain(turn.session)
        }
        // The processes are polled until the bound; at the bound both must be gone.
        while (pids.some(alive) && (yield* Clock.currentTimeMillis) <= bound) yield* Effect.sleep(20)
        expect(pids.map(alive)).toEqual([false, false])
        yield* Deferred.succeed(unlock, undefined)
      }),
    ),
  { git: true },
  90_000,
)
