// The watch view: the selected task's running builder or verifier in opencode's own session rendering, or its proofs
// as they run. Core shows another session's transcript, framed, while the session route carries `watch`; this file
// picks that session, draws the band (and the proof panel) above the frame, and binds the view's `esc`. It is watch
// only: nothing here sends to a harness session.
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { Effect, Option } from "effect"
import { For, Show, createEffect, createMemo, createResource, onCleanup, type Accessor } from "solid-js"
import stripAnsi from "strip-ansi"
import type { Child } from "./peek"
import { MARK, NAME, cut, label, proofLogFile, rows, runActive, tagged, waitsOn, type ProofLog, type Status } from "./store"
import { SCREENS } from "./designs/screen"
import { Brand, autocompleteOpen, type Ctx } from "./ui"
import type { View } from "./view"

/** What the band says: what is watched, or why nothing is. */
export type Band =
  | { readonly kind: "watching"; readonly what: string; readonly details: ReadonlyArray<string> }
  | { readonly kind: "note"; readonly text: string }

/** What the watch view shows. */
export type Watch = {
  readonly band: Band
  /** The session whose transcript shows; "" shows the root session's own transcript. */
  readonly session: string
  /** Leave the transcript on screen as it is (nothing is running): `session` does not apply. */
  readonly keep: boolean
  /** The proof log (a task id, or `scenarios`) that shows under the band; "" for none. */
  readonly proofs: string
}

/** How recently a proof log must have been written to show while no task is in work. */
export const RECENT_PROOF = 10_000

/** The line under the band: the view is watch only, and, while the run is live, how to stop it. */
export const noteText = (live: boolean) =>
  live
    ? "you type to the main session · esc twice stops the run · the same /task starts it again"
    : "you type to the main session"

const latest = (children: ReadonlyArray<Child>, pick: (child: Child) => boolean) =>
  children
    .filter(pick)
    .toSorted((a, b) => a.created - b.created)
    .at(-1)

const isBuilder = (child: Child) => child.role === "builder"

// A parent task is judged by a reviewer; a verifier asked a second time is marked, as in the details panel.
const judged = (child: Child | undefined) =>
  child ? [child.role === "reviewer" ? "parent review" : "", child.again ? "second try" : ""].filter(Boolean) : []

// A band with no session of its own: the root session's own transcript shows.
const note = (text: string): Watch => ({ band: { kind: "note", text }, session: "", keep: false, proofs: "" })

/**
 * What the band says with nothing in work: an untrusted outside precondition the run waits on, with its trust command
 * (UI21); else the tasks it waits on, an external one with no command; else how the run ended.
 */
export const idleText = (status: Status) => {
  const ids = runActive(status) ? waitsOn(status) : []
  const outside = ids.find((id) => status.outside?.[id]?.state === "untrusted")
  if (outside) return `Nothing is running. The run is waiting on ${outside} (outside) — run /task trust ${outside}.`
  return ids.length > 0
    ? `Nothing is running. The run waits on ${ids.join(", ")}.`
    : `Nothing is running · run: ${label(status.run.state)}`
}

/** The proof log written most recently, within `RECENT_PROOF` of `now`: the proofs running right now, if any. */
export const recentProof = (logs: ReadonlyArray<ProofLog>, now: number) =>
  logs
    .filter((log) => now - log.mtime <= RECENT_PROOF)
    .toSorted((a, b) => a.mtime - b.mtime)
    .at(-1)?.name ?? ""

/**
 * What the watch view shows for the selected task (the first task in work when the selection is not in the run). A
 * building task shows its latest builder, a verifying task its latest verifier, and a proving task its proofs over its
 * last builder. A task out of work keeps its latest session, so a session that just ended stays until Tab moves on.
 * Until a session exists and the host has loaded it (`loaded`), the band says it waits for it over the root
 * transcript. When no task is in work, the proofs that run (`recent`: a parent's, or the scenarios') show; with none,
 * the band names what the run waits on and the transcript stays.
 */
