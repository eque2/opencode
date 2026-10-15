import { Clock, Effect, Option, Queue, Schema, Semaphore, Stream } from "effect"
import { createActor, initialTransition } from "@jambudipa/xstate-effect"
import type { EventV2 } from "@opencode-ai/core/event"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { type RunMachine, TaskMachine } from "@/task/engine-xstate/machine"
import { TaskEvents } from "./events"
import type { Fact, Plan } from "./model"
import { TaskStatus } from "./status"

// The Recorder of a run (spine AD-9): the only way a fact enters it. The background job builds it in the run scope,
// outside every actor. It creates the run actor from the fold of the slice's stored facts, and it owns the status
// writer, the only code that writes `status.json` during the run.
//
// `record` stamps `at`, publishes the fact to the run's aggregate and sends it to the run actor, in that order, under
// one permit and uninterruptibly: the store order and the fold order are the same, and a fact is stored and folded or
// neither. A supervisor never calls it from an action or a guard; it invokes a `record` worker.

/** A fact as its caller records it: the Recorder stamps `at`. */
export type Unstamped = Fact extends infer Each ? (Each extends Fact ? Omit<Each, "at"> : never) : never

/** The run actor stopped with an error, so nothing more can be recorded (SV26). */
export class RecorderError extends Schema.TaggedError<RecorderError>()("TaskRecorderError", {
  message: Schema.String,
}) {}

const stamp = (fact: Unstamped, at: number): Fact => ({ ...fact, at })

type Item = { readonly kind: "snapshot"; readonly snapshot: RunSnapshot } | { readonly kind: "touch" }

/**
 * Builds a run's Recorder in the caller's scope: the run actor (a root actor restored from the fold of `stored`, the
 * slice's facts) and the status writer fiber. `machine` defaults to the plan's machine.
 */
export const make = Effect.fn("TaskRecorder.make")(function* (input: {
  readonly plan: Plan
  readonly runID: string
  /** The instance directory, where `status.json` lives. */
  readonly directory: string
  /** The stored facts of the slice that this run resumes; none for a new slice. */
  readonly stored: ReadonlyArray<Fact>
  readonly events: EventV2.Interface
  readonly machine?: RunMachine
}) {
  const machine = input.machine ?? TaskMachine.machine(input.plan)
  const [first] = yield* initialTransition(machine)
  const fold = input.stored.reduce((snapshot, fact) => TaskEngineXState.applyTo(machine, snapshot, fact), first)
  const actor = yield* createActor(machine, { snapshot: yield* machine.getPersistedSnapshot(fold) })
  yield* actor.start
  // A resume in a new process may read a clock behind its stored facts: `at` never goes back (AD-5).
  const floor = input.stored.reduce((latest, fact) => Math.max(latest, fact.at), 0)
  const permit = yield* Semaphore.make(1)

  const record = (fact: Unstamped) =>
    permit.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const snapshot = yield* actor.getSnapshot
          if (snapshot.status === "error") {
            yield* Effect.logError("task harness: the run actor stopped with an error", {
              runID: input.runID,
              error: String(snapshot.error),
            })
            return yield* new RecorderError({ message: `the run actor of ${input.runID} stopped with an error` })
          }
          // A run that is done records nothing more (AD-6); after the run scope closed the actor is stopped.
          if (snapshot.status !== "active") return yield* Effect.void
          const stamped = stamp(fact, Math.max(yield* Clock.currentTimeMillis, floor))
          yield* TaskEvents.publish(input.events, input.runID, stamped)
          return yield* actor.send(stamped)
        }),
      ),
    )

  // The status writer: one write for each committed macrostep, the `done` snapshot last, and a rewrite of the last
  // snapshot on each touch. A burst of touches leaves at most one write pending. The writer stops with the run
  // actor's changes, and stops writing once the actor has an error.
  const touches = yield* Queue.sliding<true>(1)
  const items = Stream.merge(
    actor.changes.pipe(Stream.map((snapshot): Item => ({ kind: "snapshot", snapshot }))),
    Stream.fromQueue(touches).pipe(Stream.map((): Item => ({ kind: "touch" }))),
    { haltStrategy: "left" },
  )
  const writer = yield* items.pipe(
    Stream.takeWhile((item) => item.kind === "touch" || item.snapshot.status !== "error"),
    Stream.scan(
      () => Option.none<RunSnapshot>(),
      (last, item) => (item.kind === "snapshot" ? Option.some(item.snapshot) : last),
    ),
    Stream.runForEach((last) =>
      Option.match(last, {
        onNone: () => Effect.void,
        onSome: (snapshot) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            TaskStatus.write(input.directory, TaskStatus.project(input.plan, snapshot), now),
          ),
      }),
    ),
    Effect.forkScoped,
  )

  return {
    /** The run actor: the generated machine of the plan, the only holder of the live snapshot. */
    actor,
    record,
    /** Asks the writer to rewrite the last snapshot with a fresh heartbeat; after the run, it does nothing. */
    touch: Queue.offer(touches, true).pipe(Effect.asVoid),
    /** The writer fiber, so that the job can order its scope's finalizers after it (SV21). */
    writer,
  }
})

export type Recorder = Effect.Success<ReturnType<typeof make>>

export * as TaskRecorder from "./recorder"
