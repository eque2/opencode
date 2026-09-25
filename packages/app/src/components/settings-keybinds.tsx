import { Component, For, Show, createMemo, lazy, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { HashMap, MutableHashMap, Option } from "effect"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { showToast } from "@/utils/toast"
import fuzzysort from "fuzzysort"
import { DEFAULT_PALETTE_KEYBIND, formatKeybind, parseKeybind, useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsList } from "./settings-list"
import { SettingsListV2 } from "./settings-v2/parts/list"

const IconV2 = lazy(() => import("@opencode-ai/ui/v2/icon").then((module) => ({ default: module.Icon })))

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)
const PALETTE_ID = "command.palette"

type KeybindGroup = "General" | "Session" | "Navigation" | "Model and agent" | "Terminal" | "Prompt"

type KeybindMeta = {
  title: string
  group: KeybindGroup
}

type KeybindMap = Record<string, string | undefined>
type KeybindList = MutableHashMap.MutableHashMap<string, KeybindMeta>
type GroupedIds = HashMap.HashMap<KeybindGroup, string[]>
type UsedKeybinds = MutableHashMap.MutableHashMap<string, { id: string; title: string }[]>
type CommandContext = ReturnType<typeof useCommand>
type LanguageContext = ReturnType<typeof useLanguage>
type SettingsContext = ReturnType<typeof useSettings>

const GROUPS: KeybindGroup[] = ["General", "Session", "Navigation", "Model and agent", "Terminal", "Prompt"]

type GroupKey =
  | "settings.shortcuts.group.general"
  | "settings.shortcuts.group.session"
  | "settings.shortcuts.group.navigation"
  | "settings.shortcuts.group.modelAndAgent"
  | "settings.shortcuts.group.terminal"
  | "settings.shortcuts.group.prompt"

const groupKey: Record<KeybindGroup, GroupKey> = {
  General: "settings.shortcuts.group.general",
  Session: "settings.shortcuts.group.session",
  Navigation: "settings.shortcuts.group.navigation",
  "Model and agent": "settings.shortcuts.group.modelAndAgent",
  Terminal: "settings.shortcuts.group.terminal",
  Prompt: "settings.shortcuts.group.prompt",
}

function groupFor(id: string): KeybindGroup {
  if (id === PALETTE_ID) return "General"
  if (id.startsWith("terminal.")) return "Terminal"
  if (id.startsWith("model.") || id.startsWith("agent.") || id.startsWith("mcp.")) return "Model and agent"
  if (id.startsWith("file.") || id.startsWith("fileTree.")) return "Navigation"
  if (id.startsWith("prompt.")) return "Prompt"
  if (
    id.startsWith("session.") ||
    id.startsWith("message.") ||
    id.startsWith("permissions.") ||
    id.startsWith("steps.") ||
    id.startsWith("review.")
  )
    return "Session"

  return "General"
}

function isModifier(key: string) {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta"
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

/** The names whose flag is on, in table order. */
function enabled(flags: ReadonlyArray<readonly [boolean, string]>) {
  return flags.flatMap(([on, name]) => (on ? [name] : []))
}

/** The keybind config for a key press, or none for a lone modifier or an empty key. */
function recordKeybind(event: KeyboardEvent): Option.Option<string> {
  if (isModifier(event.key)) return Option.none()

  const key = normalizeKey(event.key)
  if (!key) return Option.none()

  const modifiers = enabled([
    [IS_MAC ? event.metaKey : event.ctrlKey, "mod"],
    [IS_MAC && event.ctrlKey, "ctrl"],
    [!IS_MAC && event.metaKey, "meta"],
    [event.altKey, "alt"],
    [event.shiftKey, "shift"],
  ])
  return Option.some([...modifiers, key].join("+"))
}

function signatures(config: string | undefined) {
  if (!config) return []

  return parseKeybind(config).flatMap((kb) => {
    const parts = enabled([
      [kb.ctrl, "ctrl"],
      [kb.alt, "alt"],
      [kb.shift, "shift"],
      [kb.meta, "meta"],
      [kb.key !== "", kb.key],
    ])
    return parts.length === 0 ? [] : [parts.join("+")]
  })
}

function keybinds(value: unknown): KeybindMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as KeybindMap
}