export function chooseWatch(input: {
  readonly status: Status
  readonly task: string | undefined
  readonly children: ReadonlyArray<Child>
  readonly loaded: (session: string) => boolean
  readonly recent?: string
}): Watch {
  const working = rows(input.status).filter((row) => tagged(row.task, "active"))
  const id = input.task && input.status.tasks[input.task] ? input.task : (working[0]?.id ?? "")
  const task = Option.fromNullishOr(input.status.tasks[id])
  if (working.length === 0 || Option.isNone(task)) {
    if (input.recent)
      return {
        band: { kind: "watching", what: `watching ${input.recent} proofs`, details: [] },
        session: "",
        keep: false,
        proofs: input.recent,
      }
    return { ...note(idleText(input.status)), keep: true }
  }
  const attempt = task.value.attempts > 0 ? [`attempt ${task.value.attempts}`] : []
  const builder = latest(input.children, isBuilder)
  const verifier = latest(input.children, (child) => !isBuilder(child))
  const watching = (role: string, child: Child, details: ReadonlyArray<string>): Watch => ({
    band: { kind: "watching", what: `watching ${id} ${role}`, details },
    session: child.id,
    keep: false,
    proofs: "",
  })
  const live = (role: string, child: Child | undefined, details: ReadonlyArray<string>): Watch => {
    if (!child) return note(`waiting for ${id} ${role}…`)
    // Asked for, so the host loads it; until then the band waits.
    if (!input.loaded(child.id)) return { ...note(`waiting for ${id} ${role}…`), session: child.id }
    return watching(role, child, details)
  }
  switch (task.value.state) {
    case "building":
      return live("builder", builder, attempt)
    case "verifying":
      return live("verifier", verifier, [...attempt, ...judged(verifier)])
    case "proving":
      return {
        band: { kind: "watching", what: `watching ${id} proofs`, details: attempt },
        session: builder?.id ?? "",
        keep: false,
        proofs: id,
      }
  }
  const last = latest(input.children, () => true)
  if (!last) return note(`no ${id} session yet`)
  const details = [...attempt, ...(isBuilder(last) ? [] : judged(last)), label(task.value.state)]
  return watching(isBuilder(last) ? "builder" : "verifier", last, details)
}

/** The band as one line of text: `◆ In the Flow watching T1.4 builder · attempt 2 · watch only`. */
export const bandText = (watch: Watch) =>
  watch.band.kind === "watching"
    ? [`${MARK} ${watch.band.what}`, ...watch.band.details, "watch only"].join(" · ")
    : `${MARK} ${watch.band.text} · watch only`

/**
 * The band above the watch frame: the mark, what is watched in bold, its attempt in muted text, and `watch only` in
 * the mark colour; under it, the note that says where typing goes and, while the run is `live`, how to stop it.
 */
export function WatchBand(props: { theme: Accessor<TuiThemeCurrent>; watch: Watch; width: number; live: boolean }) {
  const room = () => Math.max(10, props.width - 2)
  const details = () => (props.watch.band.kind === "watching" ? props.watch.band.details : [])
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.theme().backgroundPanel}
    >
      <text wrapMode="none">
        <Brand theme={props.theme} />
        <Show
          when={props.watch.band.kind === "watching"}
          fallback={
            <span style={{ fg: props.theme().text }}>
              {` ${props.watch.band.kind === "note" ? props.watch.band.text : ""}`}
            </span>
          }
        >
          <b>
            <span
              style={{ fg: props.theme().text }}
            >{` ${props.watch.band.kind === "watching" ? props.watch.band.what : ""}`}</span>
          </b>
          <span style={{ fg: props.theme().textMuted }}>
            {details()
              .map((item) => ` · ${item}`)
              .join("")}
          </span>
        </Show>
        <span style={{ fg: props.theme().accent }}> · watch only</span>
      </text>
      <text wrapMode="none">
        <span style={{ fg: props.theme().accent }}>watch only: </span>
        <span style={{ fg: props.theme().textMuted }}>{cut(noteText(props.live), room() - 12)}</span>
      </text>
    </box>
  )
}

// The single left rule of a shell call in an ordinary session (`ui/border.ts`, SplitBorder), so proofs read like one.
const SHELL_RULE = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

/** How much of the end of a proof log the panel reads. */
export const PROOF_TAIL_BYTES = 65_536

/**
 * The last `height` lines of a proof log, each cut to `width`. Colour codes go, and a line that a progress display
 * rewrote with `\r` keeps only what it shows last. When `partial` (the text is the end of a longer file), the first
 * line is dropped: it may start mid-line.
 */
