// Pieces several designs share: the HARNESS brand, a task line, the shortcut bar, and the context each design gets.
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { RGBA } from "@opentui/core"
import { For, Show, type Accessor } from "solid-js"
import type { Sessions } from "./peek"
import { DESIGNS, MARK, counts, cut, glyph, label, stateColor, type Row, type Status, type View } from "./store"

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
}

/** What the view components need; tests build it from a fixture. */
export type ViewProps = {
  readonly theme: Accessor<TuiThemeCurrent>
  readonly view: View
  readonly sessions: Sessions
  readonly leader: string
}

/** The mark every design carries (`MARK`), in bold accent. */
export function Brand(props: { theme: Accessor<TuiThemeCurrent> }) {
  return (
    <b>
      <span style={{ fg: props.theme().accent }}>{MARK}</span>
    </b>
  )
}

/** `run: budget exhausted`. */
export const runText = (status: Status) => `run: ${label(status.run.state)}`

/** `3/6 trusted`. */
export const trustedText = (status: Status) => {
  const count = counts(status)
  return `${count.trusted}/${count.total} trusted`
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
 * The shortcut bar at the bottom right of the input box: the design's name, its status where the bar is the design's
 * only presence in the session (3–5, 7), and every key, in opencode's own hint style (key, then what it does).
 */
export function ShortcutBar(props: ViewProps & { width: number }) {
  const parts = () => {
    const status = props.view.status()
    if (!status) return []
    const design = props.view.design()
    const row = props.view.rows().find((item) => item.id === props.view.selected())
    const trusted: Part = { key: trustedText(status), label: "" }
    const ticker: Part[] = row
      ? [{ key: `${glyph(row.task.state)} ${row.id}`, label: label(row.task.state), color: stateColor(props.theme(), row.task.state) }]
      : []
    const keys: Part[] = [
      { key: `${props.leader} o`, label: props.view.expanded() ? "collapse" : "expand" },
      { key: "/task-design", label: "switch" },
      { key: `${props.leader} j/k`, label: "select task" },
    ]
    const ordered = design === 7 ? [trusted, ...ticker, ...keys] : design >= 3 && design <= 5 ? [...keys, trusted] : keys
    const room = barRoom(props.width) - `${MARK} ${DESIGNS[design - 1].name}`.length
    return ordered.reduce<{ used: number; list: Part[] }>(
      (fit, part) => {
        const size = part.key.length + part.label.length + 3
        return fit.used + size > room ? fit : { used: fit.used + size, list: [...fit.list, part] }
      },
      { used: 0, list: [] },
    ).list
  }
  return (
    <Show when={props.view.status()}>
      <box flexDirection="row" gap={2}>
        <text wrapMode="none">
          <Brand theme={props.theme} />
          <span style={{ fg: props.theme().text }}>{` ${DESIGNS[props.view.design() - 1].name}`}</span>
        </text>
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

/** The configured leader key (`ctrl+x` by default), for the key hints. */
export const leaderOf = (api: TuiPluginApi) => {
  const key = api.tuiConfig.keybinds.get("leader")[0]?.key
  return typeof key === "string" ? key : "ctrl+x"
}
