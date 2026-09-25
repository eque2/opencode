import { Option } from "effect"
import { createMemo } from "solid-js"
import { useKV } from "./kv"

export type ThinkingMode = "show" | "hide"

const MODES: readonly ThinkingMode[] = ["show", "hide"] as const

// OpenAI's Responses API surfaces reasoning summaries that start with a bolded
// title block: "**Inspecting PR workflow**\n\n<body>". Treat that first block,
// or a complete title still awaiting its body while streaming, as disclosure
// metadata so the TUI can style its header independently from the markdown body.
export function reasoningSummary(text: string) {
  const content = text.trim()
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (!match) return { title: Option.none<string>(), body: content }
  return { title: Option.some(match[1].trim()), body: content.slice(match[0].length).trimEnd() }
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

// Cycle order matches the slash command: show → hide → show.
export function nextThinkingMode(current: ThinkingMode): ThinkingMode {
  const idx = MODES.indexOf(current)
  return MODES[(idx + 1) % MODES.length] ?? "show"
}

export function useThinkingMode() {
  const kv = useKV()
  // Capture pre-state before `kv.signal` seeds a default, so we can detect
  // first-time users with a legacy `thinking_visibility` boolean and migrate.
  // The KVProvider only renders children once kv.ready, so reads here are safe.
  const hadStored = kv.get("thinking_mode") !== undefined
  const legacy = kv.get("thinking_visibility")
  const [stored, setStored] = kv.signal<ThinkingMode>("thinking_mode", "hide")

  const mode = createMemo<ThinkingMode>(() => {
    const value = stored()
    return isThinkingMode(value) ? value : "hide"
  })

  // The kv signal exposes its setter typed as `Setter<T>` which carries Solid's
  // overload set, so an updater function does not type as its argument.
  // Resolve an updater against the current mode here, and hand the kv setter
  // a function that returns the next value, so consumers can call `set(next)`
  // or pass an updater.
  const set = (next: ThinkingMode | ((prev: ThinkingMode) => ThinkingMode)) => {
    const value = typeof next === "function" ? next(mode()) : next
    setStored(() => value)
  }

  // Preserve previous experience for users who had explicitly toggled the
  // legacy `thinking_visibility` boolean. First-time users (no legacy key)
  // get the new "hide" default (collapsed thinking).
  if (!hadStored) {
    if (legacy === true) set("show")
    else if (legacy === false) set("hide")
  }

  // The kv store is untyped, so a value from an older version, such as "minimal", can still be stored.
  const storedValue: unknown = stored()
  if (storedValue === "minimal") set("hide")

  return {
    mode,
    set,
  }
}
