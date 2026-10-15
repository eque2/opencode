// Pieces several designs share: the HARNESS brand, a task line, the shortcut bar, and the context each design gets.
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { RGBA } from "@opentui/core"
import { Option } from "effect"
import { For, Show, createEffect, on, onCleanup, type Accessor } from "solid-js"
import type { Harness, Sessions } from "./peek"
import {
  DESIGNS,
  MARK,
  NAME,
  OLDER_LINE,
  counts,
  cut,
  glyph,
  label,
  older,
  stateColor,
  tagged,
  type ProofLog,
  type Row,
  type Status,
} from "./store"
import { outsideCollapsed, outsideWaits, warningOf, wrap } from "./shared"
import { registerOpencodeSpinner } from "../component/register-spinner"
import type { View } from "./view"

registerOpencodeSpinner()

/** What a design gets: the host API, the shared view state, the peek's session source, and whether it is selected. */
export type Ctx = {
  readonly api: TuiPluginApi
  readonly view: View
  readonly sessions: Sessions
  readonly theme: Accessor<TuiThemeCurrent>
  readonly active: Accessor<boolean>
  /** How the leader key reads in this keymap, for the key hints (`ctrl+x`). */
  readonly leader: string
  /** The root session on screen, or "" before the developer opens one. */
  readonly root: Accessor<string>
  /**
   * The root session owns harness sessions (`T1.4 builder`): the run on screen is its run. In any other session the
   * watch view, Tab and `esc` leave it alone.
   */
  readonly owns: Accessor<boolean>
  /** Every harness session of the root, from the shared session list, so a task revisited with Tab shows at once. */
  readonly harness: Accessor<ReadonlyArray<Harness>>
  /** The proof logs in `.opencode/task/proofs/`, with when each was last written. */
  readonly logs: Accessor<ReadonlyArray<ProofLog>>
  /** The host's `animations_enabled` setting: the In the Flow mark moves only with it (D23). */
  readonly motion?: Accessor<boolean>
}

/** What the view components need; tests build it from a fixture. */
export type ViewProps = {
  readonly theme: Accessor<TuiThemeCurrent>
  readonly view: View
  readonly sessions: Sessions
  readonly leader: string
  /** The host's `animations_enabled` setting; without it the mark stays still. */
  readonly motion?: Accessor<boolean>
}

/** The diamond's frames (EXPERIENCE "In the Flow mark"): each one cell wide, so the name never moves. */
const FRAMES = ["·", "⬩", "⬪", "⬥", "◆", "⬥", "⬪", "⬩"]

/** Whether a design's mark moves: the view is live and the host allows animations (D23, owner ruling 5). */
export const moving = (props: ViewProps) => props.view.liveness() === "live" && (props.motion?.() ?? false)

/**
 * The In the Flow mark, a row: the diamond (the spinner element while `moving`, else a static ◆; never bold, as the
 * spinner cannot draw bold), then " In the Flow" in bold accent. The element runs its own frames: no task-ui timer.
 */
export function Brand(props: { theme: Accessor<TuiThemeCurrent>; moving: boolean }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <Show
        when={props.moving}
        fallback={
          <text fg={props.theme().accent} wrapMode="none">
            ◆
          </text>
        }
      >
        <spinner frames={FRAMES} interval={120} color={props.theme().accent} />
      </Show>
      <text fg={props.theme().accent} wrapMode="none">
        <b>{` ${NAME}`}</b>
      </text>
    </box>
  )
}

/** `run: budget exhausted`. */
export const runText = (status: Status) => `run: ${label(status.run.state)}`

/** `3/6 trusted`. */
export const trustedText = (status: Status) => {
  const count = counts(status)
  return `${count.trusted}/${count.total} trusted`
}

/** ` · 2 stopped` after a trusted count, in the error tone; nothing at 0 (EXPERIENCE "Stopped count"). */
export const stoppedText = (status: Status) => {
  const stopped = counts(status).stopped
  return stopped > 0 ? ` · ${stopped} stopped` : ""
}