function listFor(command: Pick<CommandContext, "catalog" | "options">, map: KeybindMap, palette: string) {
  const out: KeybindList = MutableHashMap.empty()
  MutableHashMap.set(out, PALETTE_ID, { title: palette, group: "General" })

  for (const opt of command.catalog) {
    if (opt.id.startsWith("suggested.")) continue
    if (opt.hidden) continue
    MutableHashMap.set(out, opt.id, { title: opt.title, group: groupFor(opt.id) })
  }

  for (const opt of command.options) {
    if (opt.id.startsWith("suggested.")) continue
    if (opt.hidden) continue
    MutableHashMap.set(out, opt.id, { title: opt.title, group: groupFor(opt.id) })
  }

  for (const [id, value] of Object.entries(map)) {
    if (typeof value !== "string") continue
    if (MutableHashMap.has(out, id)) continue
    MutableHashMap.set(out, id, { title: id, group: groupFor(id) })
  }

  return out
}

function titleIn(list: KeybindList, id: string) {
  return Option.match(MutableHashMap.get(list, id), { onNone: () => "", onSome: (meta) => meta.title })
}

function idsIn(grouped: GroupedIds, group: KeybindGroup) {
  return Option.getOrElse(HashMap.get(grouped, group), () => [])
}

function usedBy(used: UsedKeybinds, signature: string) {
  return Option.getOrElse(MutableHashMap.get(used, signature), () => [])
}

function groupedFor(list: KeybindList): GroupedIds {
  const entries = Array.from(list)
  return HashMap.fromIterable(
    GROUPS.map(
      (group) =>
        [
          group,
          entries
            .filter(([, item]) => item.group === group)
            .map(([id]) => id)
            .sort((a, b) => titleIn(list, a).localeCompare(titleIn(list, b))),
        ] as const,
    ),
  )
}

function filteredFor(
  query: string,
  list: KeybindList,
  grouped: GroupedIds,
  keybind: (id: string) => string,
): GroupedIds {
  const value = query.toLowerCase().trim()
  if (!value) return grouped

  const items = Array.from(list).map(([id, meta]) => ({
    id,
    title: meta.title,
    group: meta.group,
    keybind: keybind(id),
  }))

  const results = fuzzysort.go(value, items, {
    keys: ["title", "keybind"],
    threshold: -10000,
  })

  return HashMap.fromIterable(
    GROUPS.map(
      (group) =>
        [group, results.filter((result) => result.obj.group === group).map((result) => result.obj.id)] as const,
    ),
  )
}

function useKeyCapture(input: {
  active: () => Option.Option<string>
  stop: () => void
  set: (id: string, keybind: string) => void
  used: () => UsedKeybinds
  language: ReturnType<typeof useLanguage>
}) {
  onMount(() => {
    const handle = (event: KeyboardEvent) => {
      const active = input.active()
      if (Option.isNone(active)) return
      const id = active.value

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      if (event.key === "Escape") {
        input.stop()
        return
      }

      const clear =
        (event.key === "Backspace" || event.key === "Delete") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      if (clear) {
        input.set(id, "none")
        input.stop()
        return
      }

      const recorded = recordKeybind(event)
      if (Option.isNone(recorded)) return
      const next = recorded.value

      const conflicts = MutableHashMap.empty<string, string>()
      for (const sig of signatures(next)) {
        for (const item of usedBy(input.used(), sig)) {
          if (item.id === id) continue
          MutableHashMap.set(conflicts, item.id, item.title)
        }
      }

      if (MutableHashMap.size(conflicts) > 0) {
        showToast({
          title: input.language.t("settings.shortcuts.conflict.title"),
          description: input.language.t("settings.shortcuts.conflict.description", {
            keybind: formatKeybind(next, input.language.t),
            titles: Array.from(MutableHashMap.values(conflicts)).join(", "),
          }),
        })
        return
      }

      input.set(id, next)
      input.stop()
    }

    makeEventListener(document, "keydown", handle, { capture: true })
  })
}

