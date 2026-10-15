// Design 2, Dock: one status strip across the bottom of every screen; the peek opens above it, full width.
import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Peek } from "../peek"
import { SharedRegion } from "../shared"
import { bar, counts, glyph, stateColor } from "../store"
import { Brand, runText, stateText, trustedText, type Ctx, type ViewProps } from "../ui"

/** The rows the Dock gives the shared region; it scrolls beyond them. */
const REGION = 10

export function DockView(props: ViewProps & { width: number }) {
  const toggle = (id: string) => (props.view.selected() === id ? props.view.toggleExpanded() : props.view.select(id))
  const selected = () => props.view.rows().find((row) => row.id === props.view.selected())
  const divider = () => <text fg={props.theme().textMuted}>│</text>
  return (
    <Show when={props.view.status()}>
      {(status) => (
        <box flexDirection="column" width={props.width} flexShrink={0}>
          <Show when={props.view.expanded() && props.view.selected()} keyed>
            {(unit) => (
              <Peek theme={props.theme} view={props.view} sessions={props.sessions} unit={unit} width={props.width} lines={4} />
            )}
          </Show>
          {/* The shared region above the strip; the mouse wheel scrolls it (the prompt keeps the keys). */}
          <Show when={props.view.expanded()}>
            <box paddingLeft={1} paddingRight={1} backgroundColor={props.theme().backgroundPanel}>
              <SharedRegion theme={props.theme} view={props.view} width={props.width - 2} height={REGION} />
            </box>
          </Show>
          <box
            flexDirection="row"
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            width={props.width}
            backgroundColor={props.theme().backgroundPanel}
          >
            <text wrapMode="none" flexShrink={0}>
              <Brand theme={props.theme} />
            </text>
            {divider()}
            <text fg={props.theme().text} wrapMode="none" flexShrink={0}>
              {runText(status())}
            </text>
            {divider()}
            <text fg={props.theme().success} wrapMode="none" flexShrink={0}>
              {`${bar(counts(status()).trusted, counts(status()).total, 6)} ${trustedText(status())}`}
            </text>
            {divider()}
            <For each={props.view.rows()}>
              {(row) => (
                <text
                  fg={stateColor(props.theme(), row.task.state)}
                  bg={row.id === props.view.selected() ? props.theme().backgroundElement : "transparent"}
                  wrapMode="none"
                  flexShrink={0}
                  onMouseDown={() => toggle(row.id)}
                >
                  {`${glyph(row.task.state)} ${row.id}`}
                </text>
              )}
            </For>
            <Show when={selected()}>
              {(row) => (
                <>
                  {divider()}
                  <text fg={stateColor(props.theme(), row().task.state)} wrapMode="none" flexShrink={1}>
                    {`${props.view.expanded() ? "▾" : "▸"} ${row().id} ${stateText(row())}`}
                  </text>
                </>
              )}
            </Show>
          </box>
        </box>
      )}
    </Show>
  )
}

export function registerDock(ctx: Ctx) {
  ctx.api.slots.register({
    order: 50,
    slots: {
      app_bottom() {
        const dimensions = useTerminalDimensions()
        return (
          <Show when={ctx.active()}>
            <DockView
              theme={ctx.theme}
              view={ctx.view}
              sessions={ctx.sessions}
              leader={ctx.leader}
              width={dimensions().width}
            />
          </Show>
        )
      },
    },
  })
}
