// The peek: what the harness's builder did for one task, what its proofs found, and what the verifier decided. Every
// design opens it on demand; it is read-only and framed so that it never looks like an ordinary subagent task.
import type { Part } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { Effect } from "effect"
import { For, Show, createMemo, createResource, type Accessor } from "solid-js"
import {
  MARK,
  bySeverity,
  color,
  cut,
  durationOf,
  glyph,
  label,
  obligationsOf,
  stateColor,
  tagged,
  tone,
  type Liveness,
  type Status,
  type Tone,
} from "./store"
import { pieceColor, waitSentences, wrap, type Piece } from "./shared"
import type { View } from "./view"

/** A builder, verifier or reviewer session the harness made for a unit (`T1.4 builder`, `S3 verifier (again)`). */
export type Child = {
  readonly id: string
  readonly role: string
  readonly again: boolean
  readonly created: number
  /** When the session last changed: a session still at work keeps moving this. */
  readonly updated: number
}

/** A harness session, the unit it works on, and what it spent: input, output and reasoning tokens, and its cost. */
export type Harness = Child & { readonly unit: string; readonly tokens: number; readonly cost: number }

/** One line of a session's latest activity. */
export type Line = { readonly glyph: string; readonly tone: Tone; readonly text: string }

/** Where the peek reads sessions from: the live server, or fixed data in a test. */
export type Sessions = {
  /** The harness sessions of `unit`, oldest first, from the shared session list. */
  readonly children: (unit: string) => Accessor<ReadonlyArray<Child>>
  /** The latest activity of one session, read again on each activity tick while the calling component lives. */
  readonly activity: (sessionID: string) => Accessor<ReadonlyArray<Line>>
  /** Every harness session of the root, with its unit, read again on each session tick. */
  readonly all: () => Accessor<ReadonlyArray<Harness>>
}

const HARNESS_TITLE = /^(\S+) (builder|verifier|reviewer)( \(again\))?$/

/** The harness session a session is, from its title (`T1.4 builder`); none for any other session. */
export const harnessOf = (session: {
  readonly id: string
  readonly title: string
  readonly time: { readonly created: number; readonly updated: number }
  readonly tokens?: { readonly input: number; readonly output: number; readonly reasoning: number }
  readonly cost?: number
}): ReadonlyArray<Harness> => {
  const match = HARNESS_TITLE.exec(session.title)
  return match
    ? [
        {
          id: session.id,
          unit: match[1],
          role: match[2],
          again: Boolean(match[3]),
          created: session.time.created,
          updated: session.time.updated,
          // Cache reads and writes are not counted (EXPERIENCE "Run usage").
          tokens: (session.tokens?.input ?? 0) + (session.tokens?.output ?? 0) + (session.tokens?.reasoning ?? 0),
          cost: session.cost ?? 0,
        },
      ]
    : []
}

/**
 * The child sessions of the root session the developer is looking at, read through the SDK on the view's cadences
 * (AD-16): the session list on each `sessions` tick (2 s), a session's activity on each `activity` tick (1.5 s). The
 * peek is telemetry: a failed read keeps what is on screen.
 */
export function liveSessions(api: TuiPluginApi, view: View): Sessions {
  // Keyed by a string, so only a new root or a new tick reads again, not every snapshot of the view.
  const [all] = createResource(
    () => `${view.ticks().sessions}\n${view.root()}`,
    (key, info): Promise<ReadonlyArray<Harness>> => {
      const root = key.slice(key.indexOf("\n") + 1)
      // No root yet (the developer has not opened a session): no call, an empty list.
      return Effect.runPromise(
        root
          ? Effect.tryPromise(() => api.client.session.children({ sessionID: root })).pipe(
              Effect.map((result): ReadonlyArray<Harness> => (result.data ?? []).flatMap(harnessOf)),
              Effect.orElseSucceed(() => info.value ?? []),
            )
          : Effect.succeed([]),
      )
    },
    { initialValue: [] },
  )
  return {
    all: () => all,
    children: (unit) => createMemo(() => all().filter((item) => item.unit === unit)),
    activity: (sessionID) => {
      const [activity] = createResource(
        () => view.ticks().activity,
        (_tick, info): Promise<ReadonlyArray<Line>> =>
          Effect.runPromise(
            Effect.tryPromise(() => api.client.session.messages({ sessionID, limit: 8 })).pipe(
              Effect.map((result): ReadonlyArray<Line> => (result.data ?? []).flatMap((message) => message.parts.flatMap(lines))),
              Effect.orElseSucceed(() => info.value ?? []),
            ),
          ),
        { initialValue: [] },
      )
      return activity
    },
  }
}

