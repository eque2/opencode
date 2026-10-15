// Design 6, HUD: a small floating panel in the top-right corner over every screen, like an instrument; the peek
// floats out under it.
import { Option } from "effect"
import { For, Show } from "solid-js"
import { Peek } from "../peek"
import { SharedRegion, outsideCollapsed, warningOf, wrap } from "../shared"
import {
  bar,
  costText,
  counts,
  cut,
  durationOf,
  elapsed,
  glyph,
  runSpan,
  runUsage,
  stateColor,
  tokensText,
  type Row,
} from "../store"
import {
  Brand,
  OlderLine,
  TrustedCount,
  moving,
  runText,
  stateText,
  stoppedText,
  trustedText,
  type Ctx,
  type ViewProps,
} from "../ui"

const WIDTH = 44
const PEEK = 64
/** The rows the HUD gives the shared region; it scrolls beyond them. */
const REGION = 14

/**
 * The selected-task line (EXPERIENCE "HUD selected-task line"): the mark, the glyph, the id, the state text and the
 * duration; the state text is cut first, the duration never.
 */
export const hudLine = (row: Row, duration: string, expanded: boolean, width: number) => {
  const lead = `${expanded ? "▾" : "▸"} ${glyph(row.task.state)} ${row.id} `
  const tail = duration ? ` · ${duration}` : ""
  return `${lead}${cut(stateText(row), width - lead.length - tail.length)}${tail}`
}

export function HudView(props: ViewProps) {
  const selected = () => props.view.rows().find((row) => row.id === props.view.selected())
  const inner = WIDTH - 4
  // "elapsed 24m 10s · 1.4M tokens · $2.31": the tokens drop first when the line does not fit (EXPERIENCE "Run usage").
  const elapsedLine = () => {
    const status = props.view.status()
    if (!status) return ""
    const range = runSpan(status, props.view.liveness(), props.view.now())
    const time = `elapsed ${elapsed(range.end - range.start)}`
    return Option.match(runUsage(props.sessions.all()()), {
      onNone: () => time,
      onSome: (usage) => {
        const full = `${time} · ${tokensText(usage.tokens)} · ${costText(usage.cost)}`
        return full.length <= inner ? full : cut(`${time} · ${costText(usage.cost)}`, inner)
      },
    })
  }
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
              <Brand theme={props.theme} moving={moving(props)} />
              <box flexGrow={1} />
              <text fg={props.theme().text} wrapMode="none">
                {runText(status())}
              </text>
            </box>
            {/* The bar shrinks by the width of the stopped count, so the line keeps the panel's width. */}
            <TrustedCount
              theme={props.theme}
              status={status()}
              bar={bar(
                counts(status()).trusted,
                counts(status()).total,
                inner - 1 - trustedText(status()).length - stoppedText(status()).length,
              )}
            />
            <OlderLine theme={props.theme} status={status()} width={inner} />
            <Show when={selected()}>
              {(row) => (
                <text fg={stateColor(props.theme(), row().task.state)} wrapMode="none">
                  {hudLine(
                    row(),
                    durationOf(row().task, status().run, props.view.liveness(), props.view.now()),
                    props.view.expanded(),
                    inner,
                  )}
                </text>
              )}
            </Show>
            <text fg={props.theme().textMuted} wrapMode="none">
              {elapsedLine()}
            </text>
            <Show when={warningOf(status())}>
              {(warning) => (
                <text fg={props.theme().warning} wrapMode="none">
                  {cut(warning().head, inner)}
                </text>
              )}
            </Show>
            <For each={wrap(outsideCollapsed(status()), inner)}>
              {(line) => (
                <text fg={props.theme().warning} wrapMode="none">
                  {line}
                </text>
              )}
            </For>
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
              <HudView theme={ctx.theme} view={ctx.view} sessions={ctx.sessions} leader={ctx.leader} motion={ctx.motion} />
            </box>
          </Show>
        )
      },
    },
  })
}
