// Design 5, Gantt: the run as time. One lane per task, drawn from the task's spans (AD-5) across the run span, so a
// retry loop or a long wait shows as a shape, not a number. The display table gives each state its block and tone.
import { For, createMemo } from "solid-js"
import { DISPLAY, cut, durationOf, elapsed, glyph, runSpan, stateColor, type Liveness, type Status, type TaskStatus } from "../store"
import { stateText, treePrefix, type ViewProps } from "../ui"
import type { View } from "../view"

const LABEL = 11
// The right column: a space, the duration (7 cells), a space, the state text (21 cells).
const DURATION = 7
const STATE = 21
const RIGHT = 1 + DURATION + 1 + STATE
// The lane narrows first, down to this.
const LANE_MIN = 10

/** The Gantt's range: the run span, with a tail of 3% (1 s at least) after `run.endedAt`, so the last state shows. */
export const ganttRange = (status: Status, liveness: Liveness, now: number) => {
  const run = runSpan(status, liveness, now)
  if (status.run.endedAt === undefined) return run
  return { start: run.start, end: run.end + Math.max(1000, (run.end - run.start) * 0.03) }
}

type Run = { readonly state: string | undefined; readonly length: number }

/**
 * A task's lane, as runs of one state (UI4): each of `width` cells shows the span that holds the cell's middle time; a
 * span with no `to` runs to `open`; a zero-length span takes the one cell that holds its time; a cell before the first
 * span or after the last is blank (`undefined`): the Gantt infers no state.
 */
export const lane = (task: TaskStatus, width: number, range: { start: number; end: number }, open: number): ReadonlyArray<Run> => {
  const spans = task.spans ?? []
  const size = (range.end - range.start) / width
  const states = Array.from({ length: width }, (_, cell): string | undefined => {
    const at = range.start + (cell + 0.5) * size
    return spans.find((span) => span.from <= at && at < (span.to ?? open))?.state
  })
  for (const span of spans)
    if (span.to === span.from) states[Math.min(width - 1, Math.max(0, Math.floor((span.from - range.start) / size)))] = span.state
  return states.reduce<Run[]>((runs, state) => {
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

/** The rows the Gantt takes: the axis, the task rows, a gap and the legend. */
export const ganttRows = (view: View) => 1 + view.rows().length + 2

export function GanttView(props: ViewProps & { width: number }) {
  const width = () => Math.max(LANE_MIN, props.width - LABEL - RIGHT)
  const range = createMemo(() => {
    const status = props.view.status()
    return status ? ganttRange(status, props.view.liveness(), props.view.now()) : { start: 0, end: 1 }
  })
  // Where an open span ends: the run span's end, before the tail.
  const open = () => {
    const status = props.view.status()
    return status ? runSpan(status, props.view.liveness(), props.view.now()).end : 0
  }
  return (
    <box flexDirection="column" width={props.width}>
      <text fg={props.theme().textMuted} wrapMode="none">
        {"".padEnd(LABEL) + axis(width(), range())}
      </text>
      <For each={props.view.rows()}>
        {(row) => {
          const runs = () => {
            const status = props.view.status()
            return status ? lane(row.task, width(), range(), open()) : []
          }
          const duration = () => {
            const status = props.view.status()
            return status ? durationOf(row.task, status.run, props.view.liveness(), props.view.now()) : ""
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
                  <span style={{ fg: run.state ? stateColor(props.theme(), run.state) : props.theme().textMuted }}>
                    {(run.state ? (DISPLAY[run.state]?.block ?? "█") : " ").repeat(run.length)}
                  </span>
                )}
              </For>
              <span style={{ fg: props.theme().textMuted }}>
                {` ${duration().padStart(DURATION)} ${cut(stateText(row), STATE)}`}
              </span>
            </text>
          )
        }}
      </For>
      <text fg={props.theme().textMuted} wrapMode="none" marginTop={1}>
        ░ waiting ▓ building ▒ proving ▞ verifying █ ended, in its state's colour
      </text>
    </box>
  )
}