const TOOL_GLYPH: Record<string, string> = { pending: "·", running: "◐", completed: "›", error: "✗" }
const TOOL_TONE: Record<string, Tone> = { pending: "idle", running: "active", completed: "idle", error: "bad" }

/** The lines one message part contributes: a tool call, each verdict, the ready request, or the first line of text. */
export function lines(part: Part): Line[] {
  if (part.type === "text") {
    const text = part.text.trim().split("\n")[0]
    return text ? [{ glyph: "“", tone: "idle", text }] : []
  }
  if (part.type !== "tool") return []
  const input = part.state.input
  if (part.tool === "verdict" && Array.isArray(input.verdicts))
    return input.verdicts.flatMap((item: { id?: unknown; verdict?: unknown; reason?: unknown }) =>
      typeof item.id === "string" && typeof item.verdict === "string"
        ? [
            {
              glyph: glyph(item.verdict),
              tone: tone(item.verdict),
              text: `${item.id} ${item.verdict}${typeof item.reason === "string" && item.reason ? ` — ${item.reason}` : ""}`,
            },
          ]
        : [],
    )
  if (part.tool === "task_ready")
    return [{ glyph: "◆", tone: "pass", text: `task_ready${typeof input.summary === "string" ? `: ${input.summary}` : ""}` }]
  const title = "title" in part.state && part.state.title ? part.state.title : describe(input)
  return [
    {
      glyph: TOOL_GLYPH[part.state.status] ?? "·",
      tone: TOOL_TONE[part.state.status] ?? "idle",
      text: `${part.tool} ${title.split("\n")[0]}`,
    },
  ]
}

const describe = (input: Record<string, unknown>) =>
  [input.command, input.filePath, input.path, input.pattern, input.description].find(
    (value): value is string => typeof value === "string",
  ) ?? ""

/**
 * The BUILDER heading's paragraphs (EXPERIENCE "Peek BUILDER heading"; D19, D21): a blocked task's reason in the
 * warning tone; a waiting task's wait sentences; else the state, "attempt N" and the duration, then a reason in the
 * error tone with the `dead` tag and muted without it. A blocked or waiting task's attempt and duration follow.
 */
export const builderHeading = (status: Status, id: string, liveness: Liveness, now: number): ReadonlyArray<Piece> => {
  const task = status.tasks[id]
  if (!task) return []
  const meta = [task.attempts > 0 ? `attempt ${task.attempts}` : "", durationOf(task, status.run, liveness, now)].filter(
    Boolean,
  )
  const after: ReadonlyArray<Piece> = meta.length > 0 ? [{ text: meta.join(" · "), tone: "text" }] : []
  if (tagged(task, "blocked")) return [{ text: task.reason ?? label(task.state), tone: "warning" }, ...after]
  // A waiting task with no wait sentence left (an outside id trusted since) falls back to its state line.
  const waits = tagged(task, "waiting") ? waitSentences(status, task) : []
  if (waits.length > 0) return [...waits, ...after]
  return [
    { text: [label(task.state), ...meta].join(" · "), tone: "text" },
    ...(task.reason ? [{ text: task.reason, tone: tagged(task, "dead") ? ("bad" as const) : ("muted" as const) }] : []),
  ]
}

/**
 * A task's details: what its builder did, what its proofs found, what its verifier decided. `width` is the outer
 * width; `lines` is how many lines each section shows. The double accent border and the In the Flow title are the
 * distinction from opencode's own subagent rows.
 */