export function createKeybindSettingsController(
  input: {
    command: Pick<CommandContext, "catalog" | "options" | "keybinds">
    settings: {
      current: { keybinds: unknown }
      keybinds: Pick<SettingsContext["keybinds"], "get" | "set" | "resetAll">
    }
    target?: Document
    notify?: (toast: { title: string; description: string }) => void
  },
  language: Pick<LanguageContext, "locale" | "t"> = useLanguage(),
) {
  // The id whose keybind is being captured, or none.
  const [store, setStore] = createStore({ active: Option.none<string>() })
  const overrides = createMemo(() => keybinds(input.settings.current.keybinds))
  const list = createMemo(() => {
    language.locale()
    return listFor(input.command, overrides(), language.t("command.palette"))
  })
  const grouped = createMemo(() => groupedFor(list()))
  const title = (id: string) => titleIn(list(), id)
  const effective = (id: string) => {
    if (id === PALETTE_ID) return input.settings.keybinds.get(id) ?? DEFAULT_PALETTE_KEYBIND

    const custom = input.settings.keybinds.get(id)
    if (typeof custom === "string") return custom

    const live = input.command.options.find((item) => item.id === id)
    if (live?.keybind) return live.keybind
    return input.command.catalog.find((item) => item.id === id)?.keybind
  }
  const used = createMemo(() => {
    const value: UsedKeybinds = MutableHashMap.empty()

    for (const id of MutableHashMap.keys(list())) {
      for (const signature of signatures(effective(id))) {
        MutableHashMap.set(value, signature, [...usedBy(value, signature), { id, title: title(id) }])
      }
    }

    return value
  })
  const stop = () => {
    if (Option.isNone(store.active)) return
    setStore("active", Option.none())
    input.command.keybinds(true)
  }
  const toggle = (id: string) => {
    if (Option.contains(store.active, id)) {
      stop()
      return
    }
    if (Option.isSome(store.active)) stop()
    setStore("active", Option.some(id))
    input.command.keybinds(false)
  }
  const notify = input.notify ?? ((toast: { title: string; description: string }) => showToast(toast))

  const handle = (event: KeyboardEvent) => {
    const active = store.active
    if (Option.isNone(active)) return
    const id = active.value

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    if (event.key === "Escape") {
      stop()
      return
    }

    const clear =
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    if (clear) {
      input.settings.keybinds.set(id, "none")
      stop()
      return
    }

    const recorded = recordKeybind(event)
    if (Option.isNone(recorded)) return
    const next = recorded.value

    const conflicts = MutableHashMap.empty<string, string>()
    for (const signature of signatures(next)) {
      for (const item of usedBy(used(), signature)) {
        if (item.id === id) continue
        MutableHashMap.set(conflicts, item.id, item.title)
      }
    }

    if (MutableHashMap.size(conflicts) > 0) {
      notify({
        title: language.t("settings.shortcuts.conflict.title"),
        description: language.t("settings.shortcuts.conflict.description", {
          keybind: formatKeybind(next, language.t),
          titles: Array.from(MutableHashMap.values(conflicts)).join(", "),
        }),
      })
      return
    }

    input.settings.keybinds.set(id, next)
    stop()
  }

  const target = input.target ?? (typeof document === "object" ? document : undefined)
  if (target) makeEventListener(target, "keydown", handle, { capture: true })

  onCleanup(() => {
    if (Option.isSome(store.active)) input.command.keybinds(true)
  })

  return {
    catalog: {
      groups: GROUPS,
      // The matching ids of each group, in GROUPS order. It stays a Map with `get`, because
      // test-browser/settings-keybinds.test.ts reads the result that way.
      filtered: (query: string) => {
        const filtered = filteredFor(query, list(), grouped(), (id) => formatKeybind(effective(id) ?? "", language.t))
        return new Map(GROUPS.map((group) => [group, idsIn(filtered, group)] as const))
      },
      title,
      keybind: (id: string) => formatKeybind(effective(id) ?? "", language.t),
    },
    capture: {
      // The exported contract (and test-browser/settings-keybinds.test.ts) reads null for no capture.
      active: () => Option.getOrNull(store.active),
      toggle,
    },
    settings: {
      hasOverrides: () => Object.values(overrides()).some((value) => typeof value === "string"),
      reset: () => {
        stop()
        input.settings.keybinds.resetAll()
        notify({
          title: language.t("settings.shortcuts.reset.toast.title"),
          description: language.t("settings.shortcuts.reset.toast.description"),
        })
      },
    },
  }
}

function SettingsKeybindsV2() {
  const command = useCommand()
  const settings = useSettings()
  const controller = createKeybindSettingsController({
    command,
    settings,
  })

  return (
    <SettingsKeybindsV2View
      groups={controller.catalog.groups}
      filtered={controller.catalog.filtered}
      title={controller.catalog.title}
      keybind={controller.catalog.keybind}
      active={controller.capture.active}
      onCapture={controller.capture.toggle}
      hasOverrides={controller.settings.hasOverrides}
      onReset={controller.settings.reset}
    />
  )
}

