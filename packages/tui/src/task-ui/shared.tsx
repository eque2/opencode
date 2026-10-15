// The shared region (EXPERIENCE "Shared region"; D4, D12, D19, D20): one block in every expanded view, in this order —
// the run warning list, the outside wait lines, the STOPPED list, the SCENARIOS list. A section with nothing to show is
// hidden, except the SCENARIOS heading. The region is a scroll box: the mouse wheel scrolls it everywhere, and the
// full-screen views and the Ticker dialog bind pageup and pagedown to it. A click on a STOPPED line selects its first
// task. The line builders are pure, so the tests read them without a renderer.
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { Array as Arr } from "effect"
import { For, Show, createMemo, type Accessor } from "solid-js"
import { byId, color, cut, glyph, label, rows, stoppedGroup, tagged, tone, type Status, type Tone } from "./store"
import type { View } from "./view"

// --- the run warning (D12, UI16) --------------------------------------------------------------------------------------

/** The run warning: its one line, each `run.warning` line, and the note; none without a warning. */
export const warningOf = (status: Status) => {
  const lines = status.run.warning ? status.run.warning.split("\n") : []
  if (lines.length === 0) return undefined
  return {
    head: `! spec no longer validates · ${lines.length} ${lines.length === 1 ? "failure" : "failures"}`,
    lines,
    note: "The run keeps the plan it loaded.",
  }
}

// --- the outside wait lines (D4, UI5) -----------------------------------------------------------------------------------

/** The untrusted outside ids a task or scenario waits on, in natural order; none once the run has ended. */
export const outsideWaits = (status: Status): ReadonlyArray<string> => {
  if (tagged(status.run, "ended")) return []
  const ids = [...Object.values(status.tasks), ...Object.values(status.scenarios)].flatMap(
    (unit) => unit.waitingOnOutside ?? [],
  )
  return Arr.dedupe(ids)
    .filter((id) => status.outside?.[id]?.state === "untrusted")
    .sort(byId)
}

export const outsideLine = (id: string) => `waiting on ${id} (outside) — run /task trust ${id}`

// --- the STOPPED list (D19, UI9) --------------------------------------------------------------------------------------

/** One STOPPED line: the tasks with one state and one reason, ids in natural order. */
export interface StoppedLine {
  readonly state: string
  readonly ids: ReadonlyArray<string>
  readonly reason: string
  readonly blocked: boolean
}

/** Every task with the `stopped` tag, one line for each state and reason: dead, then blocked, then the rest. */
export const stoppedLines = (status: Status): ReadonlyArray<StoppedLine> => {
  const stopped = rows(status).filter((row) => tagged(row.task, "stopped"))
  const keys = Arr.dedupe(stopped.map((row) => `${row.task.state}\n${row.task.reason ?? ""}`))
  return keys
    .map((key) => {
      const members = stopped.filter((row) => `${row.task.state}\n${row.task.reason ?? ""}` === key)
      const first = members[0].task
      return {
        group: stoppedGroup(first),
        line: {
          state: first.state,
          ids: members.map((row) => row.id).sort(byId),
          reason: first.reason ?? "",
          blocked: tagged(first, "blocked"),
        },
      }
    })
    .toSorted((a, b) => a.group - b.group)
    .map((item) => item.line)
}

/** One coloured piece of a line. */
export type Piece = { readonly text: string; readonly tone: Tone | "warning" | "muted" | "text" }

/** The pieces of a line cut to `width` cells, with `…` where the text was cut. */
export const fit = (pieces: ReadonlyArray<Piece>, width: number): ReadonlyArray<Piece> => {
  const total = pieces.reduce((sum, piece) => sum + piece.text.length, 0)
  if (total <= width) return pieces
  return pieces.reduce<{ room: number; out: Piece[] }>(
    (acc, piece) => {
      if (acc.room <= 0) return acc
      if (piece.text.length < acc.room) return { room: acc.room - piece.text.length, out: [...acc.out, piece] }
      return { room: 0, out: [...acc.out, { ...piece, text: cut(piece.text, acc.room) }] }
    },
    { room: width, out: [] },
  ).out
}

