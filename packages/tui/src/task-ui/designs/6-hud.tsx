// Design 6, HUD: a small floating panel in the top-right corner over every screen, like an instrument; the peek
// floats out under it.
import { Show } from "solid-js"
import { Peek } from "../peek"
import { bar, counts, cut, elapsed, glyph, stateColor } from "../store"
import { Brand, runText, stateText, trustedText, type Ctx, type ViewProps } from "../ui"
import { span } from "./5-gantt"

const WIDTH = 40
const PEEK = 64

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
            onMouseDown={props.view.togglePeek}
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
                  {cut(`${props.view.peek() ? "▾" : "▸"} ${glyph(row().task.state)} ${row().id} ${stateText(row())}`, inner)}
                </text>
              )}
            </Show>
            <text fg={props.theme().textMuted} wrapMode="none">
              {cut(
                `${elapsed(span(status(), props.view.now()).end - span(status(), props.view.now()).start)} · ${props.leader} o peek · ${props.leader} j/k`,
                inner,
              )}
            </text>
          </box>
          <Show when={props.view.peek() && props.view.selected()} keyed>
            {(unit) => (
              <box backgroundColor={props.theme().backgroundPanel}>
                <Peek theme={props.theme} view={props.view} sessions={props.sessions} unit={unit} width={PEEK} lines={5} />
              </box>
            )}
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
