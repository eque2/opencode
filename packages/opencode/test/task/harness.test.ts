import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, FileSystem, Option, Schema } from "effect"
import { assign, setup } from "@jambudipa/xstate-effect"
import path from "path"
import { TaskHarness } from "@/task/core/harness"
import { testEffect } from "../lib/effect"

// The harness root (spine AD-8, AD-11, AD-19): one process-wide actor whose system is the only registry of live
// runs. It holds one lease per directory (the run claim and the checkout and git locks) and the session index that
// routes hooks to their owner, and it forwards `/task trust` to the run supervisor of the directory.

const it = testEffect(NodeServices.layer)

// Each run's spec and path differ from each other and from every other run's, so an answer that swaps them or names
// the wrong run fails.
const claim = (directory: string, runID: string) => ({
  directory,
  runID,
  spec: `specs/${runID}.spec`,
  path: `specs/${runID}.spec/T1-${runID}.task`,
})

// A run supervisor stand-in for the forwarding tests: it keeps the trusts it receives.
const listener = setup({
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
  types: {} as { context: { trusts: ReadonlyArray<string> }; events: { type: "run.trust"; id: string } },
}).createMachine({
  context: { trusts: [] },
  on: { "run.trust": { actions: assign({ trusts: ({ context, event }) => [...context.trusts, event.id] }) } },
})

const decodeTrusts = Schema.decodeUnknownSync(
  Schema.Struct({ context: Schema.Struct({ trusts: Schema.Array(Schema.String) }) }),
)

const trustsOf = (harness: TaskHarness.Interface, runID: string) =>
  Effect.gen(function* () {
    const ref = yield* harness.system.get(`run:${runID}`)
    if (Option.isNone(ref)) return yield* Effect.die(new Error(`no actor run:${runID}`))
    return decodeTrusts(yield* ref.value.getSnapshot).context.trusts
  })