/**
 * A refused run (UI17): it stopped with no task at all, as a spec that does not load has none. The tags give a refusal
 * no tag of its own (AD-13), and the task-ui classifies no state by name (AD-16).
 */
export const refused = (status: Status) => tagged(status.run, "stopped") && Object.keys(status.tasks).length === 0

/** The run's title (UI6); the spec id when the spec has none. */
export const runTitle = (status: Status) =>
  status.run.title || status.run.specId || (status.run.spec.split("/").filter(Boolean).at(-1) ?? status.run.spec)

/**
 * The run reason line (EXPERIENCE "Component Patterns"): the first `run.reason` line, then " (+N more)"; in the error
 * tone when the run has the `stopped` tag, else muted, as a done run's "not run" line (AD-16, UI19).
 */
export const reasonLine = (status: Status) => {
  const lines = (status.run.reason ?? "").split("\n").filter(Boolean)
  if (lines.length === 0) return Option.none<{ text: string; tone: "error" | "muted" }>()
  return Option.some({
    text: `${lines[0]}${lines.length > 1 ? ` (+${lines.length - 1} more)` : ""}`,
    tone: tagged(status.run, "stopped") ? ("error" as const) : ("muted" as const),
  })
}

/** The warning toast's message when the run warning appears between two statuses (UI16); none otherwise. */
export const warningToast = (before: Status | undefined, after: Status | undefined) => {
  const count = after?.run.warning ? after.run.warning.split("\n").length : 0
  if (count === 0 || before?.run.warning) return Option.none<string>()
  return Option.some(
    `The spec no longer validates (${count} ${count === 1 ? "failure" : "failures"}). The run keeps the plan it loaded.`,
  )
}

/** In every design, a warning toast each time the run warning appears in the status the view follows (UI16). */
export function registerWarning(ctx: {
  readonly view: View
  readonly toast: (toast: { variant: "warning"; title: string; message: string }) => void
}) {
  createEffect(
    on(ctx.view.status, (after, before) =>
      Option.map(warningToast(before, after), (message) => ctx.toast({ variant: "warning", title: MARK, message })),
    ),
  )
}

/** The trusted count and, after it, the stopped count in the error tone. */
export function TrustedCount(props: { theme: Accessor<TuiThemeCurrent>; status: Status; bar: string }) {
  return (
    <text wrapMode="none">
      <span style={{ fg: props.theme().success }}>{`${props.bar ? `${props.bar} ` : ""}${trustedText(props.status)}`}</span>
      <span style={{ fg: props.theme().error }}>{stoppedText(props.status)}</span>
    </text>
  )
}

/** The muted older-status line (UI25), wrapped to `width`, for a status written before the tags. */
export function OlderLine(props: { theme: Accessor<TuiThemeCurrent>; status: Status; width: number }) {
  return (
    <For each={older(props.status) ? wrap(OLDER_LINE, props.width) : []}>
      {(line) => (
        <text fg={props.theme().textMuted} wrapMode="none" flexShrink={0}>
          {line}
        </text>
      )}
    </For>
  )
}

/** The collapsed run warning line and the outside wait line under it, wrapped to `width` (UI16, UI5). */
export function WarningLines(props: { theme: Accessor<TuiThemeCurrent>; status: Status; width: number }) {
  return (
    <>
      <Show when={warningOf(props.status)}>
        {(warning) => (
          <text fg={props.theme().warning} wrapMode="none" flexShrink={0}>
            {cut(warning().head, props.width)}
          </text>
        )}
      </Show>
      <For each={wrap(outsideCollapsed(props.status), props.width)}>
        {(line) => (
          <text fg={props.theme().warning} wrapMode="none" flexShrink={0}>
            {line}
          </text>
        )}
      </For>
    </>
  )
}

/** The run reason line, cut to `width`; nothing without a reason. */
export function ReasonLine(props: { theme: Accessor<TuiThemeCurrent>; status: Status; width: number }) {
  return (
    <Show when={Option.getOrUndefined(reasonLine(props.status))}>
      {(line) => (
        <text fg={line().tone === "error" ? props.theme().error : props.theme().textMuted} wrapMode="none" flexShrink={0}>
          {cut(line().text, props.width)}
        </text>
      )}
    </Show>
  )
}

