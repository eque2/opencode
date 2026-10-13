// The full-screen frame of designs 3 (Board), 4 (Matrix) and 5 (Gantt): one plugin route, opened with <leader>p from
// a session, closed with esc back to that session. A small prompt-side hint says the view exists.
import { Match, Show, Switch, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Peek } from "../peek"
import { DESIGNS, bar, counts, cut, tone } from "../store"
import { Brand, runText, trustedText, type Ctx, type ViewProps } from "../ui"
import { BoardView } from "./3-board"
import { MatrixView } from "./4-matrix"
import { GanttView } from "./5-gantt"

export const ROUTE = "task-ui"

/** The designs with a full-screen view, and where each opens the peek. */
export const SCREENS: Record<number, "right" | "bottom"> = { 3: "right", 4: "bottom", 5: "bottom" }

const PEEK_RIGHT = 56

export function Screen(props: ViewProps & { width: number; height: number }) {
  const name = () => DESIGNS.find((design) => design.id === props.view.design())?.name ?? ""
  const right = () => SCREENS[props.view.design()] === "right" && props.view.peek() && Boolean(props.view.selected())
  const body = () => Math.max(20, props.width - 2 - (right() ? PEEK_RIGHT + 1 : 0))
  return (
    <box flexDirection="column" width={props.width} height={props.height} paddingLeft={1} paddingRight={1}>
      <Show when={props.view.status()} fallback={<text fg={props.theme().textMuted}>No task run in this directory.</text>}>
        {(status) => (
          <>
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text wrapMode="none">
                <Brand theme={props.theme} />
              </text>
              <text fg={props.theme().text} wrapMode="none">
                <b>{name()}</b>
              </text>
              <text fg={props.theme().textMuted} wrapMode="none">
                {`${status().run.spec} · ${runText(status())}`}
              </text>
              <box flexGrow={1} />
              <text fg={props.theme().success} wrapMode="none">
                {`${bar(counts(status()).trusted, counts(status()).total, 10)} ${trustedText(status())}`}
              </text>
            </box>
            <Show when={status().run.reason && tone(status().run.state) !== "good"}>
              <text fg={props.theme().error} wrapMode="none" flexShrink={0}>
                {cut(status().run.reason ?? "", props.width - 2)}
              </text>
            </Show>
            <box flexDirection={SCREENS[props.view.design()] === "right" ? "row" : "column"} flexGrow={1} gap={1} marginTop={1}>
              <box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Switch
                  fallback={
                    <text fg={props.theme().textMuted}>{`Design ${props.view.design()} has no full-screen view.`}</text>
                  }
                >
                  <Match when={props.view.design() === 3}>
                    <BoardView {...props} width={body()} />
                  </Match>
                  <Match when={props.view.design() === 4}>
                    <MatrixView {...props} width={body()} />
                  </Match>
                  <Match when={props.view.design() === 5}>
                    <GanttView {...props} width={body()} />
                  </Match>
                </Switch>
              </box>
              <Show when={props.view.peek() && props.view.selected()} keyed>
                {(unit) => (
                  <Peek
                    theme={props.theme}
                    view={props.view}
                    sessions={props.sessions}
                    unit={unit}
                    width={right() ? PEEK_RIGHT : props.width - 2}
                    lines={right() ? 8 : 4}
                  />
                )}
              </Show>
            </box>
            <text fg={props.theme().textMuted} wrapMode="none" flexShrink={0}>
              j/k task · enter peek · v design · esc back
            </text>
          </>
        )}
      </Show>
    </box>
  )
}

export function registerScreen(ctx: Ctx) {
  ctx.api.route.register([
    {
      name: ROUTE,
      render: (input) => {
        const dimensions = useTerminalDimensions()
        // Back to the session the view was opened from, or home when it was opened from there.
        const back = () => {
          const sessionID = input.params?.sessionID
          if (typeof sessionID === "string") return ctx.api.route.navigate("session", { sessionID })
          ctx.api.route.navigate("home")
        }
        const dispose = ctx.api.keymap.registerLayer({
          commands: [
            { name: "task_ui.screen.back", run: back },
            { name: "task_ui.screen.next", run: ctx.view.next },
            { name: "task_ui.screen.previous", run: ctx.view.previous },
            { name: "task_ui.screen.peek", run: ctx.view.togglePeek },
            { name: "task_ui.screen.design", run: ctx.view.cycleDesign },
          ],
          bindings: [
            { key: "escape,q", cmd: "task_ui.screen.back", desc: "Back to the session" },
            { key: "j,down", cmd: "task_ui.screen.next", desc: "Select the next task" },
            { key: "k,up", cmd: "task_ui.screen.previous", desc: "Select the previous task" },
            { key: "return,space", cmd: "task_ui.screen.peek", desc: "Open or close the peek" },
            { key: "v", cmd: "task_ui.screen.design", desc: "Next task UI design" },
          ],
        })
        onCleanup(dispose)
        return (
          <Screen
            theme={ctx.theme}
            view={ctx.view}
            sessions={ctx.sessions}
            leader={ctx.leader}
            width={dimensions().width}
            height={dimensions().height}
          />
        )
      },
    },
  ])

  // In the session, the full-screen designs show only a hint next to the prompt.
  ctx.api.slots.register({
    order: 50,
    slots: {
      session_prompt_right() {
        return (
          <Show when={ctx.active() && SCREENS[ctx.view.design()] && ctx.view.status()}>
            {(status) => (
              <text wrapMode="none">
                <Brand theme={ctx.theme} />
                <span style={{ fg: ctx.theme().textMuted }}>
                  {` ${trustedText(status())} · ${ctx.leader} p ${DESIGNS.find((design) => design.id === ctx.view.design())?.name.toLowerCase()}`}
                </span>
              </text>
            )}
          </Show>
        )
      },
    },
  })
}
