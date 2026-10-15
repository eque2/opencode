// Design 3, Board: a full-screen kanban. One column for each stage of the harness's work, one card for each task;
// the peek opens on the right.
import { For, Show } from "solid-js"
import { cut, glyph, label, obligationsOf, stateColor, type Row } from "../store"
import { wrap } from "../shared"
import { attemptText, type ViewProps } from "../ui"
import type { View } from "../view"

const COLUMNS = [
  { name: "WAITING", states: ["waiting"] },
  { name: "BUILDING", states: ["building"] },
  { name: "PROVING", states: ["proving"] },
  { name: "VERIFYING", states: ["verifying"] },
  { name: "TRUSTED", states: ["trusted"] },
  // Every other state stops the task until the developer acts: stalled, needs_human, budget_exhausted, …
  { name: "STOPPED", states: [] },
]

const columnOf = (state: string) =>
  COLUMNS.find((column) => column.states.includes(state)) ?? COLUMNS[COLUMNS.length - 1]

// A card's rows: its border, the id and state lines, then each line it shows.
const cardRows = (row: Row, proofs: number, width: number) =>
  4 +
  (attemptText(row) ? 1 : 0) +
  (proofs > 0 ? 1 : 0) +
  (row.task.waitingOn.length > 0 ? 1 : 0) +
  (row.task.reason ? wrap(cut(row.task.reason, (width - 4) * 3), width - 4).length : 0)

/** The rows the Board takes at `width`: the headings, then its tallest column of cards. */
export const boardRows = (view: View, width: number) => {
  const status = view.status()
  if (!status) return 0
  const cards = Math.max(14, Math.floor(width / COLUMNS.length) - 1)
  return (
    1 +
    Math.max(
      0,
      ...COLUMNS.map((column) =>
        view
          .rows()
          .filter((row) => columnOf(row.task.state) === column)
          .reduce((sum, row) => sum + cardRows(row, obligationsOf(status, row.id).length, cards), 0),
      ),
    )
  )
}

export function BoardView(props: ViewProps & { width: number }) {
  const width = () => Math.max(14, Math.floor(props.width / COLUMNS.length) - 1)
  return (
    <box flexDirection="row" gap={1}>
      <For each={COLUMNS}>
        {(column) => {
          const cards = () => props.view.rows().filter((row) => columnOf(row.task.state) === column)
          return (
            <box flexDirection="column" width={width()} flexShrink={0}>
              <text fg={props.theme().textMuted} wrapMode="none">
                <b>{`${column.name} ${cards().length}`}</b>
              </text>
              <For each={cards()}>{(row) => <Card {...props} row={row} width={width()} />}</For>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function Card(props: ViewProps & { row: Row; width: number }) {
  const selected = () => props.view.selected() === props.row.id
  const proofs = () => {
    const status = props.view.status()
    return status ? obligationsOf(status, props.row.id) : []
  }
  const inner = () => props.width - 4
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={selected() ? props.theme().accent : stateColor(props.theme(), props.row.task.state)}
      backgroundColor={selected() ? props.theme().backgroundElement : "transparent"}
      width={props.width}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={() => props.view.select(props.row.id)}
    >
      <text fg={stateColor(props.theme(), props.row.task.state)} wrapMode="none">
        <b>{cut(`${glyph(props.row.task.state)} ${props.row.id}`, inner())}</b>
      </text>
      <text fg={props.theme().textMuted} wrapMode="none">
        {cut(label(props.row.task.state), inner())}
      </text>
      <Show when={attemptText(props.row)}>
        <text fg={props.theme().textMuted} wrapMode="none">
          {attemptText(props.row)}
        </text>
      </Show>
      <Show when={proofs().length > 0}>
        <text fg={props.theme().text} wrapMode="none">
          {cut(`proofs ${proofs().filter((item) => item.state === "trusted").length}/${proofs().length}`, inner())}
        </text>
      </Show>
      <Show when={props.row.task.waitingOn.length > 0}>
        <text fg={props.theme().textMuted} wrapMode="none">
          {cut(`waits on ${props.row.task.waitingOn.join(", ")}`, inner())}
        </text>
      </Show>
      <Show when={props.row.task.reason}>
        <text fg={props.theme().error} wrapMode="word">
          {cut(props.row.task.reason ?? "", inner() * 3)}
        </text>
      </Show>
    </box>
  )
}
