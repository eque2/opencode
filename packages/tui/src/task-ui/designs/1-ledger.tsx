// Design 1, Ledger: the task tree at the top of the sidebar, always in view, with the peek opening under it.
import { For, Show } from "solid-js"
import { Peek } from "../peek"
import { bar, counts, cut, tone } from "../store"
import { Brand, TaskLine, runText, treePrefix, trustedText, type Ctx, type ViewProps } from "../ui"

// The sidebar is 42 columns with 2 of padding on each side.
const WIDTH = 38

export function LedgerView(props: ViewProps & { width: number }) {
  const toggle = (id: string) => (props.view.selected() === id ? props.view.toggleExpanded() : props.view.select(id))
  return (
    <Show when={props.view.status()}>
      {(status) => (
        <box flexDirection="column" flexShrink={0} width={props.width}>
          <text wrapMode="none">
            <Brand theme={props.theme} />
            <span style={{ fg: props.theme().textMuted }}> {runText(status())}</span>
          </text>
          <text fg={props.theme().textMuted} wrapMode="none">
            {cut(
              `${status().run.spec.split("/").at(-1)} ${bar(counts(status()).trusted, counts(status()).total, 6)} ${trustedText(status())}`,
              props.width,
            )}
          </text>
          <For each={props.view.rows()}>
            {(row) => (
              <TaskLine
                theme={props.theme}
                row={row}
                selected={row.id === props.view.selected()}
                width={props.width}
                prefix={treePrefix(row)}
                suffix={row.id === props.view.selected() ? (props.view.expanded() ? " ▾" : " ▸") : "  "}
                onClick={() => toggle(row.id)}
              />
            )}
          </For>
          <Show when={status().run.reason && tone(status().run.state) !== "good"}>
            <text fg={props.theme().error} wrapMode="word">
              {cut(status().run.reason ?? "", props.width * 3)}
            </text>
          </Show>
          <text fg={props.theme().textMuted} wrapMode="none">
            {cut(`${props.leader} o peek · ${props.leader} j/k task`, props.width)}
          </text>
          <Show when={props.view.expanded() && props.view.selected()} keyed>
            {(unit) => (
              <Peek theme={props.theme} view={props.view} sessions={props.sessions} unit={unit} width={props.width} lines={3} />
            )}
          </Show>
        </box>
      )}
    </Show>
  )
}

export function registerLedger(ctx: Ctx) {
  ctx.api.slots.register({
    order: 50,
    slots: {
      sidebar_content() {
        return (
          <Show when={ctx.active()}>
            <LedgerView theme={ctx.theme} view={ctx.view} sessions={ctx.sessions} leader={ctx.leader} width={WIDTH} />
          </Show>
        )
      },
    },
  })
}
