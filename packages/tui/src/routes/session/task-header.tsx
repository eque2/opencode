// The run header of a /task run in the transcript (D17, AD-13): drawn from its message's metadata, which the harness
// writes on the header's text part, and never from the text. Each message reads its own metadata, so an older header in
// the scrollback keeps its own title when a later run starts.
import type { RGBA } from "@opentui/core"
import { Option, Schema } from "effect"
import { Show } from "solid-js"

const Named = Schema.Struct({ id: Schema.String, title: Schema.String })

const Header = Schema.Struct({ spec: Named, task: Schema.optional(Named), leftOut: Schema.Array(Schema.String) })
export type Header = typeof Header.Type

const Metadata = Schema.Struct({ taskHarness: Schema.Struct({ header: Header }) })

/** The header a text part's metadata holds; none for any other metadata. */
export const headerOf = (metadata: unknown) =>
  Option.map(Schema.decodeUnknownOption(Metadata)(metadata), (value) => value.taskHarness.header)

type TextLike = {
  readonly type: string
  readonly text?: unknown
  readonly synthetic?: boolean
  readonly metadata?: unknown
}

/** A user message's run header, if one of its text parts carries it, and its other non-empty, non-synthetic texts. */
export const splitHeader = (parts: ReadonlyArray<TextLike>) => {
  const texts = parts.flatMap((part) =>
    part.type === "text" && !part.synthetic && typeof part.text === "string" && part.text
      ? [{ part, text: part.text }]
      : [],
  )
  const found = texts.flatMap((item) =>
    Option.toArray(headerOf(item.part.metadata)).map((header) => ({ item, header })),
  )[0]
  return {
    header: Option.fromNullishOr(found?.header),
    texts: texts.filter((item) => item !== found?.item).map((item) => item.text),
  }
}

export type Split = ReturnType<typeof splitHeader>

/** Whether a user message has a body: its header, or any text of its own. */
export const shows = (split: Split) => Option.isSome(split.header) || split.texts.length > 0

/** A user message's body: the run header, drawn from its metadata, then its other texts. */
export function MessageBody(props: { theme: { readonly text: RGBA; readonly textMuted: RGBA }; split: Split }) {
  const text = () => props.split.texts.join("\n\n")
  return (
    <>
      <Show when={Option.getOrUndefined(props.split.header)}>
        {(header) => <TaskHeader theme={props.theme} header={header()} />}
      </Show>
      <Show when={text()}>
        <text fg={props.theme.text}>{text()}</text>
      </Show>
    </>
  )
}

/**
 * "Implementing spec" muted and the spec title bold; a subtree run: "Implementing", the task bold, "from spec", the
 * spec title bold. An empty title reads as the spec id. The left-out scenarios follow on a muted line. It wraps at
 * word boundaries and never cuts the title.
 */
export function TaskHeader(props: { theme: { readonly text: RGBA; readonly textMuted: RGBA }; header: Header }) {
  const title = () => props.header.spec.title || props.header.spec.id
  return (
    <box flexDirection="column">
      <text fg={props.theme.textMuted} wrapMode="word">
        {props.header.task ? "Implementing " : "Implementing spec "}
        <Show when={props.header.task}>
          {(task) => (
            <>
              <b>
                <span style={{ fg: props.theme.text }}>{`${task().id} ${task().title}`}</span>
              </b>
              {" from spec "}
            </>
          )}
        </Show>
        <b>
          <span style={{ fg: props.theme.text }}>{title()}</span>
        </b>
      </text>
      <Show when={props.header.leftOut.length > 0}>
        <text fg={props.theme.textMuted} wrapMode="word">
          {`Left out: ${props.header.leftOut.join(", ")} — they need tasks outside this run.`}
        </text>
      </Show>
    </box>
  )
}