export const proofTail = (text: string, height: number, width: number, partial = false) => {
  if (text === "") return []
  const lines = stripAnsi(text).replace(/\n$/, "").split("\n")
  return (partial ? lines.slice(1) : lines)
    .slice(-height)
    .map((line) => cut(line.replace(/\r$/, "").split("\r").at(-1) ?? "", width))
}

/** A task's proofs as they run, in the style of a shell call in a session, under a PROOF label in the mark colour. */
export function ProofPanel(props: {
  theme: Accessor<TuiThemeCurrent>
  task: string
  text: string
  partial?: boolean
  width: number
  height: number
}) {
  const lines = () => proofTail(props.text, props.height, Math.max(10, props.width - 4), props.partial)
  return (
    <box
      border={["left"]}
      customBorderChars={SHELL_RULE}
      borderColor={props.theme().background}
      backgroundColor={props.theme().backgroundPanel}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      flexShrink={0}
    >
      <text wrapMode="none">
        <b>
          <span style={{ fg: props.theme().accent }}>PROOF</span>
        </b>
        <span style={{ fg: props.theme().textMuted }}>
          {cut(`  ${props.task} tests and gates · run by the harness, not an agent`, props.width - 9)}
        </span>
      </text>
      <Show when={lines().length > 0} fallback={<text fg={props.theme().textMuted}>no proof output yet</text>}>
        <For each={lines()}>
          {(line) => (
            <text fg={line.startsWith("$ ") ? props.theme().text : props.theme().textMuted} wrapMode="none">
              {line}
            </text>
          )}
        </For>
      </Show>
    </box>
  )
}

/**
 * A proof log's tail, read again on each tail tick of the view (500 ms): the harness appends to it every 200 ms, so
 * output shows within a second. `partial` says the tail starts mid-file.
 */
export function liveTail(file: string, view: Pick<View, "ticks">) {
  const [tail] = createResource(
    () => view.ticks().tail,
    () =>
      Effect.runPromise(
        // From an offset: a negative slice longer than the file reads nothing.
        Effect.tryPromise(() => {
          const log = Bun.file(file)
          return log.slice(Math.max(0, log.size - PROOF_TAIL_BYTES)).text()
        }).pipe(
          Effect.map((text) => ({ text, partial: Bun.file(file).size > PROOF_TAIL_BYTES })),
          Effect.orElseSucceed(() => ({ text: "", partial: false })),
        ),
      ),
    { initialValue: { text: "", partial: false } },
  )
  return tail
}

function LiveProofPanel(props: { ctx: Ctx; task: string; width: number; height: number }) {
  const tail = liveTail(proofLogFile(props.ctx.api.state.path.directory, props.task), props.ctx.view)
  return (
    <ProofPanel
      theme={props.ctx.theme}
      task={props.task}
      text={tail().text}
      partial={tail().partial}
      width={props.width}
      height={props.height}
    />
  )
}

/** How the plugin hears the stop key's emitted events from the view actor: warn on the first press, stop on the second. */
export type Listen = (type: "stop.warn" | "stop.run", run: () => void) => void

/**
 * The watch view's state and keys: the session it shows, the band in the `session_watch` slot, the route it keeps on
 * the session screen, and `esc` twice to stop the run. All of it acts only on a root session that owns harness
 * sessions (`ctx.owns`). Returns the toggle that `ctrl+x w` runs.
 */