/** The text of pieces, for a test or a width count. */
export const textOf = (pieces: ReadonlyArray<Piece>) => pieces.map((piece) => piece.text).join("")

// The ids that fit in a third of the line; "+N" for the rest.
const idsFitting = (ids: ReadonlyArray<string>, room: number) => {
  const shown = ids.reduce<string[]>((acc, id) => ([...acc, id].join(", ").length <= room ? [...acc, id] : acc), [])
  const list = shown.length > 0 ? shown : ids.slice(0, 1)
  return { text: list.join(", "), more: ids.length - list.length }
}

/**
 * A STOPPED line fit to `width` (UI9): the glyph and ids in the state's tone ("+N" muted when they do not fit), the
 * state label, then " — " and the reason muted; a blocked line has no label, its reason in the warning tone. Under 30
 * cells the reason goes.
 */
export const stoppedPieces = (line: StoppedLine, width: number): ReadonlyArray<Piece> => {
  const ids = idsFitting(line.ids, Math.max(8, Math.floor(width / 3)))
  const lead: Piece[] = [
    { text: `${glyph(line.state)} ${ids.text}`, tone: tone(line.state) },
    ...(ids.more > 0 ? [{ text: `, +${ids.more}`, tone: "muted" as const }] : []),
  ]
  const short = width < 30
  // A blocked line's reason is its label ("blocked by …"); under 30 cells only the state stays.
  if (line.blocked)
    return fit(
      [...lead, { text: ` ${short || !line.reason ? label(line.state) : line.reason}`, tone: "warning" as const }],
      width,
    )
  return fit(
    [
      ...lead,
      { text: ` ${label(line.state)}`, tone: "text" },
      ...(short || !line.reason ? [] : [{ text: ` — ${line.reason}`, tone: "muted" as const }]),
    ],
    width,
  )
}

// --- the SCENARIOS list (D20, UI10) -----------------------------------------------------------------------------------

/** One SCENARIOS entry, before it is fit to a column. */
export interface ScenarioEntry {
  readonly id: string
  readonly state: string
  /** The label: the state, a wait ("waiting on …", "not run: waiting on …") or a blocked reason. */
  readonly label: ReadonlyArray<Piece>
  /** Whether the label is a wait list, which is cut before the title goes below 12 cells. */
  readonly waits: boolean
  readonly title: string
  /** A stopped, not blocked scenario's reason, under its entry. */
  readonly reason: string
}

/** The waits of a waiting unit: "waiting on T1.4, T8 (outside)". */
const waitPieces = (waitingOn: ReadonlyArray<string>, outside: ReadonlyArray<string>): ReadonlyArray<Piece> =>
  waitingOn.flatMap((id, index): Piece[] => [
    { text: `${index === 0 ? "waiting on " : ", "}${id}`, tone: "muted" },
    ...(outside.includes(id) ? [{ text: " (outside)", tone: "warning" as const }] : []),
  ])

/** Every scenario of the run, in natural id order, with its label, title and reason. */
export const scenarioEntries = (status: Status): ReadonlyArray<ScenarioEntry> => {
  const ended = tagged(status.run, "ended")
  return Object.keys(status.scenarios)
    .sort(byId)
    .map((id) => {
      const scenario = status.scenarios[id]
      const waiting = tagged(scenario, "waiting") && scenario.waitingOn.length > 0
      const waits = waiting ? waitPieces(scenario.waitingOn, scenario.waitingOnOutside ?? []) : []
      const labelPieces: ReadonlyArray<Piece> = tagged(scenario, "blocked")
        ? [{ text: scenario.reason ?? label(scenario.state), tone: "warning" }]
        : waiting
          ? ended
            ? [{ text: "not run: ", tone: "muted" }, ...waits]
            : waits
          : ended && tagged(scenario, "waiting")
            ? [{ text: "not run", tone: "muted" }]
            : [{ text: label(scenario.state), tone: "muted" }]
      return {
        id,
        state: scenario.state,
        label: labelPieces,
        waits: waiting,
        title: scenario.title ?? "",
        reason: tagged(scenario, "stopped") && !tagged(scenario, "blocked") ? (scenario.reason ?? "") : "",
      }
    })
}