/** `├ ` or `└ ` indented by depth; nothing for a root task. */
export const treePrefix = (row: Row) => (row.depth === 0 ? "" : `${"  ".repeat(row.depth - 1)}${row.last ? "└ " : "├ "}`)

/** `attempt 3`, or nothing before the first build. */
export const attemptText = (row: Row) => (row.task.attempts > 0 ? `attempt ${row.task.attempts}` : "")

/** `budget exhausted · attempt 3`. */
export const stateText = (row: Row) => [label(row.task.state), attemptText(row)].filter(Boolean).join(" · ")

/** One task as glyph, id and state, in the state's colour; the selected task gets the element background. */
export function TaskLine(props: {
  theme: Accessor<TuiThemeCurrent>
  row: Row
  selected: boolean
  width: number
  prefix?: string
  suffix?: string
  onClick?: () => void
}) {
  const left = () => `${props.prefix ?? ""}${glyph(props.row.task.state)} ${props.row.id}`
  // The state is cut, never the suffix: the suffix is the disclosure mark.
  const right = () => {
    const suffix = props.suffix ?? ""
    return `${cut(stateText(props.row), Math.max(1, props.width - left().length - suffix.length - 1))}${suffix}`
  }
  return (
    <box
      flexDirection="row"
      width={props.width}
      backgroundColor={props.selected ? props.theme().backgroundElement : "transparent"}
      onMouseDown={props.onClick}
    >
      <text fg={stateColor(props.theme(), props.row.task.state)} wrapMode="none" flexShrink={0}>
        {left()}
      </text>
      <box flexGrow={1} />
      <text fg={props.selected ? props.theme().text : props.theme().textMuted} wrapMode="none" flexShrink={0}>
        {right()}
      </text>
    </box>
  )
}

// The bar's parts in the order they are dropped last: a narrow prompt box keeps the first ones.
type Part = { readonly key: string; readonly label: string; readonly color?: RGBA }

/** The width the prompt box leaves for the bar: the terminal, less the sidebar when it shows, the agent and model. */
const barRoom = (width: number) => width - (width > 120 ? 42 : 0) - 38

/**
 * The keys of the bar. While the run is live, Tab selects tasks (and `esc` twice stops the run in the watch view);
 * otherwise Tab switches agents and `esc` leaves the run alone, so the bar offers `ctrl+x j/k` instead. The watch
 * view shows only its own keys.
 */
export const barKeys = (view: View, leader: string): Part[] => {
  const live = view.live()
  const select: Part = { key: `${leader} j/k`, label: "select task" }
  if (view.watching())
    return live
      ? [
          { key: "tab", label: "next running" },
          { key: `${leader} w`, label: "stop watching" },
          { key: "esc", label: "stop run" },
        ]
      : [select, { key: `${leader} w`, label: "stop watching" }]
  return [
    { key: `${leader} o`, label: view.expanded() ? "collapse" : "expand" },
    live ? { key: "tab", label: "select task" } : select,
    { key: `${leader} w`, label: "watch" },
  ]
}

/**
 * While the run is live and its session is on screen, Tab selects the next task (in the watch view, the next one in
 * work) and Shift+Tab the previous one, in place of the next agent; `ctrl+x a` still lists the agents. The layer is
 * newer than opencode's agent keys at the same priority, so it wins the tie. It steps aside for the prompt's
 * autocomplete, which binds Tab too, and on the home screen. Otherwise Tab switches agents, and `ctrl+x j/k` selects.
 */
