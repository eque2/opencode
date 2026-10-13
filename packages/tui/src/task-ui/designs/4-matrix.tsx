// Design 4, Matrix: the evidence at a glance. One row per task, one column per obligation id (c1…, e1, p1, f1…),
// the scenarios underneath, and the selected task's open obligations with their reasons.
import { For, Show, createMemo } from "solid-js"
import { byId, bySeverity, cut, glyph, label, obligationsOf, stateColor } from "../store"
import { treePrefix, type ViewProps } from "../ui"

const LABEL = 12
const CELL = 4
// ensures (c), the parent's own (e), preserves (p), forbids (f): the order the blend format lists them in.
const KINDS = ["c", "e", "p", "f"]

const kindOf = (local: string) => {
  const at = KINDS.indexOf(local.replace(/\d+$/, ""))
  return at < 0 ? KINDS.length : at
}

export function MatrixView(props: ViewProps & { width: number }) {
  const columns = createMemo(() => {
    const status = props.view.status()
    if (!status) return []
    return props.view
      .rows()
      .flatMap((row) => obligationsOf(status, row.id).map((item) => item.local))
      .filter((local, index, all) => all.indexOf(local) === index)
      .sort((a, b) => kindOf(a) - kindOf(b) || byId(a, b))
  })
  const scenarios = createMemo(() =>
    Object.entries(props.view.status()?.scenarios ?? {}).sort(([a], [b]) => byId(a, b)),
  )
  const open = createMemo(() => {
    const status = props.view.status()
    const id = props.view.selected()
    return status && id ? obligationsOf(status, id).filter((item) => item.state !== "trusted").toSorted(bySeverity) : []
  })

  return (
    <box flexDirection="column" width={props.width}>
      <text fg={props.theme().textMuted} wrapMode="none">
        {"".padEnd(LABEL) + columns().map((local) => local.padEnd(CELL)).join("")}
      </text>
      <For each={props.view.rows()}>
        {(row) => {
          const cells = () => {
            const status = props.view.status()
            const own = status ? obligationsOf(status, row.id) : []
            return columns().map((local) => own.find((item) => item.local === local))
          }
          return (
            <text
              wrapMode="none"
              bg={props.view.selected() === row.id ? props.theme().backgroundElement : "transparent"}
              onMouseDown={() => (props.view.selected() === row.id ? props.view.toggleExpanded() : props.view.select(row.id))}
            >
              <span style={{ fg: stateColor(props.theme(), row.task.state) }}>
                {cut(`${treePrefix(row)}${glyph(row.task.state)} ${row.id}`, LABEL - 1).padEnd(LABEL)}
              </span>
              <For each={cells()}>
                {(cell) => (
                  <span style={{ fg: cell ? stateColor(props.theme(), cell.state) : props.theme().textMuted }}>
                    {(cell ? glyph(cell.state) : " ").padEnd(CELL)}
                  </span>
                )}
              </For>
            </text>
          )
        }}
      </For>
      <text fg={props.theme().textMuted} wrapMode="none" marginTop={1}>
        <b>SCENARIOS</b>
      </text>
      <box flexDirection="row" flexWrap="wrap" columnGap={2} width={props.width}>
        <For each={scenarios()}>
          {([id, scenario]) => (
            <text fg={stateColor(props.theme(), scenario.state)} wrapMode="none">
              {`${glyph(scenario.state)} ${id}`}
            </text>
          )}
        </For>
      </box>
      <text fg={props.theme().textMuted} wrapMode="none" marginTop={1}>
        · pending   ◉ proof passed   ✓ trusted   ✗ failed or rejected   ~ stale   ○ waiting
      </text>
      <Show when={open().length > 0}>
        <text fg={props.theme().text} wrapMode="none" marginTop={1}>
          <b>{`${props.view.selected()} open obligations`}</b>
        </text>
        <For each={open()}>
          {(item) => (
            <text fg={stateColor(props.theme(), item.state)} wrapMode="none">
              {cut(`  ${glyph(item.state)} ${item.id} ${label(item.state)}${item.reason ? ` — ${item.reason}` : ""}`, props.width)}
            </text>
          )}
        </For>
      </Show>
    </box>
  )
}