/** The heading: "SCENARIOS 13 · 3/13 trusted", or "SCENARIOS none in this run". */
export const scenariosHeading = (status: Status) => {
  const all = Object.values(status.scenarios)
  if (all.length === 0) return "SCENARIOS none in this run"
  return `SCENARIOS ${all.length} · ${all.filter((scenario) => scenario.state === "trusted").length}/${all.length} trusted`
}

/** The fewest cells a title keeps. */
export const TITLE_MIN = 12

/**
 * One entry fit to a column (UI10): the glyph, the id and the state label are never cut; a wait list is cut before the
 * title goes below 12 cells; the title takes the rest.
 */
export const entryPieces = (entry: ScenarioEntry, width: number): ReadonlyArray<Piece> => {
  const lead: Piece = { text: `${glyph(entry.state)} ${entry.id} `, tone: tone(entry.state) }
  const room = Math.max(0, width - lead.text.length - 3)
  const labelLength = textOf(entry.label).length
  const labelRoom = entry.waits
    ? Math.max(0, Math.min(labelLength, room - Math.min(TITLE_MIN, entry.title.length)))
    : labelLength
  const labelPieces = fit(entry.label, labelRoom)
  const titleRoom = Math.max(0, room - textOf(labelPieces).length)
  return [lead, ...labelPieces, { text: " · ", tone: "muted" }, { text: cut(entry.title, titleRoom), tone: "text" }]
}

/** The reason under an entry: indented 4 cells, at most 2 lines, cut with `…`. */
export const reasonLines = (reason: string, width: number): ReadonlyArray<string> => {
  const room = Math.max(1, width - 4)
  const words = reason.split(/\s+/).filter(Boolean)
  const lines = words.reduce<string[]>((acc, word) => {
    const last = acc.at(-1)
    if (last !== undefined && `${last} ${word}`.length <= room) return [...acc.slice(0, -1), `${last} ${word}`]
    return [...acc, word]
  }, [])
  const shown = lines.slice(0, 2)
  if (lines.length > 2) shown[1] = cut(`${shown[1]} ${lines.slice(2).join(" ")}`, room)
  return shown.map((line) => `    ${cut(line, room)}`)
}

/** Two columns from 80 cells, filled column first; one column below. */
export const columnsOf = <A,>(items: ReadonlyArray<A>, width: number): ReadonlyArray<ReadonlyArray<A>> => {
  if (width < 80) return [items]
  const half = Math.ceil(items.length / 2)
  return [items.slice(0, half), items.slice(half)]
}

/** Scrolls the region one page (its height less one row) down (1) or up (-1): pagedown and pageup. */
export const pageBy = (box: ScrollBoxRenderable | undefined, by: 1 | -1) =>
  box?.scrollBy(by * Math.max(1, box.height - 1))

// --- the component ----------------------------------------------------------------------------------------------------

const pieceColor = (theme: TuiThemeCurrent, piece: Piece): RGBA =>
  piece.tone === "warning"
    ? theme.warning
    : piece.tone === "muted"
      ? theme.textMuted
      : piece.tone === "text"
        ? theme.text
        : color(theme, piece.tone)

function Pieces(props: { theme: Accessor<TuiThemeCurrent>; pieces: ReadonlyArray<Piece>; onClick?: () => void }) {
  return (
    <text wrapMode="none" onMouseDown={props.onClick}>
      <For each={props.pieces}>
        {(piece) => <span style={{ fg: pieceColor(props.theme(), piece) }}>{piece.text}</span>}
      </For>
    </text>
  )
}

