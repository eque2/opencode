// Design 3, Board: a full-screen kanban. One column for each stage of the harness's work, one card for each task;
// the peek opens on the right. The tags choose each card's column (AD-16, UI1).
import { Option } from "effect"
import { For } from "solid-js"
import {
  cut,
  durationOf,
  glyph,
  label,
  obligationsOf,
  stateColor,
  stoppedGroup,
  tagged,
  columnOf,
  type Column,
  type Liveness,
  type Row,
  type Status,
} from "../store"
import { pieceColor, waitSentences, wrap, type Piece } from "../shared"
import type { ViewProps } from "../ui"
import type { View } from "../view"

const COLUMNS: ReadonlyArray<Column> = ["WAITING", "BUILDING", "PROVING", "VERIFYING", "TRUSTED", "STOPPED"]

/** The cards of a column, in tree order; STOPPED in the STOPPED list order: dead, then blocked, then the rest. */
export const cardsIn = (list: ReadonlyArray<Row>, column: Column) => {
  const cards = list.filter((row) => Option.getOrUndefined(columnOf(row.task)) === column)
  return column === "STOPPED" ? cards.toSorted((a, b) => stoppedGroup(a.task) - stoppedGroup(b.task)) : cards
}

// Text in lines of `width`, at most `max` of them, the last cut with `…`.
const clamp = (text: string, width: number, max: number) => {
  const lines = wrap(text, width)
  return lines.length <= max ? lines : [...lines.slice(0, max - 1), cut(lines.slice(max - 1).join(" "), width)]
}

/**
 * A card's lines under its id (EXPERIENCE "Board card"), each `inner` cells at most: the state line (a blocked task's
 * cause in the warning tone, a waiting task's wait sentences, else the state label muted), "attempt N · <duration>"
 * (the duration on its own line when they do not fit), "proofs k/n", then a reason in at most 3 lines, in the error
 * tone with the `dead` tag and muted without it.
 */
export const cardLines = (
  status: Status,
  row: Row,
  liveness: Liveness,
  now: number,
  inner: number,
): ReadonlyArray<Piece> => {
  const task = row.task
  const blocked = tagged(task, "blocked")
  const state: ReadonlyArray<Piece> = blocked
    ? [{ text: task.reason ?? label(task.state), tone: "warning" }]
    : tagged(task, "waiting") && task.waitingOn.length > 0
      ? waitSentences(status, task)
      : [{ text: label(task.state), tone: "muted" }]
  const attempt = task.attempts > 0 ? `attempt ${task.attempts}` : ""
  const duration = durationOf(task, status.run, liveness, now)
  const meta =
    attempt && duration && `${attempt} · ${duration}`.length <= inner
      ? [`${attempt} · ${duration}`]
      : [attempt, duration]
  const proofs = obligationsOf(status, row.id)
  return [
    ...state.flatMap((piece) => wrap(piece.text, inner).map((text) => ({ ...piece, text }))),
    ...meta.filter(Boolean).map((text) => ({ text, tone: "muted" as const })),
    ...(proofs.length > 0
      ? [
          {
            text: cut(`proofs ${proofs.filter((item) => item.state === "trusted").length}/${proofs.length}`, inner),
            tone: "text" as const,
          },
        ]
      : []),
    ...(task.reason && !blocked
      ? clamp(task.reason, inner, 3).map((text) => ({
          text,
          tone: tagged(task, "dead") ? ("bad" as const) : ("muted" as const),
        }))
      : []),
  ]
}

const cardWidth = (width: number) => Math.max(14, Math.floor(width / COLUMNS.length) - 1)

/** The rows the Board takes at `width`: the headings, then its tallest column of cards (a border, the id, the lines). */
export const boardRows = (view: View, width: number) => {
  const status = view.status()
  if (!status) return 0
  const inner = cardWidth(width) - 4
  return (
    1 +
    Math.max(
      0,
      ...COLUMNS.map((column) =>
        cardsIn(view.rows(), column).reduce(
          (sum, row) => sum + 3 + cardLines(status, row, view.liveness(), view.now(), inner).length,
          0,
        ),
      ),
    )
  )
}

export function BoardView(props: ViewProps & { width: number }) {
  const width = () => cardWidth(props.width)
  return (
    <box flexDirection="row" gap={1}>
      <For each={COLUMNS}>
        {(column) => {
          const cards = () => cardsIn(props.view.rows(), column)
          return (
            <box flexDirection="column" width={width()} flexShrink={0}>
              <text fg={props.theme().textMuted} wrapMode="none">
                <b>{`${column} ${cards().length}`}</b>
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
  const inner = () => props.width - 4
  const lines = () => {
    const status = props.view.status()
    return status ? cardLines(status, props.row, props.view.liveness(), props.view.now(), inner()) : []
  }
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
      <For each={lines()}>
        {(line) => (
          <text fg={pieceColor(props.theme(), line)} wrapMode="none">
            {line.text}
          </text>
        )}
      </For>
    </box>
  )
}
