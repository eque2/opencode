import { Show, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Effect, Option } from "effect"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { createFiberSlot } from "./fiber-slot"

function common(active: string, done: string) {
  const a = Array.from(active)
  const b = Array.from(done)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return {
    prefix: a.slice(0, i).join(""),
    active: a.slice(i).join(""),
    done: b.slice(i).join(""),
  }
}

function contentWidth(el: HTMLSpanElement | undefined): Option.Option<string> {
  if (!el) return Option.none()
  return Option.some(`${Math.ceil(el.getBoundingClientRect().width)}px`)
}

export function ToolStatusTitle(props: {
  active: boolean
  activeText: string
  doneText: string
  class?: string
  split?: boolean
}) {
  const split = createMemo(() => common(props.activeText, props.doneText))
  const suffix = createMemo(
    () => (props.split ?? true) && split().prefix.length >= 2 && split().active.length > 0 && split().done.length > 0,
  )
  const prefixLen = createMemo(() => Array.from(split().prefix).length)
  const activeTail = createMemo(() => (suffix() ? split().active : props.activeText))
  const doneTail = createMemo(() => (suffix() ? split().done : props.doneText))

  const [state, setState] = createStore<{ active: boolean; animating: boolean; width: Option.Option<string> }>({
    active: props.active,
    animating: false,
    width: Option.none(),
  })
  // The style prop takes string | undefined, and an absent width clears the inline width.
  const width = () => Option.getOrUndefined(state.width)
  const active = () => state.active
  const animating = () => state.animating
  let activeRef: HTMLSpanElement | undefined
  let doneRef: HTMLSpanElement | undefined
  let widthRef: HTMLSpanElement | undefined
  let frame: Option.Option<number> = Option.none()
  const finishTimer = createFiberSlot()

  const settle = () => {
    setState("animating", false)
    setState("width", Option.none())
  }

  const finish = () => {
    if (Option.isSome(frame)) cancelAnimationFrame(frame.value)
    frame = Option.none()
    finishTimer.interrupt()
    settle()
  }

  const animate = () => {
    const first = contentWidth(widthRef)
    const next = props.active
    finish()
    setState("active", next)
    if (Option.isNone(first)) return

    setState("animating", true)
    setState("width", first)
    frame = Option.some(
      requestAnimationFrame(() => {
        frame = Option.none()
        const last = contentWidth(next ? activeRef : doneRef)
        if (Option.isNone(last)) {
          finish()
          return
        }
        if (first.value !== last.value) setState("width", last)
        // The frame is already done here, so the timer only settles the state, as finish() did.
        finishTimer.run(Effect.sleep("600 millis").pipe(Effect.andThen(Effect.sync(settle))))
      }),
    )
  }

  createEffect(on([() => props.active, activeTail, doneTail], () => animate(), { defer: true }))

  onCleanup(() => {
    finish()
  })

  return (
    <span
      data-component="tool-status-title"
      data-active={active() ? "true" : "false"}
      data-ready={animating() ? "true" : "false"}
      data-mode={suffix() ? "suffix" : "swap"}
      class={props.class}
      aria-label={active() ? props.activeText : props.doneText}
    >
      <Show
        when={suffix()}
        fallback={
          <span data-slot="tool-status-swap" ref={widthRef} style={{ width: width() }}>
            <Show when={animating() || active()}>
              <span data-slot="tool-status-active" ref={activeRef}>
                <TextShimmer text={activeTail()} active={active()} offset={0} />
              </span>
            </Show>
            <Show when={animating() || !active()}>
              <span data-slot="tool-status-done" ref={doneRef}>
                <TextShimmer text={doneTail()} active={false} offset={0} />
              </span>
            </Show>
          </span>
        }
      >
        <span data-slot="tool-status-suffix">
          <span data-slot="tool-status-prefix">
            <TextShimmer text={split().prefix} active={active()} offset={0} />
          </span>
          <span data-slot="tool-status-tail" ref={widthRef} style={{ width: width() }}>
            <Show when={animating() || active()}>
              <span data-slot="tool-status-active" ref={activeRef}>
                <TextShimmer text={activeTail()} active={active()} offset={prefixLen()} />
              </span>
            </Show>
            <Show when={animating() || !active()}>
              <span data-slot="tool-status-done" ref={doneRef}>
                <TextShimmer text={doneTail()} active={false} offset={prefixLen()} />
              </span>
            </Show>
          </span>
        </span>
      </Show>
    </span>
  )
}
