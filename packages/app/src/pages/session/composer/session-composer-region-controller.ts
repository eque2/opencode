import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { Effect, Option } from "effect"
import { type Accessor, createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptInputState } from "@/components/prompt-input"
import { useSync } from "@/context/sync"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { createFiberSlot } from "@/utils/fiber-slot"
import type { SessionComposerController } from "./session-composer-state"

/** Completes on the next animation frame. Interrupting it cancels the frame request. */
const nextFrame = Effect.callback<void>((resume) => {
  const handle = requestAnimationFrame(() => resume(Effect.void))
  return Effect.sync(() => cancelAnimationFrame(handle))
})

export type SessionComposerFollowupDock = {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
}

export type SessionComposerRevertDock = {
  items: { id: string; text: string }[]
  restoring?: string
  disabled?: boolean
  onRestore: (id: string) => void
}

export function createSessionComposerRegionController(input: {
  state: SessionComposerController
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  prompt: PromptInputState
  ready: Accessor<boolean>
  centered: Accessor<boolean>
  todo: {
    collapsed: Accessor<boolean>
    onToggle: () => void
  }
  followup: Accessor<SessionComposerFollowupDock | undefined>
  revert: Accessor<SessionComposerRevertDock | undefined>
  onResponseSubmit: () => void
  openParent: () => void
  setPromptRef: (el: HTMLDivElement) => void
  setDockRef: (el: HTMLDivElement) => void
}) {
  const sync = useSync()
  const [store, setStore] = createStore<{ ready: boolean; height: number; body?: HTMLDivElement }>({
    ready: input.ready() || input.state.dock(),
    height: 320,
  })
  // Holds the frame and the 140 ms delay that reveal the dock; the owner cleanup interrupts it.
  const reveal = createFiberSlot()

  createEffect(() => {
    input.sessionKey()
    const ready = input.ready()
    const dock = input.state.dock()

    reveal.interrupt()
    if (store.ready || (!ready && !dock)) return
    if (dock) {
      setStore("ready", true)
      return
    }

    reveal.run(
      nextFrame.pipe(
        Effect.andThen(Effect.sleep("140 millis")),
        Effect.andThen(Effect.sync(() => setStore("ready", true))),
      ),
    )
  })

  createEffect(() => {
    if (!input.prompt.ready()) return
    setSessionHandoff(input.sessionKey(), {
      prompt: input.prompt
        .current()
        .map((part) => {
          if (part.type === "file") return `[file:${part.path}]`
          if (part.type === "agent") return `@${part.name}`
          if (part.type === "image") return `[image:${part.filename}]`
          return part.content
        })
        .join("")
        .trim(),
    })
  })

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => setStore("height", el.getBoundingClientRect().height)
    createResizeObserver(el, update)
    update()
  })

  const parentID = createMemo(() =>
    Option.fromNullishOr(input.sessionID()).pipe(Option.flatMapNullishOr((id) => sync().session.get(id)?.parentID)),
  )
  const open = createMemo(() => store.ready && input.state.dock() && !input.state.closing())
  const progress = useSpring(
    () => (open() ? 1 : 0),
    { visualDuration: 0.3, bounce: 0 },
    () => `${input.sessionKey()}\0${store.ready}`,
  )
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const ready = Promise.resolve()
  const [promptReady] = createResource(
    () => input.prompt.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  return {
    state: input.state,
    centered: input.centered,
    todo: input.todo,
    followup: input.followup,
    revert: input.revert,
    onResponseSubmit: input.onResponseSubmit,
    openParent: input.openParent,
    setPromptRef: input.setPromptRef,
    setDockRef: input.setDockRef,
    parentID,
    child: () => Option.isSome(parentID()),
    showComposer: () => !input.state.blocked() || Option.isSome(parentID()),
    handoffPrompt: () => getSessionHandoff(input.sessionKey())?.prompt,
    promptReady: () => input.prompt.ready() || promptReady(),
    dock: () => (store.ready && input.state.dock()) || value() > 0.001,
    dockProgress: value,
    dockHeight: () => Math.max(78, store.height),
    lift: () => (input.revert()?.items.length ? 18 : 36 * value()),
    setDockBodyRef: (el: HTMLDivElement) => setStore("body", el),
  }
}

export type SessionComposerRegionController = ReturnType<typeof createSessionComposerRegionController>
