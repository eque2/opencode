// The run usage (D24, AD-18): the summed tokens and cost of a /task root session's run. The run's sessions are the
// child sessions of the root, the one definition the closing summary uses too; a root is a /task root when it owns a
// harness session. Tokens are input, output and reasoning; cache reads and writes are not counted.
import { Option } from "effect"
import { Locale } from "../util/locale"
import { harnessOf } from "./peek"
import { costText, runUsage } from "./store"

type SessionLike = {
  readonly id: string
  readonly title: string
  readonly parentID?: string
  readonly time: { readonly created: number; readonly updated: number }
  readonly tokens?: { readonly input: number; readonly output: number; readonly reasoning: number }
  readonly cost?: number
}

/** Whether a root's child sessions hold a harness session: the root is a /task root. */
export const isTaskRoot = (children: ReadonlyArray<SessionLike>) =>
  children.some((child) => harnessOf(child).length > 0)

/** The run usage of `root` from the synced sessions: none for another session, and before any child reports tokens. */
export const runOf = (sessions: ReadonlyArray<SessionLike>, root: string) => {
  const children = sessions.filter((item) => item.parentID === root)
  if (!isTaskRoot(children)) return Option.none<{ tokens: number; cost: number }>()
  return runUsage(
    children.map((child) => ({
      tokens: child.tokens ? child.tokens.input + child.tokens.output + child.tokens.reasoning : 0,
      cost: child.cost ?? 0,
    })),
  )
}

/**
 * The prompt footer's usage (EXPERIENCE "Run usage"): the root's own figure, then " · run 1.4M tokens · $2.31". A
 * footer of `room` cells drops the own figure first, then the word "tokens", then shows the cost alone.
 */
export const footerText = (
  own: Option.Option<string>,
  run: Option.Option<{ readonly tokens: number; readonly cost: number }>,
  room: number,
) =>
  Option.match(run, {
    onNone: () => own,
    onSome: (usage) => {
      const cost = costText(usage.cost)
      const forms = [
        ...Option.toArray(
          Option.map(own, (figure) => `${figure} · run ${Locale.number(usage.tokens)} tokens · ${cost}`),
        ),
        `run ${Locale.number(usage.tokens)} tokens · ${cost}`,
        `run ${Locale.number(usage.tokens)} · ${cost}`,
        `run ${cost}`,
      ]
      return Option.some(forms.find((form) => form.length <= room) ?? `run ${cost}`)
    },
  })

/**
 * The prompt footer's text for a session (D24): today's figure (the context, then the cost), then the run's usage when
 * the session is a /task root. The room is the prompt box's width less the sidebar (above 120 cells), 4 cells of
 * padding, the commands hint and a 2-cell gap.
 */
export const promptFooter = (input: {
  readonly sessionID: string | undefined
  readonly own: Option.Option<{ readonly context: string; readonly cost: Option.Option<string> }>
  readonly sessions: ReadonlyArray<SessionLike>
  readonly width: number
  readonly shortcut: string | undefined
}) => {
  if (!input.sessionID) return Option.none<string>()
  const own = Option.map(input.own, (item) => [item.context, ...Option.toArray(item.cost)].join(" · "))
  const room = input.width - (input.width > 120 ? 42 : 0) - 4 - `${input.shortcut ?? ""} commands`.length - 2
  return footerText(own, runOf(input.sessions, input.sessionID), room)
}
