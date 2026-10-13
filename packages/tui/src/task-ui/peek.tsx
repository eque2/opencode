// The peek: what the harness's builder did for one task, what its proofs found, and what the verifier decided. Every
// design opens it on demand; it is read-only and framed so that it never looks like an ordinary subagent task.
import type { Part } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { Effect } from "effect"
import { For, Show, createMemo, type Accessor } from "solid-js"
import { bySeverity, color, cut, glyph, label, obligationsOf, poll, stateColor, tone, type Tone, type View } from "./store"

/** A builder, verifier or reviewer session the harness made for a unit (`T1.4 builder`, `S3 verifier (again)`). */
export type Child = { readonly id: string; readonly role: string; readonly again: boolean; readonly created: number }

/** One line of a session's latest activity. */
export type Line = { readonly glyph: string; readonly tone: Tone; readonly text: string }

/** Where the peek reads sessions from: the live server, or fixed data in a test. */
export type Sessions = {
  /** The harness sessions of `unit`, oldest first. Polls while the calling component lives. */
  readonly children: (unit: string) => Accessor<ReadonlyArray<Child>>
  /** The latest activity of one session. Polls while the calling component lives. */
  readonly activity: (sessionID: string) => Accessor<ReadonlyArray<Line>>
}

/**
 * The child sessions of the root session the developer is looking at, read through the SDK. The peek is telemetry:
 * a failed read keeps what is on screen.
 */
export function liveSessions(api: TuiPluginApi, root: Accessor<string>): Sessions {
  return {
    children: (unit) =>
      poll<ReadonlyArray<Child>>(
        [],
        "2 seconds",
        // No root yet (the developer has not opened a session): no call, an empty list.
        Effect.suspend((): Effect.Effect<ReadonlyArray<Child>, unknown> =>
          root()
            ? Effect.tryPromise(() => api.client.session.children({ sessionID: root() })).pipe(
                Effect.map((result) =>
                  (result.data ?? []).flatMap((session) => {
                    const match = /^(\S+) (builder|verifier|reviewer)( \(again\))?$/.exec(session.title)
                    return match?.[1] === unit
                      ? [{ id: session.id, role: match[2], again: Boolean(match[3]), created: session.time.created }]
                      : []
                  }),
                ),
              )
            : Effect.succeed([]),
        ),
      ),
    activity: (sessionID) =>
      poll<ReadonlyArray<Line>>(
        [],
        "1500 millis",
        Effect.tryPromise(() => api.client.session.messages({ sessionID, limit: 8 })).pipe(
          Effect.map((result) => (result.data ?? []).flatMap((message) => message.parts.flatMap(lines))),
        ),
      ),
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
 * The peek for one task. `width` is the outer width; `lines` is how many activity lines each session shows.
 * The double accent border and the HARNESS title are the distinction from opencode's own subagent rows.
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
  // By id, so a poll that returns the same session does not remount its activity.
  const builderID = createMemo(() => builder()?.id)
  const verifierID = createMemo(() => verifier()?.id)
  const task = createMemo(() => props.view.status()?.tasks[props.unit])
  const proofs = createMemo(() => {
    const status = props.view.status()
    return status ? obligationsOf(status, props.unit) : []
  })
  const open = createMemo(() => proofs().toSorted(bySeverity))
  // opentui drops a border title that does not fit, so a narrow peek gets the short one; both say read-only.
  const title = () =>
    props.width >= 48 ? ` ◆ HARNESS · peek ${props.unit} · read-only ` : ` ◆ HARNESS peek ${props.unit} read-only `

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
      <Heading theme={props.theme} name="BUILD" text={builderText()} width={inner()} />
      <Show
        when={builderID()}
        keyed
        fallback={<Muted theme={props.theme} text="no builder yet" width={inner()} />}
      >
        {(id) => (
          <Activity theme={props.theme} sessions={props.sessions} sessionID={id} width={inner()} lines={props.lines} />
        )}
      </Show>
      <Heading theme={props.theme} name="PROOF" text={proofText()} width={inner()} />
      <For each={open().slice(0, props.lines)}>
        {(item) => (
          <text fg={stateColor(props.theme(), item.state)} wrapMode="none">
            {cut(`  ${glyph(item.state)} ${item.local} ${label(item.state)}${item.reason ? ` — ${item.reason}` : ""}`, inner())}
          </text>
        )}
      </For>
      <Heading theme={props.theme} name="VERIFY" text={verifierText()} width={inner()} />
      <Show
        when={verifierID()}
        keyed
        fallback={<Muted theme={props.theme} text="no verifier yet" width={inner()} />}
      >
        {(id) => (
          <Activity theme={props.theme} sessions={props.sessions} sessionID={id} width={inner()} lines={props.lines} />
        )}
      </Show>
    </box>
  )

  function builderText() {
    const current = task()
    const child = builder()
    if (!child) return current ? label(current.state) : ""
    return `${sessionText(child)}${current ? ` · attempt ${current.attempts} · ${label(current.state)}` : ""}`
  }

  function verifierText() {
    const child = verifier()
    return child ? sessionText(child) : ""
  }

  function proofText() {
    const list = proofs()
    const trusted = list.filter((item) => item.state === "trusted").length
    const failed = list.filter((item) => tone(item.state) === "bad").length
    return `${list.length} obligations · ${trusted} trusted${failed ? ` · ${failed} failed` : ""}`
  }

  function sessionText(child: Child) {
    return `${props.unit} ${child.role}${child.again ? " (again)" : ""}`
  }
}

function Heading(props: { theme: Accessor<TuiThemeCurrent>; name: string; text: string; width: number }) {
  return (
    <text wrapMode="none">
      <b>
        <span style={{ fg: props.theme().accent }}>{props.name.padEnd(7)}</span>
      </b>
      <span style={{ fg: props.theme().text }}>{cut(props.text, props.width - 7)}</span>
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