function SettingsKeybindsV2View(props: {
  groups: KeybindGroup[]
  filtered: (query: string) => Map<KeybindGroup, string[]>
  title: (id: string) => string
  keybind: (id: string) => string
  active: () => string | null
  onCapture: (id: string) => void
  hasOverrides: () => boolean
  onReset: () => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({ filter: "" })
  const filtered = createMemo(() => props.filtered(store.filter))
  const hasResults = createMemo(() => props.groups.some((group) => (filtered().get(group)?.length ?? 0) > 0))

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.shortcuts.title")}</h2>
          <ButtonV2 variant="ghost" onClick={props.onReset} disabled={!props.hasOverrides()}>
            {language.t("settings.shortcuts.reset.button")}
          </ButtonV2>
        </div>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={store.filter}
            onInput={(event) => setStore("filter", event.currentTarget.value)}
            placeholder={language.t("settings.shortcuts.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("settings.shortcuts.search.placeholder")}
          />
          <Show when={store.filter}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => setStore("filter", "")}
            />
          </Show>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-shortcuts flex flex-col gap-8">
          <For each={props.groups}>
            {(group) => (
              <Show when={(filtered().get(group) ?? []).length > 0}>
                <div class="settings-v2-section">
                  <h3 class="settings-v2-section-title">{language.t(groupKey[group])}</h3>
                  <SettingsListV2>
                    <For each={filtered().get(group) ?? []}>
                      {(id) => (
                        <div class="flex items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                          <span>{props.title(id)}</span>
                          <button
                            type="button"
                            data-keybind-id={id}
                            classList={{
                              "settings-v2-keybind-button": true,
                              "settings-v2-keybind-button--active": props.active() === id,
                            }}
                            onClick={() => props.onCapture(id)}
                          >
                            <Show
                              when={props.active() === id}
                              fallback={props.keybind(id) || language.t("settings.shortcuts.unassigned")}
                            >
                              {language.t("settings.shortcuts.pressKeys")}
                            </Show>
                          </button>
                        </div>
                      )}
                    </For>
                  </SettingsListV2>
                </div>
              </Show>
            )}
          </For>
          <Show when={store.filter && !hasResults()}>
            <div class="settings-v2-shortcuts-status">
              <span>{language.t("settings.shortcuts.search.empty")}</span>
              <span class="settings-v2-shortcuts-status-filter">&quot;{store.filter}&quot;</span>
            </div>
          </Show>
        </div>
      </div>
    </>
  )
}

export const SettingsKeybinds: Component<{ v2?: boolean }> = (props) => {
  if (props.v2) return <SettingsKeybindsV2 />

  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()

  const [store, setStore] = createStore({
    active: Option.none<string>(),
    filter: "",
  })

  const stop = () => {
    if (Option.isNone(store.active)) return
    setStore("active", Option.none())
    command.keybinds(true)
  }

  const start = (id: string) => {
    if (Option.contains(store.active, id)) {
      stop()
      return
    }

    if (Option.isSome(store.active)) stop()

    setStore("active", Option.some(id))
    command.keybinds(false)
  }

  const map = createMemo(() => keybinds(settings.current.keybinds))

  const hasOverrides = createMemo(() => Object.values(map()).some((x) => typeof x === "string"))

  const resetAll = () => {
    stop()
    settings.keybinds.resetAll()
    showToast({
      title: language.t("settings.shortcuts.reset.toast.title"),
      description: language.t("settings.shortcuts.reset.toast.description"),
    })
  }

  const list = createMemo(() => {
    language.locale()
    return listFor(command, map(), language.t("command.palette"))
  })

  const title = (id: string) => titleIn(list(), id)

  const grouped = createMemo(() => groupedFor(list()))

  const filtered = createMemo(() => {
    return filteredFor(store.filter, list(), grouped(), (id) => command.keybind(id) || "")
  })

  const hasResults = createMemo(() => {
    for (const group of GROUPS) {
      const ids = idsIn(filtered(), group)
      if (ids.length > 0) return true
    }
    return false
  })

  const used = createMemo(() => {
    const map: UsedKeybinds = MutableHashMap.empty()

    const add = (key: string, value: { id: string; title: string }) => {
      MutableHashMap.set(map, key, [...usedBy(map, key), value])
    }

    const palette = settings.keybinds.get(PALETTE_ID) ?? DEFAULT_PALETTE_KEYBIND
    for (const sig of signatures(palette)) {
      add(sig, { id: PALETTE_ID, title: title(PALETTE_ID) })
    }

    const valueFor = (id: string) => {
      const custom = settings.keybinds.get(id)
      if (typeof custom === "string") return custom

      const live = command.options.find((x) => x.id === id)
      if (live?.keybind) return live.keybind

      const meta = command.catalog.find((x) => x.id === id)
      return meta?.keybind
    }

    for (const id of MutableHashMap.keys(list())) {
      if (id === PALETTE_ID) continue
      for (const sig of signatures(valueFor(id))) {
        add(sig, { id, title: title(id) })
      }
    }

    return map
  })

  const setKeybind = (id: string, keybind: string) => settings.keybinds.set(id, keybind)

  useKeyCapture({
    active: () => store.active,
    stop,
    set: setKeybind,
    used,
    language,
  })

  onCleanup(() => {
    if (Option.isSome(store.active)) command.keybinds(true)
  })

  const emptyResults = (
    <Show when={store.filter && !hasResults()}>
      <div
        classList={{
          "flex flex-col items-center justify-center py-12 text-center": !props.v2,
          "settings-v2-shortcuts-status": props.v2,
        }}
      >
        <span
          classList={{
            "text-14-regular text-text-weak": !props.v2,
          }}
        >
          {language.t("settings.shortcuts.search.empty")}
        </span>
        <Show when={store.filter}>
          <span
            classList={{
              "text-14-regular text-text-strong mt-1": !props.v2,
              "settings-v2-shortcuts-status-filter": props.v2,
            }}
          >
            &quot;{store.filter}&quot;
          </span>
        </Show>
      </div>
    </Show>
  )

  const List = props.v2 ? SettingsListV2 : SettingsList

  const groups = (
    <div
      classList={{
        "settings-v2-shortcuts flex flex-col gap-8": props.v2,
        "flex flex-col gap-8 max-w-[720px]": !props.v2,
      }}
    >
      <For each={GROUPS}>
        {(group) => (
          <Show when={idsIn(filtered(), group).length > 0}>
            <div
              classList={{
                "settings-v2-section": props.v2,
                "flex flex-col gap-1": !props.v2,
              }}
            >
              <h3
                classList={{
                  "settings-v2-section-title": props.v2,
                  "text-14-medium text-text-strong pb-2": !props.v2,
                }}
              >
                {language.t(groupKey[group])}
              </h3>
              <List>
                <For each={idsIn(filtered(), group)}>
                  {(id) => (
                    <div class="flex items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                      <span
                        classList={{
                          "text-14-regular text-text-strong": !props.v2,
                        }}
                      >
                        {title(id)}
                      </span>
                      <button
                        type="button"
                        data-keybind-id={id}
                        classList={{
                          "settings-v2-keybind-button": props.v2,
                          "settings-v2-keybind-button--active": props.v2 && Option.contains(store.active, id),
                          "h-8 px-3 rounded-md text-12-regular": !props.v2,
                          "bg-surface-base text-text-subtle hover:bg-surface-raised-base-hover active:bg-surface-raised-base-active":
                            !props.v2 && !Option.contains(store.active, id),
                          "border border-border-weak-base bg-surface-inset-base text-text-weak":
                            !props.v2 && Option.contains(store.active, id),
                        }}
                        onClick={() => start(id)}
                      >
                        <Show
                          when={Option.contains(store.active, id)}
                          fallback={command.keybind(id) || language.t("settings.shortcuts.unassigned")}
                        >
                          {language.t("settings.shortcuts.pressKeys")}
                        </Show>
                      </button>
                    </div>
                  )}
                </For>
              </List>
            </div>
          </Show>
        )}
      </For>
      {emptyResults}
    </div>
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex items-center justify-between gap-4">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.shortcuts.title")}</h2>
            <Button size="small" variant="secondary" onClick={resetAll} disabled={!hasOverrides()}>
              {language.t("settings.shortcuts.reset.button")}
            </Button>
          </div>

          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={store.filter}
              onChange={(v) => setStore("filter", v)}
              placeholder={language.t("settings.shortcuts.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={store.filter}>
              <IconButton icon="circle-x" variant="ghost" onClick={() => setStore("filter", "")} />
            </Show>
          </div>
        </div>
      </div>
      {groups}
    </div>
  )
}
