import { Effect, HashMap, Option } from "effect"
import { onCleanup } from "solid-js"
import { createFiberSlot } from "@/utils/fiber-slot"

export type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

export type ShellSelectOption = {
  id: string
  value: string
  name: string
  terminalOnly: boolean
}

export function createShellOptions(input: { shells: ShellOption[]; current: string | undefined }) {
  const counts = input.shells.reduce(
    (result, shell) => HashMap.set(result, shell.name, Option.getOrElse(HashMap.get(result, shell.name), () => 0) + 1),
    HashMap.empty<string, number>(),
  )
  const options: ShellSelectOption[] = [
    { id: "auto", value: "", name: "", terminalOnly: false },
    ...input.shells.map((shell) => {
      const ambiguous = Option.getOrElse(HashMap.get(counts, shell.name), () => 0) > 1
      const name = ambiguous ? shell.path : shell.name
      return {
        id: shell.path,
        value: ambiguous ? shell.path : shell.name,
        name,
        terminalOnly: !shell.acceptable,
      }
    }),
  ]
  if (input.current && !options.some((option) => option.value === input.current)) {
    return [...options, { id: input.current, value: input.current, name: input.current, terminalOnly: false }]
  }
  return options
}

export function createSoundPreviewController(player: (id: string | undefined) => Promise<(() => void) | undefined>) {
  let cleanup = Option.none<() => void>()
  // The preview delay. The owner cleanup interrupts it.
  const timer = createFiberSlot()
  let run = 0

  const stop = () => {
    run += 1
    if (Option.isSome(cleanup)) cleanup.value()
    timer.interrupt()
    cleanup = Option.none()
  }
  const play = (id: string | undefined) => {
    stop()
    if (!id) return
    const current = ++run
    timer.run(
      Effect.sleep("100 millis").pipe(
        Effect.andThen(
          // A started preview must still reach its stop function, so a later stop() cannot interrupt this part.
          Effect.uninterruptible(
            Effect.promise(() => player(id)).pipe(
              Effect.map((next) => {
                const stopPreview = Option.fromNullishOr(next)
                if (run === current) {
                  cleanup = stopPreview
                  return
                }
                if (Option.isSome(stopPreview)) stopPreview.value()
              }),
            ),
          ),
        ),
      ),
    )
  }

  onCleanup(stop)
  return { play, stop }
}
