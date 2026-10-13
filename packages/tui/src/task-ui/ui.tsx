// Pieces several designs share: the HARNESS brand, a task line, and the context each design registers with.
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Accessor } from "solid-js"
import type { Sessions } from "./peek"
import { counts, glyph, label, stateColor, type Row, type Status, type View } from "./store"

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

/** `◆ HARNESS`: the mark every design carries, so no harness surface reads as an ordinary subagent task. */
export function Brand(props: { theme: Accessor<TuiThemeCurrent> }) {
  return (
    <b>
      <span style={{ fg: props.theme().accent }}>◆ HARNESS</span>
    </b>
  )
}

/** `o2 · running`, the harness and its run state. */
export const runText = (status: Status) => `${status.harness} · ${label(status.run.state)}`

/** `3/6 trusted`. */
export const trustedText = (status: Status) => {
  const count = counts(status)
  return `${count.trusted}/${count.total} trusted`
}

/** `├ ` or `└ ` indented by depth; nothing for a root task. */
export const treePrefix = (row: Row) => (row.depth === 0 ? "" : `${"  ".repeat(row.depth - 1)}${row.last ? "└ " : "├ "}`)

/** `budget exhausted · 3` — the state, and the attempt count once there has been a build. */
export const stateText = (row: Row) => `${label(row.task.state)}${row.task.attempts > 0 ? ` · ${row.task.attempts}` : ""}`

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
  const right = () => `${stateText(props.row)}${props.suffix ?? ""}`
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

/** The configured leader key (`ctrl+x` by default), for the key hints. */
export const leaderOf = (api: TuiPluginApi) => {
  const key = api.tuiConfig.keybinds.get("leader")[0]?.key
  return typeof key === "string" ? key : "ctrl+x"
}
