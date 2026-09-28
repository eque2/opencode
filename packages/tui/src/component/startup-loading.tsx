import { DateTime, Effect, Fiber, Option } from "effect"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"

export function StartupLoading(props: { ready: () => boolean }) {
  const theme = useTheme().theme
  const [show, setShow] = createSignal(false)
  const text = createMemo(() => (props.ready() ? "Finishing startup…" : "Loading plugins…"))
  // The pending "show after 500 ms" and "hide after the minimum display time" delays.
  let wait: Option.Option<Fiber.Fiber<void>> = Option.none()
  let hold: Option.Option<Fiber.Fiber<void>> = Option.none()
  let stamp = 0

  const interrupt = (fiber: Option.Option<Fiber.Fiber<void>>) => {
    if (Option.isSome(fiber)) Effect.runFork(Fiber.interrupt(fiber.value))
  }

  createEffect(() => {
    if (props.ready()) {
      interrupt(wait)
      wait = Option.none()
      if (!show()) return
      if (Option.isSome(hold)) return

      const left = 3000 - (DateTime.toEpochMillis(DateTime.nowUnsafe()) - stamp)
      if (left <= 0) {
        setShow(false)
        return
      }

      hold = Option.some(
        Effect.runFork(
          Effect.sleep(left).pipe(
            Effect.andThen(
              Effect.sync(() => {
                hold = Option.none()
                setShow(false)
              }),
            ),
          ),
        ),
      )
      return
    }

    interrupt(hold)
    hold = Option.none()
    if (show()) return
    if (Option.isSome(wait)) return

    wait = Option.some(
      Effect.runFork(
        Effect.sleep("500 millis").pipe(
          Effect.andThen(
            Effect.sync(() => {
              wait = Option.none()
              stamp = DateTime.toEpochMillis(DateTime.nowUnsafe())
              setShow(true)
            }),
          ),
        ),
      ),
    )
  })

  onCleanup(() => {
    interrupt(wait)
    interrupt(hold)
  })

  return (
    <Show when={show()}>
      <box position="absolute" zIndex={5000} left={0} right={0} bottom={1} justifyContent="center" alignItems="center">
        <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
          <Spinner color={theme.textMuted}>{text()}</Spinner>
        </box>
      </box>
    </Show>
  )
}
