import { dlopen, ptr } from "bun:ffi"
import { Option, Result } from "effect"
import type { ReadStream } from "node:tty"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
  })

let library: Option.Option<ReturnType<typeof kernel>> = Option.none()

// A failed dlopen is not cached, so the next call tries again.
function load() {
  if (process.platform !== "win32") return Option.none()
  if (Option.isNone(library)) library = Result.getSuccess(Result.try(kernel))
  return Option.map(library, (loaded) => loaded.symbols)
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  const k32 = load()
  if (Option.isNone(k32)) return

  const handle = k32.value.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32.value.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0]
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32.value.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  const k32 = load()
  if (Option.isNone(k32)) return

  const handle = k32.value.GetStdHandle(STD_INPUT_HANDLE)
  k32.value.FlushConsoleInputBuffer(handle)
}

let unhook: (() => void) | undefined

/**
 * Keep ENABLE_PROCESSED_INPUT disabled.
 *
 * On Windows, Ctrl+C becomes a CTRL_C_EVENT (instead of stdin input) when
 * ENABLE_PROCESSED_INPUT is set. Various runtimes can re-apply console modes
 * (sometimes on a later tick), and the flag is console-global, not per-process.
 *
 * We combine:
 * - A `setRawMode(...)` hook to re-clear after known raw-mode toggles.
 * - A low-frequency poll as a backstop for native/external mode changes.
 */
export function win32InstallCtrlCGuard(): (() => void) | undefined {
  if (process.platform !== "win32") return undefined
  if (!process.stdin.isTTY) return undefined
  const loaded = load()
  if (Option.isNone(loaded)) return undefined
  if (unhook) return unhook

  const k32 = loaded.value
  const stdin = process.stdin as ReadStream

  const handle = k32.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  if (k32.GetConsoleMode(handle, ptr(buf)) === 0) return undefined
  const initial = buf[0]

  const enforce = () => {
    if (k32.GetConsoleMode(handle, ptr(buf)) === 0) return
    const mode = buf[0]
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    k32.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  const restoreRawMode = typeof stdin.setRawMode === "function" ? hookRawMode(stdin, later) : () => {}

  // Ensure it's cleared immediately too (covers any earlier mode changes).
  later()

  const interval = setInterval(enforce, 100)
  interval.unref()

  let done = false
  unhook = () => {
    if (done) return
    done = true

    clearInterval(interval)
    restoreRawMode()

    k32.SetConsoleMode(handle, initial)
    unhook = undefined
  }

  return unhook
}

/**
 * Wrap `stdin.setRawMode` so each raw-mode toggle runs `after`.
 *
 * Returns a function that puts the original method back, unless other code
 * replaced the wrapper in the meantime.
 */
function hookRawMode(stdin: ReadStream, after: () => void) {
  // Bound, so the saved method keeps stdin as `this` when the wrapper calls it.
  const original = stdin.setRawMode.bind(stdin)
  const wrapped = (mode: boolean) => {
    const result = original(mode)
    after()
    return result
  }
  stdin.setRawMode = wrapped
  return () => {
    if (stdin.setRawMode === wrapped) stdin.setRawMode = original
  }
}