describe("TaskHarness leases", () => {
  it.live("answers none, then claimed, then busy with the live run, and frees the lease on release (SV8)", () =>
    Effect.gen(function* () {
      const harness = yield* TaskHarness.make
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      expect(yield* harness.live(directory)).toEqual(Option.none())
      const first = yield* harness.claim(claim(directory, "task_a"))
      expect(first.kind).toBe("claimed")
      const lease = { runID: "task_a", spec: "specs/task_a.spec", path: "specs/task_a.spec/T1-task_a.task" }
      expect(yield* harness.live(directory)).toEqual(Option.some(lease))
      // The busy answer names the live run's id, spec and path, not the asking run's.
      expect(yield* harness.claim(claim(directory, "task_b"))).toEqual({ kind: "busy", ...lease })
      // A release by a run that does not hold the lease changes nothing.
      yield* harness.release(directory, "task_b")
      expect(yield* harness.live(directory)).toEqual(Option.some(lease))
      yield* harness.release(directory, "task_a")
      expect(yield* harness.live(directory)).toEqual(Option.none())
      expect((yield* harness.claim(claim(directory, "task_b"))).kind).toBe("claimed")
      expect(yield* harness.live(directory)).toEqual(
        Option.some({ runID: "task_b", spec: "specs/task_b.spec", path: "specs/task_b.spec/T1-task_b.task" }),
      )
    }),
  )

  it.live("releases a claim whose job does not start, in the same onExit, so the next claim succeeds", () =>
    Effect.gen(function* () {
      const harness = yield* TaskHarness.make
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      // The lease is held while the start runs; the failed start then releases it.
      const start = Effect.gen(function* () {
        expect(Option.map(yield* harness.live(directory), (live) => live.runID)).toEqual(Option.some("task_a"))
        return yield* Effect.fail("the background job did not start")
      })
      const exit = yield* Effect.exit(harness.withClaim(claim(directory, "task_a"), () => start))
      expect(exit).toEqual(Exit.fail("the background job did not start"))
      expect(yield* harness.live(directory)).toEqual(Option.none())
      expect((yield* harness.claim(claim(directory, "task_b"))).kind).toBe("claimed")
    }),
  )

  it.live("keeps the claim of a job that started, so the next claim is busy, and hands start the lease's locks", () =>
    Effect.gen(function* () {
      const harness = yield* TaskHarness.make
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const started = yield* harness.withClaim(claim(directory, "task_a"), (locks) => Effect.succeed(locks))
      expect(Option.map(yield* harness.live(directory), (live) => live.runID)).toEqual(Option.some("task_a"))
      expect(yield* harness.claim(claim(directory, "task_b"))).toMatchObject({ kind: "busy", runID: "task_a" })
      // A second withClaim for the directory does not start: it answers busy with the live run.
      const ran: Array<string> = []
      const second = yield* harness.withClaim(claim(directory, "task_c"), () => Effect.sync(() => ran.push("task_c")))
      expect(second).toEqual({
        kind: "busy",
        runID: "task_a",
        spec: "specs/task_a.spec",
        path: "specs/task_a.spec/T1-task_a.task",
      })
      expect(ran).toEqual([])
      // `start` received the lease's own locks.
      expect(started).toMatchObject({ checkout: expect.anything(), git: expect.anything() })
    }),
  )

  it.live("refers one directory written three ways to one lease: plain, with a slash, through a symlink", () =>
    Effect.gen(function* () {
      const harness = yield* TaskHarness.make
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const directory = path.join(root, "repo")
      yield* fs.makeDirectory(directory)
      yield* fs.symlink(directory, path.join(root, "link"))
      expect((yield* harness.claim(claim(directory, "task_a"))).kind).toBe("claimed")
      expect((yield* harness.claim(claim(`${directory}/`, "task_b"))).kind).toBe("busy")
      expect((yield* harness.claim(claim(path.join(root, "link"), "task_c"))).kind).toBe("busy")
    }),
  )

  it.live("holds the checkout and git locks of a lease, so two merges in one directory run one after the other", () =>
    Effect.gen(function* () {
      const harness = yield* TaskHarness.make
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const claimed = yield* harness.claim(claim(directory, "task_a"))
      if (claimed.kind !== "claimed") return yield* Effect.die(new Error("not claimed"))
      const order: Array<string> = []
      const merge = (name: string) =>
        claimed.locks.checkout.withPermit(
          Effect.gen(function* () {
            order.push(`${name} start`)
            yield* Effect.sleep(20)
            order.push(`${name} end`)
          }),
        )
      yield* Effect.all([merge("one"), merge("two")], { concurrency: "unbounded" })
      expect(order).toEqual(["one start", "one end", "two start", "two end"])
      // The git lock (worktree creation) is a second one-permit lock of the same lease: two worktree creations
      // serialise, and a creation does not wait for a merge that holds the checkout lock.
      expect(claimed.locks.git).not.toBe(claimed.locks.checkout)
      const trees: Array<string> = []
      const create = (name: string) =>
        claimed.locks.git.withPermit(
          Effect.gen(function* () {
            trees.push(`${name} start`)
            yield* Effect.sleep(20)
            trees.push(`${name} end`)
          }),
        )
      yield* Effect.all([create("one"), create("two")], { concurrency: "unbounded" })
      expect(trees).toEqual(["one start", "one end", "two start", "two end"])
      const both: Array<string> = []
      yield* claimed.locks.checkout.withPermit(
        Effect.gen(function* () {
          both.push("merge holds checkout")
          yield* claimed.locks.git.withPermit(Effect.sync(() => both.push("worktree under git")))
        }),
      )
      expect(both).toEqual(["merge holds checkout", "worktree under git"])
      return yield* Effect.void
    }),
  )
})

