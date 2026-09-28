import { createSimpleContext } from "@opencode-ai/ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Accessor, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Effect, HashSet, MutableHashMap, MutableHashSet, Option } from "effect"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { dict as en } from "@/i18n/en"
import { Persist, persisted } from "@/utils/persist"

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

const PALETTE_ID = "command.palette"
export const DEFAULT_PALETTE_KEYBIND = "mod+k,mod+shift+p"
const SUGGESTED_PREFIX = "suggested."
const EDITABLE_KEYBIND_IDS = HashSet.make("terminal.toggle", "terminal.new", "file.attach")

type KeyLabel =
  | "common.key.ctrl"
  | "common.key.alt"
  | "common.key.shift"
  | "common.key.meta"
  | "common.key.space"
  | "common.key.backspace"
  | "common.key.enter"
  | "common.key.tab"
  | "common.key.delete"
  | "common.key.home"
  | "common.key.end"
  | "common.key.pageUp"
  | "common.key.pageDown"
  | "common.key.insert"
  | "common.key.esc"

function keyText(key: KeyLabel, t?: (key: KeyLabel) => string) {
  return t ? t(key) : en[key]
}

function actionId(id: string) {
  if (!id.startsWith(SUGGESTED_PREFIX)) return id
  return id.slice(SUGGESTED_PREFIX.length)
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

function signature(key: string, ctrl: boolean, meta: boolean, shift: boolean, alt: boolean) {
  const mask = (ctrl ? 1 : 0) | (meta ? 2 : 0) | (shift ? 4 : 0) | (alt ? 8 : 0)
  return `${key}:${mask}`
}

function signatureFromEvent(event: KeyboardEvent) {
  return signature(normalizeKey(event.key), event.ctrlKey, event.metaKey, event.shiftKey, event.altKey)
}

function isAllowedEditableKeybind(id: string | undefined) {
  if (!id) return false
  return HashSet.has(EDITABLE_KEYBIND_IDS, actionId(id))
}

export type KeybindConfig = string

export interface Keybind {
  key: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

export interface CommandOption {
  id: string
  title: string
  description?: string
  category?: string
  keybind?: KeybindConfig
  slash?: string
  suggested?: boolean
  disabled?: boolean
  hidden?: boolean
  when?: (event: KeyboardEvent) => boolean
  onSelect?: (source?: "palette" | "keybind" | "slash") => void
  onHighlight?: () => (() => void) | void
}

export function commandPaletteOptions(options: CommandOption[]) {
  return options.filter(
    (option) =>
      !option.disabled && !option.hidden && !option.id.startsWith(SUGGESTED_PREFIX) && option.id !== "file.open",
  )
}

export function resolveKeybindOption(candidates: CommandOption[] | undefined, event: KeyboardEvent) {
  return candidates?.find((option) => option.when?.(event)) ?? candidates?.find((option) => !option.when)
}

type CommandSource = "palette" | "keybind" | "slash"

export type CommandCatalogItem = {
  title: string
  description?: string
  category?: string
  keybind?: KeybindConfig
  slash?: string
  hidden?: boolean
}

export type CommandRegistration = {
  key?: string
  options: Accessor<CommandOption[]>
}

export function addCommandRegistration(registrations: CommandRegistration[], entry: CommandRegistration) {
  return [entry, ...registrations]
}

export function activeCommandRegistrations(registrations: CommandRegistration[]) {
  const keys = MutableHashSet.empty<string>()
  return registrations.filter((entry) => {
    if (entry.key === undefined) return true
    if (MutableHashSet.has(keys, entry.key)) return false
    MutableHashSet.add(keys, entry.key)
    return true
  })
}

export function parseKeybind(config: string): Keybind[] {
  if (!config || config === "none") return []

  return config.split(",").map((combo) => {
    const parts = combo.trim().toLowerCase().split("+")
    const keybind: Keybind = {
      key: "",
      ctrl: false,
      meta: false,
      shift: false,
      alt: false,
    }

    for (const part of parts) {
      switch (part) {
        case "ctrl":
        case "control":
          keybind.ctrl = true
          break
        case "meta":
        case "cmd":
        case "command":
          keybind.meta = true
          break
        case "mod":
          if (IS_MAC) keybind.meta = true
          else keybind.ctrl = true
          break
        case "alt":
        case "option":
          keybind.alt = true
          break
        case "shift":
          keybind.shift = true
          break
        default:
          keybind.key = part
          break
      }
    }

    return keybind
  })
}

export function matchKeybind(keybinds: Keybind[], event: KeyboardEvent): boolean {
  const eventKey = normalizeKey(event.key)

  for (const kb of keybinds) {
    const keyMatch = kb.key === eventKey
    const ctrlMatch = kb.ctrl === (event.ctrlKey || false)
    const metaMatch = kb.meta === (event.metaKey || false)
    const shiftMatch = kb.shift === (event.shiftKey || false)
    const altMatch = kb.alt === (event.altKey || false)

    if (keyMatch && ctrlMatch && metaMatch && shiftMatch && altMatch) {
      return true
    }
  }

  return false
}

function displayKeybindParts(kb: Keybind, t?: (key: KeyLabel) => string) {
  const modifiers = [
    { on: kb.ctrl, mac: "⌃", label: "common.key.ctrl" },
    { on: kb.alt, mac: "⌥", label: "common.key.alt" },
    { on: kb.shift, mac: "⇧", label: "common.key.shift" },
    { on: kb.meta, mac: "⌘", label: "common.key.meta" },
  ] satisfies { on: boolean; mac: string; label: KeyLabel }[]
  const parts = modifiers.flatMap((modifier) =>
    modifier.on ? [IS_MAC ? modifier.mac : keyText(modifier.label, t)] : [],
  )

  if (!kb.key) return parts

  const keys: Record<string, string> = {
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    comma: ",",
    plus: "+",
  }
  const named: Record<string, KeyLabel> = {
    backspace: "common.key.backspace",
    delete: "common.key.delete",
    end: "common.key.end",
    enter: "common.key.enter",
    esc: "common.key.esc",
    escape: "common.key.esc",
    home: "common.key.home",
    insert: "common.key.insert",
    pagedown: "common.key.pageDown",
    pageup: "common.key.pageUp",
    space: "common.key.space",
    tab: "common.key.tab",
  }
  const key = kb.key.toLowerCase()
  const displayKey =
    keys[key] ??
    (named[key]
      ? keyText(named[key], t)
      : key.length === 1
        ? key.toUpperCase()
        : key.charAt(0).toUpperCase() + key.slice(1))

  return [...parts, displayKey]
}

export function formatKeybindParts(config: string, t?: (key: KeyLabel) => string): string[] {
  if (!config || config === "none") return []
  const keybind = parseKeybind(config)[0]
  return keybind ? displayKeybindParts(keybind, t) : []
}

export function formatKeybind(config: string, t?: (key: KeyLabel) => string): string {
  const parts = formatKeybindParts(config, t)
  if (parts.length === 0) return ""
  return IS_MAC ? parts.join("") : parts.join("+")
}

// KeybindV2 takes an array instead of a string
export function formatKeybindKeys(config: string, t?: (key: KeyLabel) => string): string[] {
  return formatKeybindParts(config, t)
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest("[contenteditable='true']")) return true
  if (target.closest("input, textarea, select")) return true
  return false
}

export const { use: useCommand, provider: CommandProvider } = createSimpleContext({
  name: "Command",
  init: () => {
    const dialog = useDialog()
    const settings = useSettings()
    const language = useLanguage()
    const [store, setStore] = createStore({
      registrations: [] as CommandRegistration[],
      suspendCount: 0,
    })
    const warnedDuplicates = MutableHashSet.empty<string>()

    type CommandCatalog = Record<string, CommandCatalogItem>
    const [catalog, setCatalog, _, catalogReady] = persisted(
      Persist.global("command.catalog.v1"),
      createStore<CommandCatalog>({}),
    )

    const bind = (id: string, def: KeybindConfig | undefined) => {
      const custom = settings.keybinds.get(actionId(id))
      const config = custom ?? def
      if (!config || config === "none") return undefined
      return config
    }

    const registered = createMemo(() => {
      const seen = MutableHashSet.empty<string>()
      const all: CommandOption[] = []

      for (const reg of activeCommandRegistrations(store.registrations)) {
        for (const opt of reg.options()) {
          if (MutableHashSet.has(seen, opt.id)) {
            if (import.meta.env.DEV && !MutableHashSet.has(warnedDuplicates, opt.id)) {
              MutableHashSet.add(warnedDuplicates, opt.id)
              Effect.runFork(
                Effect.logWarning(`[command] duplicate command id "${opt.id}" registered; keeping first entry`),
              )
            }
            continue
          }
          MutableHashSet.add(seen, opt.id)
          all.push(opt)
        }
      }

      return all
    })

    createEffect(() => {
      if (!catalogReady()) return

      setCatalog(
        registered().reduce((acc, opt) => {
          const id = actionId(opt.id)
          if (opt.title)
            acc[id] = {
              title: opt.title,
              description: opt.description,
              category: opt.category,
              keybind: opt.keybind,
              slash: opt.slash,
            }
          return acc
        }, {} as CommandCatalog),
      )
    })

    const catalogOptions = createMemo(() => Object.entries(catalog).map(([id, meta]) => ({ id, ...meta })))

    const options = createMemo(() => {
      const resolved = registered().map((opt) => ({
        ...opt,
        keybind: bind(opt.id, opt.keybind),
      }))

      const suggested = resolved.filter((x) => x.suggested && !x.disabled)

      return [
        ...suggested.map((x) => ({
          ...x,
          id: SUGGESTED_PREFIX + x.id,
          category: language.t("command.category.suggested"),
        })),
        ...resolved,
      ]
    })

    const suspended = () => store.suspendCount > 0

    const palette = createMemo(() => {
      const config = settings.keybinds.get(PALETTE_ID) ?? DEFAULT_PALETTE_KEYBIND
      const keybinds = parseKeybind(config)
      return HashSet.fromIterable(keybinds.map((kb) => signature(kb.key, kb.ctrl, kb.meta, kb.shift, kb.alt)))
    })

    const keymap = createMemo(() => {
      const map = MutableHashMap.empty<string, CommandOption[]>()
      for (const option of options()) {
        if (option.id.startsWith(SUGGESTED_PREFIX)) continue
        if (option.disabled) continue
        if (!option.keybind) continue

        const keybinds = parseKeybind(option.keybind)
        for (const kb of keybinds) {
          if (!kb.key) continue
          const sig = signature(kb.key, kb.ctrl, kb.meta, kb.shift, kb.alt)
          const existing = MutableHashMap.get(map, sig)
          MutableHashMap.set(map, sig, Option.isSome(existing) ? [...existing.value, option] : [option])
        }
      }
      return map
    })

    const optionMap = createMemo(() => {
      const map = MutableHashMap.empty<string, CommandOption>()
      for (const option of options()) {
        MutableHashMap.set(map, option.id, option)
        MutableHashMap.set(map, actionId(option.id), option)
      }
      return map
    })

    const run = (id: string, source?: CommandSource) => {
      const option = MutableHashMap.get(optionMap(), id)
      if (Option.isSome(option)) option.value.onSelect?.(source)
    }

    const showPalette = () => {
      run(PALETTE_ID, "palette")
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (suspended() || dialog.active) return

      const sig = signatureFromEvent(event)
      const isPalette = HashSet.has(palette(), sig)
      const option = resolveKeybindOption(
        Option.getOrElse(MutableHashMap.get(keymap(), sig), () => []),
        event,
      )
      const modified = event.ctrlKey || event.metaKey || event.altKey
      const isTab = event.key === "Tab"

      if (isEditableTarget(event.target) && !isPalette && !isAllowedEditableKeybind(option?.id) && !modified && !isTab)
        return

      if (isPalette) {
        event.preventDefault()
        event.stopPropagation()
        showPalette()
        return
      }

      if (!option) return
      event.preventDefault()
      event.stopPropagation()
      option.onSelect?.("keybind")
    }

    onMount(() => {
      makeEventListener(document, "keydown", handleKeyDown, { capture: true })
    })

    function register(cb: () => CommandOption[]): void
    function register(key: string, cb: () => CommandOption[]): void
    function register(key: string | (() => CommandOption[]), cb?: () => CommandOption[]) {
      const next = typeof key === "function" ? key : cb
      if (!next) return
      const options = createMemo(next)
      // An unkeyed registration leaves out `key`, so activeCommandRegistrations never dedupes it.
      const entry: CommandRegistration = {
        ...(typeof key === "string" ? { key } : {}),
        options,
      }
      setStore("registrations", (arr) => addCommandRegistration(arr, entry))
      onCleanup(() => {
        setStore("registrations", (arr) => arr.filter((x) => x !== entry))
      })
    }

    const keybindConfig = (id: string) => {
      if (id === PALETTE_ID) return settings.keybinds.get(PALETTE_ID) ?? DEFAULT_PALETTE_KEYBIND
      const base = actionId(id)
      return options().find((x) => actionId(x.id) === base)?.keybind ?? bind(base, catalog[base]?.keybind)
    }

    return {
      register,
      trigger(id: string, source?: CommandSource) {
        run(id, source)
      },
      keybind(id: string) {
        const config = keybindConfig(id)
        if (!config) return ""
        return formatKeybind(config, language.t)
      },
      keybindParts(id: string) {
        const config = keybindConfig(id)
        return config ? formatKeybindParts(config, language.t) : []
      },
      show: showPalette,
      keybinds(enabled: boolean) {
        setStore("suspendCount", (count) => Math.max(0, count + (enabled ? -1 : 1)))
      },
      suspended,
      get catalog() {
        return catalogOptions()
      },
      get options() {
        return options()
      },
    }
  },
})
