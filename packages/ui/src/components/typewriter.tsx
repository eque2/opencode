import { Effect, Random } from "effect"
import { createEffect, Show, type ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { createFiberSlot } from "../hooks/create-fiber-slot"

// Mostly quick keystrokes, with an occasional hesitation or long pause.
const typingDelay = Effect.gen(function* () {
  const roll = yield* Random.next
  if (roll < 0.05) return yield* Random.nextBetween(150, 250)
  if (roll < 0.15) return yield* Random.nextBetween(80, 140)
  return yield* Random.nextBetween(30, 80)
})

export const Typewriter = (props: { text?: string; class?: string; as?: ValidComponent }) => {
  const [store, setStore] = createStore({
    typing: false,
    displayed: "",
    cursor: true,
  })

  createEffect(() => {
    const text = props.text
    if (!text) return

    // Made inside the effect, so the effect's cleanup interrupts the run for the previous text.
    const typing = createFiberSlot()
    setStore("typing", true)
    setStore("displayed", "")
    setStore("cursor", true)

    typing.run(
      Effect.gen(function* () {
        yield* Effect.sleep("200 millis")
        for (let i = 1; i <= text.length; i++) {
          setStore("displayed", text.slice(0, i))
          const delay = yield* typingDelay
          yield* Effect.sleep(delay)
        }
        setStore("typing", false)
        yield* Effect.sleep("2 seconds")
        setStore("cursor", false)
      }),
    )
  })

  return (
    <Dynamic component={props.as || "p"} class={props.class}>
      {store.displayed}
      <Show when={store.cursor}>
        <span classList={{ "blinking-cursor": !store.typing }}>│</span>
      </Show>
    </Dynamic>
  )
}
