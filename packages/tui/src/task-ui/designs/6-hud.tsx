// Design 6, HUD: a small floating panel in the top-right corner over every screen, like an instrument; the peek
// floats out under it.
import { Show } from "solid-js"
import { Peek } from "../peek"
import { SharedRegion } from "../shared"
import { bar, counts, cut, elapsed, glyph, stateColor } from "../store"
import { Brand, runText, stateText, trustedText, type Ctx, type ViewProps } from "../ui"
import { span } from "./5-gantt"

const WIDTH = 44
const PEEK = 64
/** The rows the HUD gives the shared region; it scrolls beyond them. */
const REGION = 14

export function HudView(props: ViewProps) {
  const selected = () => props.view.rows().find((row) => row.id === props.view.selected())
  const inner = WIDTH - 4
  return (
    <Show when={props.view.status()}>
      {(status) => (
        <box flexDirection="column" alignItems="flex-end">
          <box
            border
            borderStyle="double"
            borderColor={props.theme().accent}
            backgroundColor={props.theme().backgroundPanel}
            width={WIDTH}
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            onMouseDown={props.view.toggleExpanded}
          >
            <box flexDirection="row">
              <text wrapMode="none">
                <Brand theme={props.theme} />
              </text>
              <box flexGrow={1} />
              <text fg={props.theme().text} wrapMode="none">
                {runText(status())}
              </text>
            </box>
            <text fg={props.theme().success} wrapMode="none">
              {`${bar(counts(status()).trusted, counts(status()).total, inner - 13)} ${trustedText(status())}`}
            </text>
            <Show when={selected()}>
              {(row) => (
                <text fg={stateColor(props.theme(), row().task.state)} wrapMode="none">
                  {cut(`${props.view.expanded() ? "▾" : "▸"} ${glyph(row().task.state)} ${row().id} ${stateText(row())}`, inner)}
                </text>
              )}
            </Show>
            <text fg={props.theme().textMuted} wrapMode="none">
              {`elapsed ${elapsed(span(status(), props.view.now()).end - span(status(), props.view.now()).start)}`}
            </text>
          </box>
          <Show when={props.view.expanded() && props.view.selected()} keyed>
            {(unit) => (
              <box backgroundColor={props.theme().backgroundPanel}>
                <Peek theme={props.theme} view={props.view} sessions={props.sessions} unit={unit} width={PEEK} lines={5} />
              </box>
            )}
          </Show>
          {/* The shared region under the peek; the mouse wheel scrolls it (the prompt keeps the keys). */}
          <Show when={props.view.expanded()}>
            <box backgroundColor={props.theme().backgroundPanel} paddingLeft={1} paddingRight={1}>
              <SharedRegion theme={props.theme} view={props.view} width={PEEK - 2} height={REGION} />
            </box>
          </Show>
        </box>
      )}
    </Show>
  )
}

export function registerHud(ctx: Ctx) {
  ctx.api.slots.register({
    order: 50,
    slots: {
      app() {
        return (
          <Show when={ctx.active()}>
            <box position="absolute" top={1} right={2} zIndex={100}>
              <HudView theme={ctx.theme} view={ctx.view} sessions={ctx.sessions} leader={ctx.leader} />
            </box>
          </Show>
        )
      },
    },
  })
}