export function registerWatch(ctx: Ctx, listen: Listen) {
  const { api, view } = ctx

  // The selected task's harness sessions, from the shared session list: a task revisited with Tab shows at once.
  const children = createMemo(() => ctx.harness().filter((item) => item.unit === view.selected()))
  const recent = createMemo(() => recentProof(ctx.logs(), view.now()))
  const watch = createMemo(() => {
    const status = view.status()
    return status && view.watching() && ctx.owns()
      ? Option.some(
          chooseWatch({
            status,
            task: view.selected(),
            children: children(),
            loaded: (id) => Boolean(api.state.session.get(id)),
            recent: recent(),
          }),
        )
      : Option.none<Watch>()
  })

  // The session in the frame is the machine's `target`: the latest choice, kept while nothing runs, "" once the watch
  // view is off.
  createEffect(() => {
    const current = Option.getOrUndefined(watch())
    if (current) view.send({ type: "watch.target", session: current.session, keep: current.keep })
  })

  // The root session's own route, the only one the view acts on: a developer who opens a child session, or a
  // full-screen view, is not pulled back.
  const onRoot = createMemo(() => {
    const current = api.route.current
    return current.name === "session" && "params" in current && current.params?.sessionID === ctx.root()
  })

  // Keep the root's route on the watched session. With nothing chosen, `watch` names the root itself: the band shows
  // over the root's own transcript, unframed.
  createEffect(() => {
    const current = api.route.current
    const root = ctx.root()
    if (!root || !ctx.owns() || !onRoot() || !("params" in current)) return
    const want = view.watching() ? view.target() || root : ""
    const have = typeof current.params?.watch === "string" ? current.params.watch : ""
    if (want === have) return
    api.route.navigate("session", want ? { sessionID: root, watch: want } : { sessionID: root })
  })

  api.slots.register({
    order: 50,
    slots: {
      session_watch() {
        const dimensions = useTerminalDimensions()
        // The session area: the terminal less the sidebar when it shows, and the session's padding.
        const width = () => dimensions().width - (dimensions().width > 120 ? 42 : 0) - 4
        const height = () => Math.max(4, Math.min(12, Math.floor(dimensions().height / 4)))
        return (
          <Show when={Option.getOrUndefined(watch())}>
            {(current) => (
              <box flexDirection="column" flexShrink={0}>
                <WatchBand theme={ctx.theme} watch={current()} width={width()} live={view.live()} />
                <Show when={current().proofs} keyed>
                  {(task) => <LiveProofPanel ctx={ctx} task={task} width={width()} height={height()} />}
                </Show>
              </box>
            )}
          </Show>
        )
      },
    },
  })

  // `esc` twice stops the whole run: the view machine's stop key arms on the first press and stops on a second within
  // 5 s. The run belongs to the root session, so stopping it aborts that session; the stop is announced only once the
  // server took it. While the autocomplete, a permission or a question is showing, `esc` is theirs.
  const open = () =>
    autocompleteOpen(api) ||
    api.state.session.permission(ctx.root()).length > 0 ||
    api.state.session.question(ctx.root()).length > 0
  listen("stop.warn", () => api.ui.toast({ variant: "warning", message: "Press esc again to stop the run" }))
  listen("stop.run", () => {
    const sessionID = ctx.root()
    const path = view.status()?.run.path ?? ""
    Effect.runFork(
      Effect.tryPromise(() => api.client.session.abort({ sessionID }, { throwOnError: true })).pipe(
        Effect.match({
          onSuccess: () =>
            api.ui.toast({
              message: path
                ? `Run stopped. Type /task ${path} to start it again.`
                : "Run stopped. Type the same /task to start it again.",
            }),
          onFailure: () =>
            api.ui.toast({ variant: "error", message: "The run did not stop. Press esc twice to try again." }),
        }),
      ),
    )
  })
  const stopRun = () => {
    if (open()) return false
    view.send({ type: "stop.key" })
    return true
  }
  createEffect(() => {
    if (!view.watching() || !view.live() || !ctx.owns() || !onRoot()) return
    onCleanup(
      api.keymap.registerLayer({
        // Below opencode's own `esc` keys (the autocomplete, shell mode, the interrupt, a dialog), so any of them
        // that is active wins.
        mode: "base",
        priority: -1,
        commands: [{ name: "task_ui.watch.stop", title: "Stop the task run", category: NAME, run: stopRun }],
        bindings: [{ key: "escape", cmd: "task_ui.watch.stop", desc: "Stop the task run (press twice)" }],
      }),
    )
  })

  // A key's command that returns false passes the key on, so the toggle returns nothing.
  return () => {
    if (view.watching()) {
      view.setWatching(false)
      return
    }
    if (!view.status() || !ctx.owns()) return
    // The full-screen designs and the Ticker's dialog cover the session area, where the watch view shows.
    if (SCREENS[view.design()] || view.design() === 7) view.setExpanded(false)
    const selected = view.rows().find((row) => row.id === view.selected())
    if (!selected || !tagged(selected.task, "active")) view.nextRunning()
    view.setWatching(true)
  }
}