export function registerTab(ctx: Ctx) {
  const { api, view } = ctx
  createEffect(() => {
    if (!view.live() || !ctx.owns()) return
    // True when it handled the key; false passes Tab on (to the autocomplete, or to the agent keys).
    const step = (by: 1 | -1) => () => {
      if (api.route.current.name === "home" || autocompleteOpen(api)) return false
      if (view.watching()) {
        if (by === 1) view.nextRunning()
        else view.previousRunning()
        return true
      }
      if (by === 1) view.next()
      else view.previous()
      return true
    }
    onCleanup(
      api.keymap.registerLayer({
        // A dialog's own Tab wins: this layer is off while one is open.
        mode: "base",
        priority: 0,
        commands: [
          { name: "task_ui.tab.next", title: "Select the next task", category: NAME, run: step(1) },
          { name: "task_ui.tab.previous", title: "Select the previous task", category: NAME, run: step(-1) },
        ],
        bindings: [
          { key: "tab", cmd: "task_ui.tab.next", desc: "Select the next task" },
          { key: "shift+tab", cmd: "task_ui.tab.previous", desc: "Select the previous task" },
        ],
      }),
    )
  })
}

/**
 * The shortcut bar at the bottom right of the input box: the design's name, its status where the bar is the design's
 * only presence in the session (3–5, 7), and every key, in opencode's own hint style (key, then what it does).
 */
export function ShortcutBar(props: ViewProps & { width: number }) {
  const parts = () => {
    const status = props.view.status()
    if (!status) return []
    const design = props.view.design()
    const row = props.view.rows().find((item) => item.id === props.view.selected())
    // The run warning and the outside wait come first, so a narrow bar keeps them (EXPERIENCE "Shortcut bar").
    const waits = outsideWaits(status)
    const alerts: Part[] = [
      ...(status.run.warning ? [{ key: "! spec", label: "", color: props.theme().warning }] : []),
      ...(waits.length > 0
        ? [
            {
              key: `/task trust ${waits[0]}${waits.length > 1 ? ` +${waits.length - 1}` : ""}`,
              label: "outside wait",
              color: props.theme().warning,
            },
          ]
        : []),
    ]
    const stopped = stoppedText(status).trim()
    const trusted: Part[] = [
      { key: trustedText(status), label: "" },
      ...(stopped ? [{ key: stopped, label: "", color: props.theme().error }] : []),
    ]
    const ticker: Part[] = row
      ? [{ key: `${glyph(row.task.state)} ${row.id}`, label: label(row.task.state), color: stateColor(props.theme(), row.task.state) }]
      : []
    const keys = barKeys(props.view, props.leader)
    const ordered =
      design === 7
        ? [...alerts, ...trusted, ...ticker, ...keys]
        : design >= 3 && design <= 5
          ? [...alerts, ...keys, ...trusted]
          : [...alerts, ...keys]
    const room = barRoom(props.width) - `${MARK} ${DESIGNS[design - 1].name}`.length
    // A narrow bar drops parts from the end: the first part that does not fit ends the bar.
    return ordered.reduce<{ used: number; full: boolean; list: Part[] }>(
      (fit, part) => {
        const size = part.key.length + part.label.length + 3
        return fit.full || fit.used + size > room
          ? { ...fit, full: true }
          : { used: fit.used + size, full: false, list: [...fit.list, part] }
      },
      { used: 0, full: false, list: [] },
    ).list
  }
  return (
    <Show when={props.view.status()}>
      <box flexDirection="row" gap={2}>
        <box flexDirection="row">
          <Brand theme={props.theme} moving={moving(props)} />
          <text fg={props.theme().text} wrapMode="none">
            {` ${DESIGNS[props.view.design() - 1].name}`}
          </text>
        </box>
        <For each={parts()}>
          {(part) => (
            <text fg={part.color ?? props.theme().text} wrapMode="none">
              {part.key}
              <Show when={part.label}>
                <span style={{ fg: props.theme().textMuted }}>{` ${part.label}`}</span>
              </Show>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

/**
 * True while the prompt's autocomplete is open. It binds Tab and `esc` too, so the task keys step aside for it: a
 * command that returns false lets the key reach the next layer.
 */
export const autocompleteOpen = (api: TuiPluginApi) =>
  api.keymap.getCommands({ visibility: "active", filter: (command) => command.name === "prompt.autocomplete.select" })
    .length > 0

/** The configured leader key (`ctrl+x` by default), for the key hints. */
export const leaderOf = (api: TuiPluginApi) => {
  const key = api.tuiConfig.keybinds.get("leader")[0]?.key
  return typeof key === "string" ? key : "ctrl+x"
}
