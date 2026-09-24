import { Duration, Effect } from "effect"
import { createEffect, createMemo, createSignal, type ValidComponent } from "solid-js"
import { Dynamic } from "solid-js/web"
import { createFiberSlot } from "../../hooks/create-fiber-slot"
import "./text-shimmer-v2.css"

export const TextShimmerV2 = (props: {
  text: string
  class?: string
  as?: ValidComponent
  active?: boolean
  offset?: number
}) => {
  const text = createMemo(() => props.text ?? "")
  const active = createMemo(() => props.active ?? true)
  const offset = createMemo(() => props.offset ?? 0)
  const [run, setRun] = createSignal(active())
  const swap = 220
  const swapDelay = createFiberSlot()

  createEffect(() => {
    swapDelay.interrupt()

    if (active()) {
      setRun(true)
      return
    }

    swapDelay.run(Effect.sleep(Duration.millis(swap)).pipe(Effect.andThen(Effect.sync(() => setRun(false)))))
  })

  return (
    <Dynamic
      component={props.as ?? "span"}
      data-component="text-shimmer-v2"
      data-active={active() ? "true" : "false"}
      class={props.class}
      aria-label={text()}
      style={{
        "--_swap": `${swap}ms`,
        "--_index": `${offset()}`,
      }}
    >
      <span data-slot="text-shimmer-v2-char">
        <span data-slot="text-shimmer-v2-base" aria-hidden="true">
          {text()}
        </span>
        <span data-slot="text-shimmer-v2-shimmer" data-run={run() ? "true" : "false"} aria-hidden="true">
          {text()}
        </span>
      </span>
    </Dynamic>
  )
}
