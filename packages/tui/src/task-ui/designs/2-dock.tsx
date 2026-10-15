// Design 2, Dock: one status strip across the bottom of every screen; the peek opens above it, full width.
import { Option } from "effect"
import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Peek } from "../peek"
import { SharedRegion, outsideWaits, regionRows } from "../shared"
import { OLDER_LINE, bar, costText, counts, glyph, older, runUsage, stateColor, type Status } from "../store"
import { Brand, moving, runText, stateText, stoppedText, trustedText, type Ctx, type ViewProps } from "../ui"

/** From this width the expanded Dock puts the Peek (half the width, at most 72 cells) left of the shared region. */
const SIDE_BY_SIDE = 110
const PEEK_HALF = 72
/** The fewest rows the shared region keeps. */
const REGION_MIN = 8

/** The Dock strip's segments after the trusted count, as text: the run warning and the outside wait (UI16, UI5). */
const alerts = (status: Status) => {
  const waits = outsideWaits(status)
  return [
    ...(status.run.warning ? ["! spec"] : []),
    ...(waits.length > 0 ? [`/task trust ${waits[0]}${waits.length > 1 ? ` +${waits.length - 1}` : ""}`] : []),
  ]
}

export function DockView(props: ViewProps & { width: number; height?: number }) {
  const toggle = (id: string) => (props.view.selected() === id ? props.view.toggleExpanded() : props.view.select(id))
  const selected = () => props.view.rows().find((row) => row.id === props.view.selected())
  const divider = () => <text fg={props.theme().textMuted}>│</text>
  const usage = () => runUsage(props.sessions.all()())
  // What the strip shows (EXPERIENCE "Responsive"): the selected task drops first, then the cost, before the chips are
  // cut at the edge. Each segment after the first costs its text and a 3-cell divider.
  const fits = () => {
    const status = props.view.status()
    if (!status) return { selected: false, cost: false }
    const trusted = `${bar(counts(status).trusted, counts(status).total, 6)} ${trustedText(status)}${stoppedText(status)}`
    const chips = props.view.rows().reduce((sum, row) => sum + `${glyph(row.task.state)} ${row.id}`.length + 1, -1)
    const fixed = [
      "◆ In the Flow",
      runText(status),
      ...alerts(status),
      trusted,
      ...(older(status) ? [OLDER_LINE] : []),
    ].reduce((sum, text) => sum + text.length + 3, 2 - 3)
    const cost = Option.match(usage(), { onNone: () => 0, onSome: (spent) => costText(spent.cost).length + 3 })
    const row = selected()
    const task = row ? `${props.view.expanded() ? "▾" : "▸"} ${row.id} ${stateText(row)}`.length + 3 : 0
    return {
      selected: fixed + cost + chips + 3 + task <= props.width,
      cost: fixed + cost + chips + 3 <= props.width,
    }
  }
  // At most half the terminal: side by side from 110 cells, else the Peek over the region.
  const budget = () => Math.floor((props.height ?? 40) / 2)
  const side = () => props.width >= SIDE_BY_SIDE
  const peekWidth = () => (side() ? Math.min(PEEK_HALF, Math.floor(props.width / 2)) : props.width)
  const regionWidth = () => (side() ? props.width - peekWidth() - 2 : props.width - 2)
  const lines = () => (side() ? Math.max(1, Math.min(4, Math.floor((budget() - 5) / 3))) : budget() >= 17 + REGION_MIN ? 4 : 1)
  const region = () => {
    const status = props.view.status()
    const rows = status ? regionRows(status, regionWidth()) : 0
    return side() ? Math.min(rows, budget()) : Math.min(rows, Math.max(REGION_MIN, budget() - (5 + 3 * lines())))
  }
  return (
    <Show when={props.view.status()}>
      {(status) => (
        <box flexDirection="column" width={props.width} flexShrink={0}>
          <Show when={props.view.expanded()}>
            <box flexDirection={side() ? "row" : "column"} flexShrink={0}>
              <Show when={props.view.selected()} keyed>
                {(unit) => (
                  <Peek
                    theme={props.theme}
                    view={props.view}
                    sessions={props.sessions}
                    unit={unit}
                    width={peekWidth()}
                    lines={lines()}
                  />
                )}
              </Show>
              {/* The shared region beside or above the strip; the mouse wheel scrolls it (the prompt keeps the keys). */}
              <box paddingLeft={1} paddingRight={1} backgroundColor={props.theme().backgroundPanel}>
                <SharedRegion theme={props.theme} view={props.view} width={regionWidth()} height={region()} />
              </box>
            </box>
          </Show>
          <box
            flexDirection="row"
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            width={props.width}
            backgroundColor={props.theme().backgroundPanel}
            overflow="hidden"
          >
            <Brand theme={props.theme} moving={moving(props)} />
            {divider()}
            <text fg={props.theme().text} wrapMode="none" flexShrink={0}>
              {runText(status())}
            </text>
            <For each={alerts(status())}>
              {(alert) => (
                <>
                  {divider()}
                  <text fg={props.theme().warning} wrapMode="none" flexShrink={0}>
                    {alert}
                  </text>
                </>
              )}
            </For>
            {divider()}
            <text wrapMode="none" flexShrink={0}>
              <span style={{ fg: props.theme().success }}>
                {`${bar(counts(status()).trusted, counts(status()).total, 6)} ${trustedText(status())}`}
              </span>
              <span style={{ fg: props.theme().error }}>{stoppedText(status())}</span>
            </text>
            <Show when={older(status())}>
              {divider()}
              <text fg={props.theme().textMuted} wrapMode="none" flexShrink={0}>
                {OLDER_LINE}
              </text>
            </Show>
            <Show when={fits().cost && Option.getOrUndefined(usage())}>
              {(spent) => (
                <>
                  {divider()}
                  <text fg={props.theme().textMuted} wrapMode="none" flexShrink={0}>
                    {costText(spent().cost)}
                  </text>
                </>
              )}
            </Show>
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
            <Show when={fits().selected && selected()}>
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
              motion={ctx.motion}
              width={dimensions().width}
              height={dimensions().height}
            />
          </Show>
        )
      },
    },
  })
}