/** The rows the region's content takes at `width`: a test and a design use it to size the region. */
export const regionRows = (status: Status, width: number) => {
  const warning = warningOf(status)
  const stopped = stoppedLines(status)
  const entries = scenarioEntries(status)
  const height = (column: ReadonlyArray<ScenarioEntry>, cells: number) =>
    column.reduce((sum, entry) => sum + 1 + (entry.reason ? reasonLines(entry.reason, cells).length : 0), 0)
  const columns = columnsOf(entries, width)
  const cells = columns.length === 2 ? Math.floor((width - 3) / 2) : width
  return (
    (warning ? warning.lines.length + 2 : 0) +
    outsideWaits(status).length +
    (stopped.length > 0 ? stopped.length + 1 : 0) +
    1 +
    Math.max(0, ...columns.map((column) => height(column, cells)))
  )
}

/**
 * The region: a scroll box `height` rows tall (its content's rows when smaller), `width` cells wide. `onScroll` gets
 * the scroll box, so a full-screen view or a dialog can bind pageup and pagedown to it.
 */
export function SharedRegion(props: {
  theme: Accessor<TuiThemeCurrent>
  view: View
  width: number
  height: number
  onScroll?: (box: ScrollBoxRenderable) => void
}) {
  const status = () => props.view.status()
  const columns = createMemo(() => {
    const current = status()
    return current ? columnsOf(scenarioEntries(current), props.width) : []
  })
  const cells = () => (columns().length === 2 ? Math.floor((props.width - 3) / 2) : props.width)
  const rows = () => {
    const current = status()
    return current ? Math.min(props.height, regionRows(current, props.width)) : 0
  }
  return (
    <Show when={status()}>
      {(current) => (
        <scrollbox
          ref={(box: ScrollBoxRenderable) => props.onScroll?.(box)}
          height={rows()}
          width={props.width}
          flexShrink={0}
          scrollbarOptions={{ visible: false }}
        >
          <Show when={warningOf(current())}>
            {(warning) => (
              <box flexDirection="column">
                <text fg={props.theme().warning} wrapMode="none">
                  {cut(warning().head, props.width)}
                </text>
                <For each={warning().lines}>
                  {(line) => (
                    <text fg={props.theme().warning} wrapMode="none">
                      {cut(line, props.width)}
                    </text>
                  )}
                </For>
                <text fg={props.theme().textMuted} wrapMode="none">
                  {cut(warning().note, props.width)}
                </text>
              </box>
            )}
          </Show>
          <For each={outsideWaits(current())}>
            {(id) => (
              <text fg={props.theme().warning} wrapMode="word">
                {outsideLine(id)}
              </text>
            )}
          </For>
          <Show when={stoppedLines(current()).length > 0}>
            <text fg={props.theme().textMuted} wrapMode="none">
              <b>{`STOPPED ${stoppedLines(current()).reduce((sum, line) => sum + line.ids.length, 0)}`}</b>
            </text>
            <For each={stoppedLines(current())}>
              {(line) => (
                <Pieces
                  theme={props.theme}
                  pieces={stoppedPieces(line, props.width)}
                  onClick={() => props.view.select(line.ids[0])}
                />
              )}
            </For>
          </Show>
          <text fg={props.theme().textMuted} wrapMode="none">
            <b>{scenariosHeading(current())}</b>
          </text>
          <box flexDirection="row" gap={3}>
            <For each={columns()}>
              {(column) => (
                <box flexDirection="column" width={cells()}>
                  <For each={column}>
                    {(entry) => (
                      <>
                        <Pieces theme={props.theme} pieces={entryPieces(entry, cells())} />
                        <For each={entry.reason ? reasonLines(entry.reason, cells()) : []}>
                          {(line) => (
                            <text fg={color(props.theme(), tone(entry.state))} wrapMode="none">
                              {line}
                            </text>
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
        </scrollbox>
      )}
    </Show>
  )
}
