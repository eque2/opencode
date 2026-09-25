import { expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/solid-virtual"
import { Chunk, Effect } from "effect"
import { mutationNodesContainElement, observeElementOffsetReconnectAware } from "./observe-element-offset"

/** Completes on the next animation frame. Interrupting it cancels the frame request. */
const nextFrame = Effect.callback<void>((resume) => {
  const handle = requestAnimationFrame(() => resume(Effect.void))
  return Effect.sync(() => cancelAnimationFrame(handle))
})

const frames = (count: number) =>
  Effect.gen(function* () {
    for (let index = 0; index < count; index++) yield* nextFrame
  })

/**
 * A real TanStack virtualizer attached to `viewport` without mounting it. The
 * test sets the fields that the offset observer reads: the scroll element,
 * the target window and the last scroll offset.
 */
const virtualizerFor = (
  viewport: HTMLDivElement,
  input: { scrollOffset: number; horizontal: boolean; isRtl: boolean; isScrollingResetDelay: number },
) => {
  const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport,
    estimateSize: () => 0,
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
    horizontal: input.horizontal,
    isRtl: input.isRtl,
    isScrollingResetDelay: input.isScrollingResetDelay,
    useScrollendEvent: false,
  })
  instance.scrollElement = viewport
  instance.targetWindow = window
  instance.scrollOffset = input.scrollOffset
  return instance
}

test("matches only the scroll element or an ancestor containing it", () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  const child = document.createElement("div")
  const sibling = document.createElement("div")
  route.append(viewport)
  viewport.append(child)

  expect(mutationNodesContainElement([viewport], viewport)).toBe(true)
  expect(mutationNodesContainElement([route], viewport)).toBe(true)
  expect(mutationNodesContainElement([child, sibling], viewport)).toBe(false)
})

test("reports a divergent native offset once and ignores equal offsets and unrelated mutations", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const route = document.createElement("section")
      const viewport = document.createElement("div")
      const unrelated = document.createElement("div")
      route.append(viewport)
      document.body.append(route)
      const instance = virtualizerFor(viewport, {
        scrollOffset: 79_400,
        horizontal: false,
        isRtl: false,
        isScrollingResetDelay: 0,
      })
      let calls = Chunk.empty<[number, boolean]>()
      const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
        calls = Chunk.append(calls, [offset, isScrolling])
        instance.scrollOffset = offset
      })

      document.body.append(unrelated)
      unrelated.remove()
      yield* frames(2)
      expect(Chunk.toReadonlyArray(calls)).toEqual([])

      route.remove()
      document.body.append(route)
      yield* Effect.sleep("0 millis")
      yield* frames(3)
      expect(Chunk.toReadonlyArray(calls)).toEqual([[0, false]])

      route.remove()
      document.body.append(route)
      yield* Effect.sleep("0 millis")
      yield* frames(3)
      expect(Chunk.toReadonlyArray(calls)).toEqual([[0, false]])

      cleanup?.()
      route.remove()
    }),
  ))

test("keeps checking until stale reset-delay callbacks can no longer win", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const route = document.createElement("section")
      const viewport = document.createElement("div")
      route.append(viewport)
      document.body.append(route)
      const instance = virtualizerFor(viewport, {
        scrollOffset: 79_400,
        horizontal: false,
        isRtl: false,
        isScrollingResetDelay: 20,
      })
      let calls = Chunk.empty<number>()
      const cleanup = observeElementOffsetReconnectAware(instance, (offset) => {
        calls = Chunk.append(calls, offset)
        instance.scrollOffset = offset
      })

      route.remove()
      document.body.append(route)
      yield* Effect.sleep("0 millis")
      yield* frames(1)
      expect(instance.scrollOffset).toBe(0)

      instance.scrollOffset = 79_400
      yield* Effect.sleep("25 millis")
      yield* frames(3)

      expect(instance.scrollOffset).toBe(0)
      expect(Chunk.toReadonlyArray(calls)).toEqual([0, 0])
      cleanup?.()
      route.remove()
    }),
  ))

test.each([
  { name: "LTR", isRtl: false, expected: 240 },
  { name: "RTL", isRtl: true, expected: -240 },
])("reports the TanStack horizontal $name offset after reconnect", ({ isRtl, expected }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const route = document.createElement("section")
      const viewport = document.createElement("div")
      route.append(viewport)
      document.body.append(route)
      viewport.scrollLeft = 240
      const instance = virtualizerFor(viewport, {
        scrollOffset: 0,
        horizontal: true,
        isRtl,
        isScrollingResetDelay: 0,
      })
      let calls = Chunk.empty<[number, boolean]>()
      const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
        calls = Chunk.append(calls, [offset, isScrolling])
        instance.scrollOffset = offset
      })

      route.remove()
      document.body.append(route)
      yield* Effect.sleep("0 millis")
      yield* frames(3)

      expect(Chunk.toReadonlyArray(calls)).toEqual([[expected, false]])
      cleanup?.()
      route.remove()
    }),
  ),
)

test("cleanup suppresses an already queued delegated offset callback", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const viewport = document.createElement("div")
      document.body.append(viewport)
      viewport.scrollTop = 100
      const instance = virtualizerFor(viewport, {
        scrollOffset: 0,
        horizontal: false,
        isRtl: false,
        isScrollingResetDelay: 10,
      })
      let calls = Chunk.empty<[number, boolean]>()
      const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
        calls = Chunk.append(calls, [offset, isScrolling])
      })

      viewport.dispatchEvent(new Event("scroll"))
      cleanup?.()
      yield* Effect.sleep("25 millis")

      expect(Chunk.toReadonlyArray(calls)).toEqual([[100, true]])
      viewport.remove()
    }),
  ))

test("cleanup cancels reconnect checks and delegated offset observation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const route = document.createElement("section")
      const viewport = document.createElement("div")
      route.append(viewport)
      document.body.append(route)
      const instance = virtualizerFor(viewport, {
        scrollOffset: 0,
        horizontal: false,
        isRtl: false,
        isScrollingResetDelay: 50,
      })
      let calls = Chunk.empty<number>()
      const cleanup = observeElementOffsetReconnectAware(instance, (offset) => {
        calls = Chunk.append(calls, offset)
      })

      route.remove()
      document.body.append(route)
      yield* Effect.sleep("0 millis")
      cleanup?.()
      instance.scrollOffset = 100
      viewport.dispatchEvent(new Event("scroll"))
      yield* frames(4)

      expect(Chunk.toReadonlyArray(calls)).toEqual([])
      route.remove()
    }),
  ))
