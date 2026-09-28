import { Cause, Data, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedError<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedError<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

export type State<A, E> = Data.TaggedEnum<{
  Idle: {}
  Running: { readonly run: RunHandle<A, E> }
  Shell: { readonly shell: ShellHandle<A, E> }
  ShellThenRun: { readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }
}>

interface StateDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: State<this["A"], this["B"]>
}

const { Idle, Running, Shell, ShellThenRun } = Data.taggedEnum<StateDefinition>()

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>(Idle<A, E>())
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  const finishRun = (id: number, done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    SynchronizedRef.modify(
      ref,
      (st) =>
        [
          Effect.gen(function* () {
            if (st._tag === "Running" && st.run.id === id) yield* idle
            yield* complete(done, exit)
          }),
          st._tag === "Running" && st.run.id === id ? Idle<A, E>() : st,
        ] as const,
    ).pipe(Effect.flatten)

  const startRun = (work: Effect.Effect<A, E>, done: Deferred.Deferred<A, E | Cancelled>) =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber } satisfies RunHandle<A, E>
    })

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          return [idle, Idle<A, E>()] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const run = yield* startRun(st.run.work, st.run.done)
          return [Effect.void, Running({ run })] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.done(shell.cancelled, Exit.void).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const ensureRunning = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Running" || st._tag === "ShellThenRun") return [awaitDone(st.run.done), st] as const
        if (st._tag === "Shell") {
          const run = {
            id: next(),
            done: yield* Deferred.make<A, E | Cancelled>(),
            work,
          } satisfies PendingHandle<A, E>
          return [awaitDone(run.done), ShellThenRun({ shell: st.shell, run })] as const
        }
        const done = yield* Deferred.make<A, E | Cancelled>()
        const run = yield* startRun(work, done)
        return [awaitDone(done), Running({ run })] as const
      }),
    ).pipe(Effect.flatten)

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          Shell({ shell }),
        ] as const
      }),
    ).pipe(Effect.flatten)

  const cancel = SynchronizedRef.modify(ref, (st) => {
    if (st._tag === "Idle") return [Effect.void, st] as const
    if (st._tag === "Running")
      return [
        Effect.gen(function* () {
          yield* Fiber.interrupt(st.run.fiber)
          yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
          yield* idleIfCurrent()
        }),
        Idle<A, E>(),
      ] as const
    if (st._tag === "Shell")
      return [
        Effect.gen(function* () {
          yield* stopShell(st.shell)
          yield* idleIfCurrent()
        }),
        Idle<A, E>(),
      ] as const
    return [
      Effect.gen(function* () {
        yield* stopShell(st.shell)
        yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
        yield* idleIfCurrent()
      }),
      Idle<A, E>(),
    ] as const
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    startShell,
    cancel,
  }
}

export * as Runner from "./runner"
