import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect"
import { assign, createActor, createMachine, enqueueActions, waitFor } from "@jambudipa/xstate-effect"
import type { AnyActorLogic } from "@jambudipa/xstate-effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import type { HarnessHooks, HookEvent, Owner } from "./hooks"

// The harness root (spine AD-8, AD-11, AD-19): one process-wide actor. Its actor system is the only registry of the
// live runs (`run:<runID>`, and their `task:` and `scenario:` supervisors); its context holds one lease per directory
// (the run claim, and the checkout and git locks) and the session index that routes a hook to the supervisor that
// owns the session. Callers outside every actor send it an event and then read its snapshot: an external send
// completes after the event's macrostep.

/** The system ids of the run's actors (spine Consistency Conventions). */
export const systemId = {
  run: (runID: string) => `run:${runID}`,
  task: (runID: string, task: string) => `task:${runID}:${task}`,
  scenario: (runID: string, scenario: string) => `scenario:${runID}:${scenario}`,
}

/** The locks of a directory's lease: the root checkout and git (worktree creation) (AD-19). */
export interface Locks {
  readonly checkout: Semaphore.Semaphore
  readonly git: Semaphore.Semaphore
}

/** The live run of a directory, as `run.live` answers it. */
export interface Live {
  readonly runID: string
  /** The spec folder, relative to the directory. */
  readonly spec: string
  /** The `/task` argument. */
  readonly path: string
}

export type Claim = { readonly kind: "claimed"; readonly locks: Locks } | ({ readonly kind: "busy" } & Live)

interface Lease extends Live {
  readonly locks: Locks
}

interface RootContext {
  readonly leases: Readonly<Record<string, Lease>>
  readonly sessions: Readonly<Record<string, Owner>>
}

type RootEvent =
  | ({ readonly type: "run.claim"; readonly directory: string } & Lease)
  | { readonly type: "run.release"; readonly directory: string; readonly runID: string }
  | { readonly type: "run.spawn"; readonly runID: string; readonly logic: AnyActorLogic; readonly input: unknown }
  | { readonly type: "run.remove"; readonly runID: string }
  | ({ readonly type: "session.claim"; readonly session: string } & Owner)
  // A child's error, which the actor system relays to the root: a run supervisor that stopped with an error.
  | { readonly type: `xstate.error.actor.${string}`; readonly error: unknown; readonly actorId: string }

// The repetition limit in an owner's snapshot context; an owner without one is not watched.
const decodeLimit = Schema.decodeUnknownOption(Schema.Struct({ context: Schema.Struct({ limit: Schema.Number }) }))

// Whether a session owner belongs to the run: the run supervisor or one of its unit supervisors.
const ofRun = (owner: string, runID: string) =>
  owner === systemId.run(runID) || owner.startsWith(`task:${runID}:`) || owner.startsWith(`scenario:${runID}:`)

// A plain `createMachine`, not `setup`: a setup without declared actors takes no id for an inline logic, and each run
// supervisor is spawned under its system id.
const root = createMachine({
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
  types: {} as { context: RootContext; events: RootEvent },
  id: "harness",
  context: { leases: {}, sessions: {} },
  on: {
    // One live run per directory (owner ruling 3): a claim takes a free lease and leaves a held one alone.
    "run.claim": {
      guard: ({ context, event }) => !(event.directory in context.leases),
      actions: assign({
        leases: ({ context, event }) => ({
          ...context.leases,
          [event.directory]: { runID: event.runID, spec: event.spec, path: event.path, locks: event.locks },
        }),
      }),
    },
    // Only the run that holds the lease releases it.
    "run.release": {
      guard: ({ context, event }) => context.leases[event.directory]?.runID === event.runID,
      actions: assign({
        leases: ({ context, event }) =>
          Object.fromEntries(Object.entries(context.leases).filter(([directory]) => directory !== event.directory)),
      }),
    },
    "run.spawn": {
      actions: enqueueActions(({ event, enqueue }) => {
        if (event.type === "run.spawn") {
          const id = systemId.run(event.runID)
          enqueue.spawnChild(event.logic, { id, systemId: id, input: event.input })
        }
      }),
    },
    // Removing a run stops its supervisor and drops every session entry of the run (AD-11).
    "run.remove": {
      actions: [
        enqueueActions(({ event, enqueue }) => {
          if (event.type === "run.remove") enqueue.stopChild(systemId.run(event.runID))
        }),
        assign({
          sessions: ({ context, event }) =>
            Object.fromEntries(
              Object.entries(context.sessions).filter(
                ([, entry]) => event.type !== "run.remove" || !ofRun(entry.owner, event.runID),
              ),
            ),
        }),
      ],
    },
    // The owner claims a session before each turn it runs there, new or reused; a later claim replaces the entry.
    "session.claim": {
      actions: assign({
        sessions: ({ context, event }) => ({
          ...context.sessions,
          [event.session]: { owner: event.owner, watch: event.watch },
        }),
      }),
    },
    // A run supervisor that errors has left the system. A child error that no transition takes would put the root in
    // status error, and the root would ignore every later event: the job's release, claims, spawns (SV26). The root
    // takes it, and removes the run as `run.remove` does. The run supervisors are the root's only children.
    "xstate.error.actor.*": {
      actions: enqueueActions(({ event, enqueue }) => {
        const runID = /^run:(.+)$/.exec(event.actorId)?.[1]
        if (runID !== undefined) enqueue.raise({ type: "run.remove", runID })
      }),
    },
  },
})