describe("TaskHarness session index", () => {
  it.live("adds an owner entry, waits until the index holds it, and drops a run's entries with the run (SV13)", () =>
    Effect.gen(function* () {
      const harness = yield* TaskHarness.make
      yield* harness.claimSession({ session: "ses_b", owner: "task:task_a:T1.1", watch: true })
      yield* harness.claimSession({ session: "ses_v", owner: "scenario:task_a:S1", watch: false })
      yield* harness.claimSession({ session: "ses_x", owner: "task:task_z:T1.1", watch: true })
      expect(yield* harness.ownerOf("ses_b")).toEqual(Option.some({ owner: "task:task_a:T1.1", watch: true }))
      expect(yield* harness.ownerOf("ses_none")).toEqual(Option.none())
      // A second claim of a reused session replaces its owner.
      yield* harness.claimSession({ session: "ses_b", owner: "task:task_a:T1.1", watch: false })
      expect(yield* harness.ownerOf("ses_b")).toEqual(Option.some({ owner: "task:task_a:T1.1", watch: false }))
      yield* harness.removeRun("task_a")
      expect(yield* harness.ownerOf("ses_b")).toEqual(Option.none())
      expect(yield* harness.ownerOf("ses_v")).toEqual(Option.none())
      expect(Option.isSome(yield* harness.ownerOf("ses_x"))).toBe(true)
    }),
  )
})

describe("TaskHarness registry", () => {
  it.live("registers a run under run:<runID>, so running is true exactly while that actor lives", () =>
    Effect.gen(function* () {
      const harness = yield* TaskHarness.make
      expect(yield* harness.running("task_a")).toBe(false)
      yield* harness.spawnRun("task_a", listener)
      expect(yield* harness.running("task_a")).toBe(true)
      expect(TaskHarness.systemId.task("task_a", "T1.1")).toBe("task:task_a:T1.1")
      expect(TaskHarness.systemId.scenario("task_a", "S1")).toBe("scenario:task_a:S1")
      yield* harness.removeRun("task_a")
      expect(yield* harness.running("task_a")).toBe(false)
    }),
  )

  it.live("SV20 forwards /task trust to the run supervisor of that directory only", () =>
    Effect.gen(function* () {
      const harness = yield* TaskHarness.make
      const fs = yield* FileSystem.FileSystem
      const one = yield* fs.makeTempDirectoryScoped()
      const two = yield* fs.makeTempDirectoryScoped()
      // Two directories, two leases: each run holds its own directory.
      expect((yield* harness.claim(claim(one, "task_one"))).kind).toBe("claimed")
      expect((yield* harness.claim(claim(two, "task_two"))).kind).toBe("claimed")
      yield* harness.spawnRun("task_one", listener)
      yield* harness.spawnRun("task_two", listener)
      // A send to a child only queues it: wait until the child holds `count` trusts.
      const reaches = (runID: string, count: number) =>
        Effect.gen(function* () {
          const wait = yield* Effect.forkChild(
            Effect.gen(function* () {
              while ((yield* trustsOf(harness, runID)).length < count) yield* Effect.sleep(5)
            }),
          )
          yield* Fiber.join(wait).pipe(Effect.timeout(2_000))
        })
      yield* harness.trust(one, "T9")
      yield* reaches("task_one", 1)
      yield* harness.trust(two, "T7")
      yield* reaches("task_two", 1)
      // Each trust reached its own directory's supervisor and no other.
      yield* Effect.sleep(20)
      expect(yield* trustsOf(harness, "task_one")).toEqual(["T9"])
      expect(yield* trustsOf(harness, "task_two")).toEqual(["T7"])
      // A trust for a directory with no live run reaches no supervisor and does not fail.
      yield* harness.trust(yield* fs.makeTempDirectoryScoped(), "T5")
      yield* Effect.sleep(20)
      expect(yield* trustsOf(harness, "task_one")).toEqual(["T9"])
      expect(yield* trustsOf(harness, "task_two")).toEqual(["T7"])
    }),
  )
})
