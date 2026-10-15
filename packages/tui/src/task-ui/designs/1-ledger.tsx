// Design 1, Ledger: the task tree at the top of the sidebar, always in view, with the peek opening under it.
import { For, Show } from "solid-js"
import { Peek } from "../peek"
import { SharedRegion, regionRows } from "../shared"
import { bar, counts, cut } from "../store"
import {
  Brand,
  OlderLine,
  ReasonLine,
  TaskLine,
  TrustedCount,
  WarningLines,
  moving,
  runText,
  runTitle,
  treePrefix,
  type Ctx,
  type ViewProps,
} from "../ui"

// The sidebar is 42 columns with 2 of padding on each side.
const WIDTH = 38

export function LedgerView(props: ViewProps & { width: number }) {
  const toggle = (id: string) => (props.view.selected() === id ? props.view.toggleExpanded() : props.view.select(id))
  return (
    <Show when={props.view.status()}>
      {(status) => (
        <box flexDirection="column" flexShrink={0} width={props.width}>
          <box flexDirection="row">
            <Brand theme={props.theme} moving={moving(props)} />
            <text fg={props.theme().textMuted} wrapMode="none">
              {` ${runText(status())}`}
            </text>
          </box>
          <text fg={props.theme().textMuted} wrapMode="none">
            {cut(runTitle(status()), props.width)}
          </text>
          <TrustedCount theme={props.theme} status={status()} bar={bar(counts(status()).trusted, counts(status()).total, 6)} />
          <OlderLine theme={props.theme} status={status()} width={props.width} />
          <WarningLines theme={props.theme} status={status()} width={props.width} />
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
          {/* A refused run has no tasks: every reason line shows (UI17); else the one run reason line. */}
          <Show
            when={status().run.state === "refused"}
            fallback={<ReasonLine theme={props.theme} status={status()} width={props.width} />}
          >
            <For each={(status().run.reason ?? "").split("\n").filter(Boolean)}>
              {(line) => (
                <text fg={props.theme().error} wrapMode="none">
                  {cut(line, props.width)}
                </text>
              )}
            </For>
          </Show>
          <Show when={props.view.expanded() && props.view.selected()} keyed>
            {(unit) => (
              <Peek theme={props.theme} view={props.view} sessions={props.sessions} unit={unit} width={props.width} lines={3} />
            )}
          </Show>
          {/* The shared region at its full height: it scrolls with the sidebar. */}
          <Show when={props.view.expanded()}>
            <SharedRegion
              theme={props.theme}
              view={props.view}
              width={props.width}
              height={regionRows(status(), props.width)}
            />
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
            <LedgerView theme={ctx.theme} view={ctx.view} sessions={ctx.sessions} leader={ctx.leader} width={WIDTH} motion={ctx.motion} />
          </Show>
        )
      },
    },
  })
}
