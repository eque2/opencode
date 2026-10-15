import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { For, Show, createMemo } from "solid-js"
import { Effect, Option } from "effect"
import { isTaskRoot, runOf } from "../../task-ui/usage"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: Option.none<number>(),
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Option.some(Math.round((tokens / model.limit.context) * 100)) : Option.none(),
    }
  })

  // A /task root's run (D24): its child sessions summed. Its own three lines show only with its own output, so the
  // zero lines never come back once the closing summary ends the run; any other session keeps them as today.
  const children = createMemo(() => props.api.state.session.children(props.session_id))
  const root = createMemo(() => isTaskRoot(children()))
  const run = createMemo(() => runOf(children(), props.session_id))
  const own = createMemo(() => !root() || state().tokens > 0)

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <Show when={own()}>
        <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
        <text fg={theme().textMuted}>{Option.getOrElse(state().percent, () => 0)}% used</text>
        <text fg={theme().textMuted}>{money.format(cost())} spent</text>
      </Show>
      <For each={Option.match(run(), { onNone: () => [], onSome: (usage) => [usage] })}>
        {(usage) => (
          <>
            <text fg={theme().textMuted}>{usage.tokens.toLocaleString()} tokens in the run</text>
            <text fg={theme().textMuted}>{money.format(usage.cost)} spent in the run</text>
          </>
        )}
      </For>
    </box>
  )
}

const tui: TuiPlugin = (api) =>
  Effect.runPromise(
    Effect.sync(() => {
      api.slots.register({
        order: 100,
        slots: {
          sidebar_content(_ctx, props) {
            return <View api={api} session_id={props.session_id} />
          },
        },
      })
    }),
  )

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
