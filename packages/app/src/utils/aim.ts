import { Effect, Option } from "effect"
import { createFiberSlot } from "@/utils/fiber-slot"

type Point = { x: number; y: number }

export function createAim(props: {
  enabled: () => boolean
  active: () => string | undefined
  el: () => HTMLElement | undefined
  onActivate: (id: string) => void
  delay?: number
  max?: number
  tolerance?: number
  edge?: number
}) {
  const state: {
    locs: Point[]
    pending: Option.Option<string>
    over: Option.Option<string>
    last: Option.Option<Point>
  } = {
    locs: [],
    pending: Option.none(),
    over: Option.none(),
    last: Option.none(),
  }
  // The pending activation delay. The owner cleanup interrupts it.
  const timer = createFiberSlot()

  const delay = props.delay ?? 250
  const max = props.max ?? 4
  const tolerance = props.tolerance ?? 80
  const edge = props.edge ?? 18

  const cancel = () => {
    timer.interrupt()
    state.pending = Option.none()
  }

  const reset = () => {
    cancel()
    state.over = Option.none()
    state.last = Option.none()
    state.locs.length = 0
  }

  const move = (event: MouseEvent) => {
    if (!props.enabled()) return
    const el = props.el()
    if (!el) return

    const rect = el.getBoundingClientRect()
    const x = event.clientX
    const y = event.clientY
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return

    state.locs.push({ x, y })
    if (state.locs.length > max) state.locs.shift()
  }

  const wait = () => {
    if (!props.enabled()) return 0
    if (!props.active()) return 0

    const el = props.el()
    if (!el) return 0
    if (state.locs.length < 2) return 0

    const rect = el.getBoundingClientRect()
    const loc = state.locs[state.locs.length - 1]
    if (!loc) return 0

    const prev = state.locs[0] ?? loc
    if (prev.x < rect.left || prev.x > rect.right || prev.y < rect.top || prev.y > rect.bottom) return 0
    if (Option.exists(state.last, (last) => loc.x === last.x && loc.y === last.y)) return 0

    if (rect.right - loc.x <= edge) {
      state.last = Option.some(loc)
      return delay
    }

    const upper = { x: rect.right, y: rect.top - tolerance }
    const lower = { x: rect.right, y: rect.bottom + tolerance }
    const slope = (a: Point, b: Point) => (b.y - a.y) / (b.x - a.x)

    const decreasing = slope(loc, upper)
    const increasing = slope(loc, lower)
    const prevDecreasing = slope(prev, upper)
    const prevIncreasing = slope(prev, lower)

    if (decreasing < prevDecreasing && increasing > prevIncreasing) {
      state.last = Option.some(loc)
      return delay
    }

    state.last = Option.none()
    return 0
  }

  const activate = (id: string) => {
    cancel()
    props.onActivate(id)
  }

  const request = (id: string) => {
    if (!id) return
    if (props.active() === id) return

    if (!props.active()) {
      activate(id)
      return
    }

    const ms = wait()
    if (ms === 0) {
      activate(id)
      return
    }

    cancel()
    state.pending = Option.some(id)
    timer.run(
      Effect.sleep(ms).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!Option.contains(state.pending, id)) return
            state.pending = Option.none()
            if (!props.enabled()) return
            if (!props.active()) return
            if (!Option.contains(state.over, id)) return
            props.onActivate(id)
          }),
        ),
      ),
    )
  }

  const enter = (id: string, event: MouseEvent) => {
    if (!props.enabled()) return
    state.over = Option.some(id)
    move(event)
    request(id)
  }

  const leave = (id: string) => {
    if (Option.contains(state.over, id)) state.over = Option.none()
    if (Option.contains(state.pending, id)) cancel()
  }

  return { move, enter, leave, activate, request, cancel, reset }
}
