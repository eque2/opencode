// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import { Effect, Fiber, Option } from "effect"
import { createSignal } from "solid-js"

const OS_NAME = (() => {
  if (navigator.userAgent.includes("Mac")) return "macos"
  if (navigator.userAgent.includes("Windows")) return "windows"
  if (navigator.userAgent.includes("Linux")) return "linux"
  return "unknown"
})()

const [webviewZoom, setWebviewZoom] = createSignal(1)
let requestedZoom = 1
let pinchZoomEnabled = false
/** A Ctrl-wheel pinch gesture in progress. `timeout` is the fiber that ends the gesture after the wheel goes quiet. */
type WheelPinch = {
  active: boolean
  startZoom: number
  totalDelta: number
  timeout: Option.Option<Fiber.Fiber<void>>
}
let wheelPinch = Option.none<WheelPinch>()

const MAX_ZOOM_LEVEL = 10
const MIN_ZOOM_LEVEL = 0.2
const WHEEL_PINCH_THRESHOLD = 20
const WHEEL_PINCH_STEP = 0.2
const WHEEL_PINCH_END_DELAY = 160

const clamp = (value: number) => Math.min(Math.max(value, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL)

const applyZoom = (next: number) => {
  requestedZoom = next
  Effect.runFork(
    Effect.tryPromise(() => window.api.setZoomFactor(next)).pipe(
      Effect.match({
        onSuccess: () => {
          if (requestedZoom !== next) return
          setWebviewZoom(next)
        },
        onFailure: () => {
          if (requestedZoom !== next) return
          requestedZoom = webviewZoom()
        },
      }),
    ),
  )
}

window.api.onZoomFactorChanged((factor) => {
  requestedZoom = clamp(factor)
  setWebviewZoom(requestedZoom)
})

Effect.runFork(
  Effect.promise(() => window.api.getPinchZoomEnabled()).pipe(
    Effect.map((enabled) => {
      pinchZoomEnabled = enabled
    }),
  ),
)

window.api.onPinchZoomEnabledChanged((enabled) => {
  pinchZoomEnabled = enabled
  resetWheelPinch()
})

const setPinchZoomEnabled = (enabled: boolean) => {
  pinchZoomEnabled = enabled
  resetWheelPinch()
  return window.api.setPinchZoomEnabled(enabled)
}

const resetZoom = () => applyZoom(1)
const zoomIn = () => applyZoom(clamp(requestedZoom + 0.2))
const zoomOut = () => applyZoom(clamp(requestedZoom - 0.2))

const cancelWheelPinchTimeout = (pinch: WheelPinch) => {
  if (Option.isSome(pinch.timeout)) Effect.runFork(Fiber.interrupt(pinch.timeout.value))
}

const resetWheelPinch = () => {
  if (Option.isSome(wheelPinch)) cancelWheelPinchTimeout(wheelPinch.value)
  wheelPinch = Option.none()
}

const normalizeWheelDelta = (event: WheelEvent) => {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * window.innerHeight
  return event.deltaY
}

const updateWheelPinch = (event: WheelEvent) => {
  const pinch = Option.getOrElse(
    wheelPinch,
    (): WheelPinch => ({
      active: false,
      startZoom: requestedZoom,
      totalDelta: 0,
      timeout: Option.none(),
    }),
  )
  wheelPinch = Option.some(pinch)

  cancelWheelPinchTimeout(pinch)
  pinch.timeout = Option.some(
    Effect.runFork(
      Effect.sleep(WHEEL_PINCH_END_DELAY).pipe(
        Effect.andThen(
          Effect.sync(() => {
            wheelPinch = Option.none()
          }),
        ),
      ),
    ),
  )
  pinch.totalDelta += normalizeWheelDelta(event)

  if (!pinch.active && Math.abs(pinch.totalDelta) < WHEEL_PINCH_THRESHOLD) return
  if (!pinch.active) {
    pinch.active = true
    pinch.startZoom = requestedZoom
    pinch.totalDelta = 0
    return
  }

  pinch.active = true
  applyZoom(clamp(pinch.startZoom - (pinch.totalDelta / WHEEL_PINCH_THRESHOLD) * WHEEL_PINCH_STEP))
}

window.addEventListener(
  "wheel",
  (event) => {
    if (!pinchZoomEnabled) return
    if (!event.ctrlKey) return

    event.preventDefault()
    updateWheelPinch(event)
  },
  { passive: false },
)

window.addEventListener("keydown", (event) => {
  if (!(OS_NAME === "macos" ? event.metaKey : event.ctrlKey)) return

  if (event.key === "-") {
    event.preventDefault()
    zoomOut()
    return
  }
  if (event.key === "=" || event.key === "+") {
    event.preventDefault()
    zoomIn()
    return
  }
  if (event.key === "0") {
    event.preventDefault()
    resetZoom()
  }
})

export { webviewZoom, resetZoom, setPinchZoomEnabled, zoomIn, zoomOut }
