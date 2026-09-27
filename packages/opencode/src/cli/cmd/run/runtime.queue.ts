// Serial prompt queue for direct interactive mode.
//
// Prompts arrive from the footer (user types and hits enter) and queue up
// here. The queue drains one turn at a time; ordinary prompts waiting behind
// an active ordinary turn are exposed for edit/removal until they begin.
//
// The queue also handles /exit, /quit, and /new commands, empty-prompt rejection,
// and tracks per-turn wall-clock duration for the footer status line.
//
// Resolves when the footer closes and all in-flight work finishes.
import { Clock, Deferred, Effect, FiberSet, Option, Predicate } from "effect"
import * as Locale from "@/util/locale"
import { MessageID, PartID } from "@/session/schema"
import { isExitCommand, isNewCommand } from "./prompt.shared"
import type { FooterApi, FooterEvent, FooterQueuedPrompt, RunPrompt } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

export type QueueInput = {
  footer: FooterApi
  initialInput?: string
  trace?: Trace
  onSend?: (prompt: RunPrompt) => void
  onNewSession?: () => void | Promise<void>
  run: (prompt: RunPrompt, signal: AbortSignal) => Promise<void>
}

type State = {
  queue: RunPrompt[]
  queued: FooterQueuedPrompt[]
  active: Option.Option<RunPrompt>
  ctrl: Option.Option<AbortController>
  closed: boolean
}

// How one turn ended: it ran to the end, or the queue closed while it ran.
type TurnOutcome = "done" | "closed"

// Runs the prompt queue until the footer closes.
//
// Subscribes to footer prompt events and drains operations through input.run().
// Ordinary prompts submitted during an ordinary active turn remain local and
// are exposed by the footer for edit/removal until their turn begins.
export function runPromptQueue(input: QueueInput): Promise<void> {
  return Effect.runPromise(promptQueue(input))
}

// Runs a callback that may return a Promise, and waits for that Promise.
function settleCallback(run: () => void | Promise<void>) {
  return Effect.suspend(() => {
    const result = run()
    return Predicate.isPromiseLike(result) ? Effect.promise(() => result) : Effect.void
  })
}

