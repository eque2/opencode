import type { BrowserWindow } from "electron"
import { Data, Effect, Fiber, MutableHashMap, Option } from "effect"
import { write as writeLog, writeMessage } from "./logging"
import { safeWindowURL } from "./window-state"

const sampleInterval = "1 second"
const samplePeriod = "15 seconds"

class SampleError extends Data.TaggedError("SampleError")<{ readonly cause: unknown }> {}

export function createUnresponsiveSampler(win: BrowserWindow, name: string) {
  let sampler = Option.none<Fiber.Fiber<void>>()
  const samples = MutableHashMap.empty<string, number>()

  const active = () => Option.isSome(sampler) && !win.isDestroyed() && !win.webContents.isDestroyed()

  // Returns false once the window is gone, which ends the sampling loop.
  const collect = Effect.gen(function* () {
    yield* Effect.sleep(sampleInterval)
    if (!active()) return false
    const stack = yield* Effect.tryPromise({
      try: () => win.webContents.mainFrame.collectJavaScriptCallStack(),
      catch: (cause) => new SampleError({ cause }),
    }).pipe(
      Effect.map((value) => Option.some(value).pipe(Option.filter((text) => text.length > 0))),
      Effect.catch((error) =>
        Effect.sync(() => {
          writeLog("window", "failed to collect unresponsive sample", { window: name, error: error.cause }, "error")
          return Option.none<string>()
        }),
      ),
    )
    if (!active()) return false
    if (Option.isSome(stack))
      MutableHashMap.set(
        samples,
        stack.value,
        Option.getOrElse(MutableHashMap.get(samples, stack.value), () => 0) + 1,
      )
    return true
  })

  const flush = () => {
    if (MutableHashMap.size(samples) === 0) return
    const entries = Array.from(samples).sort((a, b) => b[1] - a[1])
    const total = entries.reduce((sum, entry) => sum + entry[1], 0)
    const message = [
      "renderer unresponsive samples",
      `Window: ${name}`,
      `URL: ${safeWindowURL(win)}`,
      ...entries.map((entry) => `<${entry[1]}> ${entry[0]}`),
      `Total Samples: ${total}`,
    ].join("\n")
    writeMessage("window", message, "error")
    MutableHashMap.clear(samples)
  }

  const stopAndFlush = () => {
    const wasSampling = Option.isSome(sampler)
    if (Option.isSome(sampler)) Effect.runFork(Fiber.interrupt(sampler.value))
    sampler = Option.none()
    flush()
    return wasSampling
  }

  // The sampling loop runs as a child fiber, so it ends with the period.
  const sample = Effect.gen(function* () {
    yield* Effect.forkChild(collect.pipe(Effect.repeat({ while: (more) => more })))
    yield* Effect.sleep(samplePeriod)
    yield* Effect.sync(() => {
      sampler = Option.none()
      flush()
    })
  })

  const start = () => {
    if (Option.isSome(sampler) || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isDevToolsOpened())
      return
    MutableHashMap.clear(samples)
    sampler = Option.some(Effect.runFork(sample))
  }

  win.on("closed", stopAndFlush)

  return { start, stopAndFlush }
}