/** Builds the harness root in the caller's scope. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const actor = yield* createActor(root)
  yield* actor.start

  // One key per directory: `/repo`, `/repo/` and a symlink to `/repo` name one lease.
  const key = (directory: string) => fs.realPath(directory).pipe(Effect.orElseSucceed(() => path.resolve(directory)))

  const leaseOf = (directory: string) =>
    Effect.gen(function* () {
      const at = yield* key(directory)
      const snapshot = yield* actor.getSnapshot
      return Option.fromNullishOr(snapshot.context.leases[at])
    })

  const live = (directory: string) =>
    Effect.map(
      leaseOf(directory),
      Option.map((lease): Live => ({ runID: lease.runID, spec: lease.spec, path: lease.path })),
    )

  const claim = (input: { readonly directory: string } & Live) =>
    Effect.gen(function* () {
      const directory = yield* key(input.directory)
      const locks: Locks = { checkout: yield* Semaphore.make(1), git: yield* Semaphore.make(1) }
      yield* actor.send({ type: "run.claim", directory, runID: input.runID, spec: input.spec, path: input.path, locks })
      const held = (yield* actor.getSnapshot).context.leases[directory]
      if (held !== undefined && held.runID === input.runID)
        return { kind: "claimed", locks: held.locks } satisfies Claim
      return {
        kind: "busy",
        runID: held?.runID ?? input.runID,
        spec: held?.spec ?? input.spec,
        path: held?.path ?? input.path,
      } satisfies Claim
    })

  const release = (directory: string, runID: string) =>
    Effect.gen(function* () {
      yield* actor.send({ type: "run.release", directory: yield* key(directory), runID })
    })

  const ownerOf = (session: string) =>
    Effect.map(actor.getSnapshot, (snapshot) => Option.fromNullishOr(snapshot.context.sessions[session]))

  // The live supervisor that owns a session: none when nobody claimed it, or when its owner has stopped.
  const ownerActor = (session: string) =>
    Effect.flatMap(
      ownerOf(session),
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (entry) => actor.system.get(entry.owner),
      }),
    )

  const hooks: HarnessHooks = {
    ownerOf,
    send: (event: HookEvent) =>
      Effect.gen(function* () {
        const owner = yield* ownerActor(event.session)
        if (Option.isNone(owner)) return false
        yield* owner.value.send(event)
        return true
      }),
    limitOf: (session: string) =>
      Effect.gen(function* () {
        const owner = yield* ownerActor(session)
        if (Option.isNone(owner)) return Option.none<number>()
        return Option.map(decodeLimit(yield* owner.value.getSnapshot), (snapshot) => snapshot.context.limit)
      }),
  }

  return {
    /** The actor system: the registry of the live runs and their supervisors. */
    system: actor.system,
    /** `run.live`: the live run of the directory, if any; it changes nothing. */
    live,
    /** `run.claim`: takes the directory's lease for the run, or answers the live run that holds it. */
    claim,
    /** `run.release`: frees the lease, when the run holds it. */
    release,
    /**
     * Claims the lease and runs `start` with its locks; when `start` does not succeed (an error, a defect, an
     * interruption), the claim is released in the same `onExit`, so the next `/task` is not busy (AD-19).
     */
    withClaim: <A, E, R>(
      input: { readonly directory: string } & Live,
      start: (locks: Locks) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const claimed = yield* claim(input)
        if (claimed.kind === "busy") return claimed
        return yield* start(claimed.locks).pipe(
          Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : release(input.directory, input.runID))),
        )
      }),
    /** `session.claim`: records the session's owner and waits until the index holds the entry (AD-11). */
    claimSession: (input: { readonly session: string } & Owner) =>
      Effect.gen(function* () {
        yield* actor.send({ type: "session.claim", ...input })
        yield* waitFor(actor, (snapshot) => snapshot.context.sessions[input.session]?.owner === input.owner)
      }),
    /** The owner of a session, if a supervisor claimed it. */
    ownerOf,
    /** The routing that `SessionPrompt` hands to the harness tools and the repetition stop (AD-11). */
    hooks,
    /** Spawns a run's supervisor as `run:<runID>` in the harness system. */
    spawnRun: (runID: string, logic: AnyActorLogic, input?: unknown) =>
      actor.send({ type: "run.spawn", runID, logic, input }),
    /** Stops `run:<runID>` and drops every session entry of the run. */
    removeRun: (runID: string) => actor.send({ type: "run.remove", runID }),
    /** True while `run:<runID>` is in the system. */
    running: (runID: string) => Effect.map(actor.system.get(systemId.run(runID)), Option.isSome),
    /**
     * Forwards a `/task trust <id>` to the run supervisor of the directory, if a run is live there (SV20). The
     * supervisor decides whether the id is an untrusted `outside` region (T2.10).
     */
    trust: (directory: string, id: string) =>
      Effect.gen(function* () {
        const lease = yield* leaseOf(directory)
        if (Option.isNone(lease)) return
        const supervisor = yield* actor.system.get(systemId.run(lease.value.runID))
        if (Option.isSome(supervisor)) yield* supervisor.value.send({ type: "run.trust", id })
      }),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskHarness") {}

const layer = Layer.effect(Service, make).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

/**
 * A global node (AD-8): the services the run's actors use are its dependencies, because the port's `createActor`
 * requires them; it never depends on `SessionPrompt`, which depends on it. The workers reach the instance store
 * through the run's env, not the context, so `InstanceStore` is no dependency: it would bind the instance bootstrap
 * into every graph that holds `SessionPrompt`.
 */
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Session.node, SessionStatus.node, EventV2Bridge.node, BackgroundJob.node, Database.node],
})

export * as TaskHarness from "./harness"
