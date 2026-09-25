import { Data, Effect, Option } from "effect"
import { createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { useParams } from "@solidjs/router"
import { showToast } from "@/utils/toast"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { createFiberSlot } from "@/utils/fiber-slot"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

/** The permission reply request rejected. `cause` holds the original rejection. */
class PermissionReplyError extends Data.TaggedError("App.PermissionReplyError")<{ readonly cause: unknown }> {}

// Runs a program from a UI handler that does not wait for it; a defect is logged.
const runDetached = <A, E>(program: Effect.Effect<A, E>) => {
  Effect.runFork(program.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

/** Completes on the next animation frame. Interrupting it cancels the frame request. */
const nextFrame = Effect.callback<void>((resume) => {
  const handle = requestAnimationFrame(() => resume(Effect.void))
  return Effect.sync(() => cancelAnimationFrame(handle))
})

export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "clear" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live) return "clear"
  if (!input.done) return "open"
  return "close"
}

export const todoDockAtBoundary = (state: ReturnType<typeof todoState>) => state === "open"

const idle = { type: "idle" as const }

export function createSessionComposerController(options?: { closeMs?: number | (() => number) }) {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const language = useLanguage()
  const permission = usePermission()

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sync().data.session, sync().data.question, params.id)
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync().data.session, sync().data.permission, params.id, (item) => {
      return !permission.autoResponds(item, sdk().directory)
    })
  })

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return []
    return serverSync().session.data.todo[id] ?? []
  })

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  const live = createMemo(() => sync().data.session_working(params.id ?? "") || blocked())

  const [store, setStore] = createStore({
    sessionID: params.id,
    responding: Option.none<string>(),
    dock: todos().length > 0 && !done() && live(),
    closing: false,
    opening: false,
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return Option.contains(store.responding, perm.id)
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (Option.contains(store.responding, perm.id)) return

    setStore("responding", Option.some(perm.id))
    runDetached(
      Effect.tryPromise({
        try: () => sdk().api.permission.reply({ sessionID: perm.sessionID, requestID: perm.id, reply: response }),
        catch: (cause) => new PermissionReplyError({ cause }),
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            const description = error.cause instanceof Error ? error.cause.message : String(error.cause)
            showToast({ title: language.t("common.requestFailed"), description })
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => setStore("responding", (id) => (Option.contains(id, perm.id) ? Option.none() : id))),
        ),
      ),
    )
  }

  // The close delay and the frame that ends the opening state. The owner cleanup interrupts both.
  const closeTimer = createFiberSlot()
  const openingFrame = createFiberSlot()
  let closeScheduled = false

  const cancelClose = () => {
    closeTimer.interrupt()
    closeScheduled = false
  }

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    closeScheduled = true
    closeTimer.run(
      Effect.sleep(closeMs()).pipe(
        Effect.andThen(
          Effect.sync(() => {
            setStore({ dock: false, closing: false })
            closeScheduled = false
          }),
        ),
      ),
    )
  }

  // Keep stale turn todos from reopening if the model never clears them.
  const clear = () => {
    const id = params.id
    if (!id) return
    sync().set("todo", id, [])
  }

  createEffect(
    on(
      () => [params.id, todos().length, done(), live()] as const,
      ([id, count, complete, active], previous) => {
        openingFrame.interrupt()

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (!previous || previous[0] !== id) {
          cancelClose()
          setStore({ sessionID: id, dock: todoDockAtBoundary(next), closing: false, opening: false })
          if (next === "clear") clear()
          return
        }

        if (next === "hide") {
          cancelClose()
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          cancelClose()
          clear()
          return
        }

        if (next === "open") {
          cancelClose()
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            openingFrame.run(nextFrame.pipe(Effect.andThen(Effect.sync(() => setStore("opening", false)))))
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!closeScheduled) scheduleClose()
      },
    ),
  )

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    todos,
    dock: () =>
      store.sessionID === params.id
        ? store.dock
        : todoDockAtBoundary(todoState({ count: todos().length, done: done(), live: live() })),
    closing: () => store.sessionID === params.id && store.closing,
    opening: () => store.sessionID === params.id && store.opening,
  }
}

export type SessionComposerController = ReturnType<typeof createSessionComposerController>
