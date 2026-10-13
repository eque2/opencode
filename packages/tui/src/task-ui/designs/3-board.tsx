// Design 3, Board: a full-screen kanban. One column for each stage of the harness's work, one card for each task;
// the peek opens on the right.
import { For, Show } from "solid-js"
import { cut, glyph, label, obligationsOf, stateColor, type Row } from "../store"
import { attemptText, type ViewProps } from "../ui"

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
