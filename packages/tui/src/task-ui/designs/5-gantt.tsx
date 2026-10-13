// Design 5, Gantt: the run as time. One lane per task, coloured by its state over time from the status history, so
// a retry loop or a long wait shows as a shape, not a number.
import { For, createMemo } from "solid-js"
import { ENDED, cut, elapsed, glyph, stateColor, type Status } from "../store"
import { stateText, treePrefix, type ViewProps } from "../ui"

const LABEL = 11
const RIGHT = 30

// The three working stages get their own block, so a build-prove-build retry loop is visible; every other state is
// a full block in its colour.
const BLOCK: Record<string, string> = { waiting: "░", cancelled: "░", building: "▓", proving: "▒", verifying: "▞" }

/** The run's span: its first history entry to just past its last when it has ended, or to `now`. */
export const span = (status: Status, now: number) => {
  const times = status.history.map((entry) => entry.at)
  const start = times.length > 0 ? Math.min(...times) : now
  if (!ENDED.includes(status.run.state) || times.length === 0) return { start, end: Math.max(now, start + 1) }
  // A tail of 3% so the state each task ended in shows, not only the transition into it.
  const last = Math.max(...times)
  return { start, end: last + Math.max(1000, (last - start) * 0.03) }
}

/** A task's lane as runs of one state: the state at the middle of each of `width` cells. */
export const lane = (status: Status, id: string, width: number, range: { start: number; end: number }) => {
  const entries = status.history.filter((entry) => entry.unit === id).toSorted((a, b) => a.at - b.at)
  const states = Array.from({ length: width }, (_, cell) => {
    const at = range.start + ((cell + 0.5) * (range.end - range.start)) / width
    return entries.findLast((entry) => entry.at <= at)?.to ?? "waiting"
  })
  return states.reduce<{ state: string; length: number }[]>((runs, state) => {
    const last = runs.at(-1)
    if (last && last.state === state) return [...runs.slice(0, -1), { state, length: last.length + 1 }]
    return [...runs, { state, length: 1 }]
  }, [])
}

/** The time axis: elapsed time at the start, the quarters and the end, each label where its tick falls. */
const axis = (width: number, range: { start: number; end: number }) =>
  [0, 0.25, 0.5, 0.75].reduce((line, at) => {
    const column = Math.floor(at * width)
    const text = elapsed(at * (range.end - range.start))
    return column < line.length ? line : line.padEnd(column) + text + " "
  }, "").padEnd(width - 6).slice(0, width - 6) + elapsed(range.end - range.start).padStart(6)

export function GanttView(props: ViewProps & { width: number }) {
  const width = () => Math.max(10, props.width - LABEL - RIGHT)
  const range = createMemo(() => {
    const status = props.view.status()
    return status ? span(status, props.view.now()) : { start: 0, end: 1 }
  })
  return (
    <box flexDirection="column" width={props.width}>
      <text fg={props.theme().textMuted} wrapMode="none">
        {"".padEnd(LABEL) + axis(width(), range())}
      </text>
      <For each={props.view.rows()}>
        {(row) => {
          const runs = () => {
            const status = props.view.status()
            return status ? lane(status, row.id, width(), range()) : []
          }
          return (
            <text
              wrapMode="none"
              bg={props.view.selected() === row.id ? props.theme().backgroundElement : "transparent"}
              onMouseDown={() => props.view.select(row.id)}
            >
              <span style={{ fg: stateColor(props.theme(), row.task.state) }}>
                {cut(`${treePrefix(row)}${glyph(row.task.state)} ${row.id}`, LABEL - 1).padEnd(LABEL)}
              </span>
              <For each={runs()}>
                {(run) => (
                  <span style={{ fg: stateColor(props.theme(), run.state) }}>{(BLOCK[run.state] ?? "█").repeat(run.length)}</span>
                )}
              </For>
              <span style={{ fg: props.theme().textMuted }}>
                {` ${cut(stateText(row), RIGHT - 1)}`}
              </span>
            </text>
          )
        }}
      </For>
      <text fg={props.theme().textMuted} wrapMode="none" marginTop={1}>
        ░ waiting ▓ building ▒ proving ▞ verifying █ trusted, or stopped in its colour
      </text>
    </box>
  )
}