export function Peek(props: {
  theme: Accessor<TuiThemeCurrent>
  view: View
  sessions: Sessions
  unit: string
  width: number
  lines: number
}) {
  const inner = () => Math.max(10, props.width - 4)
  const children = props.sessions.children(props.unit)
  const builder = createMemo(() => children().findLast((child) => child.role === "builder"))
  const verifier = createMemo(() => children().findLast((child) => child.role !== "builder"))
  // By id, so a read that returns the same session does not remount its activity.
  const builderID = createMemo(() => builder()?.id)
  const verifierID = createMemo(() => verifier()?.id)
  const task = createMemo(() => props.view.status()?.tasks[props.unit])
  const proofs = createMemo(() => {
    const status = props.view.status()
    return status ? obligationsOf(status, props.unit) : []
  })
  const open = createMemo(() => proofs().toSorted(bySeverity))
  // The heading's lines: each paragraph wrapped under the heading text, 9 cells in, with no line limit.
  const heading = createMemo(() => {
    const status = props.view.status()
    const pieces = status ? builderHeading(status, props.unit, props.view.liveness(), props.view.now()) : []
    return pieces.flatMap((piece) => wrap(piece.text, inner() - 9).map((text) => ({ ...piece, text })))
  })
  // The builder's activity lines shrink first to make room for the heading's lines.
  const activityLines = () => Math.max(1, props.lines - Math.max(0, heading().length - 1))
  // A task that ended without starting has no sessions.
  const missing = () => {
    const current = task()
    return current?.endedAt !== undefined && current.startedAt === undefined ? ": the task did not start" : " yet"
  }
  // opentui drops a border title that does not fit, so a narrow panel gets the short one; both say read-only.
  const title = () =>
    props.width >= 48 ? ` ${MARK} · ${props.unit} details · read-only ` : ` ◆ ${props.unit} details · read-only `

  return (
    <box
      border
      borderStyle="double"
      borderColor={props.theme().accent}
      title={title()}
      width={props.width}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      alignSelf="flex-start"
    >
      <For each={heading().length > 0 ? heading() : [{ text: "", tone: "text" as const }]}>
        {(line, index) => (
          <text wrapMode="none">
            <b>
              <span style={{ fg: props.theme().accent }}>{index() === 0 ? "BUILDER".padEnd(9) : " ".repeat(9)}</span>
            </b>
            <span style={{ fg: pieceColor(props.theme(), line) }}>{line.text}</span>
          </text>
        )}
      </For>
      <Show
        when={builderID()}
        keyed
        fallback={<Muted theme={props.theme} text={`no builder session${missing()}`} width={inner()} />}
      >
        {(id) => (
          <Activity theme={props.theme} sessions={props.sessions} sessionID={id} width={inner()} lines={activityLines()} />
        )}
      </Show>
      <Heading theme={props.theme} name="PROOFS" text={proofText()} width={inner()} />
      <For each={open().slice(0, props.lines)}>
        {(item) => (
          <text fg={stateColor(props.theme(), item.state)} wrapMode="none">
            {cut(`  ${glyph(item.state)} ${item.local} ${label(item.state)}${item.reason ? ` — ${item.reason}` : ""}`, inner())}
          </text>
        )}
      </For>
      <Heading theme={props.theme} name="VERIFIER" text={verifierText()} width={inner()} />
      <Show
        when={verifierID()}
        keyed
        fallback={<Muted theme={props.theme} text={`no verifier session${missing()}`} width={inner()} />}
      >
        {(id) => (
          <Activity theme={props.theme} sessions={props.sessions} sessionID={id} width={inner()} lines={props.lines} />
        )}
      </Show>
    </box>
  )

  // A parent task is judged by a reviewer; a verifier asked a second time is marked.
  function verifierText() {
    const child = verifier()
    if (!child) return ""
    return [child.role === "reviewer" ? "parent review" : "", child.again ? "second try" : ""].filter(Boolean).join(" · ")
  }

  function proofText() {
    const list = proofs()
    const trusted = list.filter((item) => item.state === "trusted").length
    const failed = list.filter((item) => tone(item.state) === "bad").length
    return `${list.length} obligations · ${trusted} trusted${failed ? ` · ${failed} failed` : ""}`
  }
}

function Heading(props: { theme: Accessor<TuiThemeCurrent>; name: string; text: string; width: number }) {
  return (
    <text wrapMode="none">
      <b>
        <span style={{ fg: props.theme().accent }}>{props.name.padEnd(9)}</span>
      </b>
      <span style={{ fg: props.theme().text }}>{cut(props.text, props.width - 9)}</span>
    </text>
  )
}

function Muted(props: { theme: Accessor<TuiThemeCurrent>; text: string; width: number }) {
  return (
    <text fg={props.theme().textMuted} wrapMode="none">
      {cut(`  ${props.text}`, props.width)}
    </text>
  )
}

function Activity(props: {
  theme: Accessor<TuiThemeCurrent>
  sessions: Sessions
  sessionID: string
  width: number
  lines: number
}) {
  const activity = props.sessions.activity(props.sessionID)
  return (
    <Show when={activity().length > 0} fallback={<Muted theme={props.theme} text="no activity yet" width={props.width} />}>
      <For each={activity().slice(-props.lines)}>
        {(line) => (
          <text fg={color(props.theme(), line.tone)} wrapMode="none">
            {cut(`  ${line.glyph} ${line.text}`, props.width)}
          </text>
        )}
      </For>
    </Show>
  )
}