const promptQueue = Effect.fnUntraced(function* (input: QueueInput) {
  const stop = yield* Deferred.make<void>()
  const done = yield* Deferred.make<void>()
  const drains = yield* FiberSet.make<void>()
  const runDrain = yield* FiberSet.runtime(drains)()
  const state: State = {
    queue: [],
    queued: [],
    active: Option.none(),
    ctrl: Option.none(),
    closed: input.footer.isClosed,
  }
  let draining = false

  const emit = (next: FooterEvent, row: Record<string, unknown>) => {
    input.trace?.write("ui.patch", row)
    input.footer.event(next)
  }

  const syncQueue = () => {
    const queue = state.queue.length
    emit({ type: "queue", queue }, { queue })
    emit(
      {
        type: "queued.prompts",
        prompts: [...state.queued],
      },
      { queued: state.queued.length },
    )
  }

  const removeLocalQueued = (queued: FooterQueuedPrompt) => {
    if (!state.queued.includes(queued)) return
    state.queued = state.queued.filter((item) => item !== queued)
    syncQueue()
  }

  const finish = () => {
    if (!state.closed || draining) {
      return
    }

    Deferred.doneUnsafe(done, Effect.void)
  }

  const close = () => {
    if (state.closed) {
      return
    }

    state.closed = true
    state.queue.length = 0
    state.queued.length = 0
    if (Option.isSome(state.ctrl)) {
      state.ctrl.value.abort()
    }
    Deferred.doneUnsafe(stop, Effect.void)
    finish()
  }

  const recordDuration = (start: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const duration = Locale.duration(Math.max(0, now - start))
      emit(
        {
          type: "turn.duration",
          duration,
        },
        {
          duration,
        },
      )
    })

  // Runs one prompt. The turn stops early when the queue closes.
  const runTurn = (sent: RunPrompt, ctrl: AbortController) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => input.footer.idle())
      if (state.closed) {
        return "closed" satisfies TurnOutcome
      }

      if (sent.mode !== "shell") {
        const commit = {
          kind: "user",
          text: sent.text,
          phase: "start",
          source: "system",
          messageID: sent.messageID,
        } as const
        input.trace?.write("ui.commit", commit)
        input.footer.append(commit)
      }
      input.onSend?.(sent)

      if (state.closed) {
        return "closed" satisfies TurnOutcome
      }

      const next = yield* Effect.raceFirst(
        Effect.promise(() => input.run(sent, ctrl.signal)).pipe(Effect.as<TurnOutcome>("done")),
        Deferred.await(stop).pipe(Effect.as<TurnOutcome>("closed")),
      )
      if (next === "closed") {
        ctrl.abort()
      }

      return next
    })

  const drainQueue = Effect.gen(function* () {
    while (!state.closed && state.queue.length > 0) {
      const prompt = state.queue.shift()
      if (!prompt) {
        continue
      }

      const queued = state.queued.find((item) => item.prompt === prompt)
      if (queued) removeLocalQueued(queued)

      if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
        syncQueue()
        if (!input.onNewSession) {
          emit(
            {
              type: "stream.patch",
              patch: {
                status: "new sessions unavailable",
              },
            },
            {
              status: "new sessions unavailable",
            },
          )
          continue
        }

        emit(
          {
            type: "stream.patch",
            patch: {
              phase: "running",
              status: "starting new session",
              queue: state.queue.length,
            },
          },
          {
            phase: "running",
            status: "starting new session",
            queue: state.queue.length,
          },
        )
        yield* settleCallback(input.onNewSession)
        continue
      }

      const sent =
        prompt.mode === "shell"
          ? prompt
          : {
              ...prompt,
              messageID: prompt.messageID ?? queued?.messageID ?? MessageID.ascending(),
            }
      state.active = Option.some(sent)

      emit(
        {
          type: "turn.send",
          queue: state.queue.length,
        },
        {
          phase: "running",
          status: "sending prompt",
          queue: state.queue.length,
        },
      )
      const start = yield* Clock.currentTimeMillis
      const ctrl = new AbortController()
      state.ctrl = Option.some(ctrl)

      const outcome = yield* runTurn(sent, ctrl).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (Option.isSome(state.ctrl) && state.ctrl.value === ctrl) {
              state.ctrl = Option.none()
            }

            if (sent.mode !== "shell") {
              yield* recordDuration(start)
            }
            state.active = Option.none()
          }),
        ),
      )
      if (outcome === "closed") {
        break
      }
    }
  })

  // A failed turn fails the whole queue, and a later finish() cannot undo it.
  const drainOnce = drainQueue.pipe(
    Effect.catchCause((cause) => Deferred.failCause(done, cause)),
    Effect.asVoid,
    Effect.ensuring(
      Effect.sync(() => {
        draining = false
        emit(
          {
            type: "turn.idle",
            queue: state.queue.length,
          },
          {
            phase: "idle",
            status: "",
            queue: state.queue.length,
          },
        )
        finish()
      }),
    ),
  )

  const drain = () => {
    if (draining || state.closed || state.queue.length === 0) {
      return
    }

    draining = true
    runDrain(drainOnce)
  }

  const submit = (prompt: RunPrompt) => {
    if (!prompt.text.trim() || state.closed) {
      return
    }

    if (prompt.mode !== "shell" && isExitCommand(prompt.text)) {
      input.footer.close()
      return
    }

    const activeTurn = Option.exists(state.active, (active) => active.mode !== "shell" && !active.command)
    if (activeTurn && prompt.mode !== "shell" && !prompt.command && !isNewCommand(prompt.text)) {
      const queued: FooterQueuedPrompt = {
        messageID: MessageID.ascending(),
        partID: PartID.ascending(),
        prompt,
      }
      state.queued = [...state.queued, queued]
      state.queue.push(prompt)
      syncQueue()
      return
    }

    state.queue.push(prompt)
    syncQueue()
    if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
      drain()
      return
    }

    emit(
      {
        type: "first",
        first: false,
      },
      {
        first: false,
      },
    )
    drain()
  }

  const offPrompt = input.footer.onPrompt((prompt) => {
    submit(prompt)
  })
  const offClose = input.footer.onClose(() => {
    close()
  })
  const offRemoveQueued = input.footer.onQueuedRemove((messageID) => {
    const queued = state.queued.find((item) => item.messageID === messageID)
    if (!queued) return false
    state.queue = state.queue.filter((prompt) => prompt !== queued.prompt)
    removeLocalQueued(queued)
    return true
  })

  yield* Effect.gen(function* () {
    if (state.closed) {
      return
    }

    submit({
      text: input.initialInput ?? "",
      parts: [],
    })
    finish()
    yield* Deferred.await(done)
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        offPrompt()
        offClose()
        offRemoveQueued()
        close()
        yield* FiberSet.awaitEmpty(drains)
      }),
    ),
  )
}, Effect.scoped)
