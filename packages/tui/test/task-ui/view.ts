// A real taskView actor over a fixed status, for the design and watch tests: the feed's read returns the status as
// text (clocked at its heartbeat, so a status with a fresh `aliveAt` is live), on a SimulatedClock that moves only when
// a test calls `advance`, so the status is read once unless `later` gives the statuses of the next reads. Events reach
// the machine on their own fibers: `settle` waits for the view to follow.
import { Effect, Exit, Scope } from "effect"
import { createActor, fromEffect, SimulatedClock } from "@jambudipa/xstate-effect"
import { createRoot } from "solid-js"
import { TaskView } from "../../src/task-ui/machine"
import type { Status } from "../../src/task-ui/store"
import { viewOf } from "../../src/task-ui/view"
import type { Listen } from "../../src/task-ui/watch"

/** Lets the actor process what was sent and the snapshot reach Solid. */
export const settle = () => Bun.sleep(15)

export async function viewFor(
  status: Status | undefined,
  options: { design?: number; now?: number; later?: ReadonlyArray<Status> } = {},
) {
  const scope = Effect.runSync(Scope.make())
  const steps = [status, ...(options.later ?? [])]
  const reads = { count: 0 }
  const read = fromEffect<{ directory: string }, TaskView.Read, never, never>(() =>
    Effect.sync(() => {
      const current = steps[Math.min(reads.count++, steps.length - 1)]
      return {
        exists: current !== undefined,
        text: current ? JSON.stringify(current) : "",
        mtime: 0,
        logs: [],
        now: options.now ?? current?.run.aliveAt ?? 0,
      }
    }),
  )
  const clock = new SimulatedClock()
  const actor = await Effect.runPromise(
    Scope.provide(scope)(
      createActor(TaskView.machine.provide({ actors: { read } }), {
        input: { directory: "/repo", design: options.design ?? 1 },
        clock,
      }),
    ),
  )
  await Effect.runPromise(actor.start)
  const root = createRoot((dispose) => ({ view: viewOf(actor), dispose }))
  // With a status, wait for the first read to reach the view.
  if (status !== undefined) for (let tries = 0; tries < 100 && root.view.status() === undefined; tries++) await settle()
  // The plugin's way to hear the stop key's warn and stop.
  const listen: Listen = (type, run) => {
    Effect.runFork(Scope.provide(scope)(actor.on(type, () => Effect.sync(run))))
  }
  return {
    view: root.view,
    listen,
    /** Moves the actor's clock: each second the feed reads the next of `later`. */
    advance: async (ms: number) => {
      await Effect.runPromise(clock.increment(ms))
      await settle()
    },
    dispose: () => {
      root.dispose()
      Effect.runFork(Scope.close(scope, Exit.void))
    },
  }
}
