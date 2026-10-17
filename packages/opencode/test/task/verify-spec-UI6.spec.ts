import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { TextAttributes, type CapturedSpan } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Effect, FileSystem, Layer, Option, Result } from "effect"
import { createComponent, type JSX } from "solid-js"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { InstanceStore } from "@/project/instance-store"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { TaskCommand } from "@/task/core/command"
import { TaskHarness } from "@/task/core/harness"
import type { Plan } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import { MessageBody, TaskHeader, headerOf, splitHeader } from "../../../tui/src/routes/session/task-header"
import { parse } from "../../../tui/src/task-ui/store"
import { runTitle } from "../../../tui/src/task-ui/ui"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { viewFor } from "../../../tui/test/task-ui/view"
import { testEffect } from "../lib/effect"
import { backgroundOf, jobsOf, runTaskInputs, SPEC, seed, statusFile } from "./lib/command"
import { facts, loadPlan } from "./lib/machine"

// Scenario UI6 (spec task-harness-feedback, D17, AD-13; tasks T4.10, T4.8): the run header shows the spec title.
//
//   Given the release-notes spec, whose title is "Release notes from conventional commits"
//   When /task starts a whole-spec run and a subtree run
//   Then the first message reads "Implementing spec" and the title, from structured header metadata
//   And the transcript draws "Implementing spec" muted and the title bold, from that metadata
//   And a subtree run reads "Implementing" with the task id and title, then "from spec" and the spec title
//   And an empty title falls back to the spec id, and the status run carries the title and, for a subtree run, the task
//   And a subtree run that leaves scenarios out adds the muted line "Left out: <ids> — they need tasks outside this run."
//   And an older header in the scrollback keeps its own title when a later run starts
//
// `/task` is the real `TaskCommand.run` with the real harness root and loader, in a git instance that holds a committed
// copy of the spec folders; the ops record each message the command sends, and the job registry only records a start
// (lib/command). The transcript is the real TUI code, imported by relative path: the session route's user message
// splits a message's parts with `splitHeader` and draws them with `MessageBody` / `TaskHeader`
// (packages/tui/src/routes/session/task-header.tsx), rendered with the opentui test renderer from the parts the
// command sent. A separate command test uses the real SessionPrompt and session projector to read the stored header.
// The status run is the real projection (`TaskStatus.project` over the engine's snapshot after `run.started`), written
// by `TaskStatus.write`, decoded by the task-ui's own `parse` and drawn by its Ledger.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const storedJobs = jobsOf()
// Only the job starter and services unrelated to a no-reply header are replaced. The prompt and session stores run.
const storedHeader = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        SessionPrompt.node,
        Session.node,
        SessionStatus.node,
        SessionProjector.node,
        MessageV2.node,
        FSUtil.node,
        BackgroundJob.node,
        Database.node,
        EventV2Bridge.node,
      ]),
      [
        [BackgroundJob.node, Layer.succeed(BackgroundJob.Service, backgroundOf(storedJobs))],
        [SessionSummary.node, Layer.mock(SessionSummary.Service, { summarize: () => Effect.void })],
        [LSP.node, Layer.mock(LSP.Service, { init: () => Effect.void })],
        [MCP.node, Layer.mock(MCP.Service, { prompts: () => Effect.succeed({}) })],
        [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      ],
    ),
    NodeServices.layer,
    Layer.mock(InstanceStore.Service, {}),
  ),
)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

const TITLE = "Release notes from conventional commits"
const SPEC_ID = "release-notes.spec"
const T1_2 = `${SPEC}/T1-release-notes.task/T1.2-version-bump.task`
const T1_2_TITLE = "Compute the next version"
// acceptance/S3.md needs only T1.2. Each other acceptance/S*.md needs a task outside this subtree.
const T1_2_LEFT_OUT = ["S1", "S2", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"]
const LATER = "task-formats/blend/example-scenarios.spec"
const LATER_TITLE = "Slugs for release titles"

interface Drawn {
  readonly lines: ReadonlyArray<string>
  readonly spans: ReadonlyArray<CapturedSpan>
}

// Renders `node` with the opentui test renderer: the frame's non-empty lines and every span with its colour and
// attributes.
const draw = (node: () => JSX.Element, width = 120, height = 10) =>
  Effect.promise(async (): Promise<Drawn> => {
    const app = await testRender(node, { width, height })
    try {
      await app.renderOnce()
      return {
        lines: app
          .captureCharFrame()
          .split("\n")
          .map((line) => line.trimEnd())
          .filter(Boolean),
        spans: app.captureSpans().lines.flatMap((line) => line.spans),
      }
    } finally {
      app.renderer.destroy()
    }
  })

const spanOf = (drawn: Drawn, text: string) => drawn.spans.find((span) => span.text.includes(text))
const bold = (span: CapturedSpan | undefined) => ((span?.attributes ?? 0) & TextAttributes.BOLD) !== 0
const rgb = (value: { r: number; g: number; b: number } | undefined) => (value ? [value.r, value.g, value.b] : [])

// A message of the transcript as the session route draws it: its parts split, then the body drawn from them.
const transcript = (parts: ReadonlyArray<TaskOps.PromptInput["parts"][number]>, width = 120) =>
  draw(() => createComponent(MessageBody, { theme, split: splitHeader(parts) }), width)

// The status of a run of `plan` that has just started, as the harness projects and writes it, read back from disk.
const startedStatus = Effect.fnUntraced(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const snapshot = TaskEngineXState.apply(plan, TaskEngineXState.initial(plan), facts().runStarted(plan.path))
  yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), 1_000)
  const text = yield* fs.readFileString(statusFile(directory))
  const raw: { run: Record<string, unknown> } = JSON.parse(text)
  return { text, run: raw.run }
})

it.instance(
  "[UI6] /task on the whole spec: the first message reads Implementing spec and the title, from structured header metadata; the transcript draws it muted and bold from that metadata",
  () =>
    Effect.gen(function* () {
      yield* seed(SPEC)
      // When /task starts a whole-spec run: its job starts, and its first message is the run header.
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(yield* TaskHarness.make, SPEC, jobs)
      expect(jobs.starts).toHaveLength(1)
      expect(inputs).toHaveLength(1)
      const first = inputs[0]
      expect(first?.noReply).toBe(true)
      // Then the first message reads "Implementing spec" and the title, and carries the header as structured metadata.
      expect(first?.parts).toEqual([
        {
          type: "text",
          text: `Implementing spec **${TITLE}**`,
          metadata: { taskHarness: { header: { spec: { id: SPEC_ID, title: TITLE }, leftOut: [] } } },
        },
      ])
      const parts = first?.parts ?? []
      expect(headerOf(parts[0]?.metadata)).toEqual(Option.some({ spec: { id: SPEC_ID, title: TITLE }, leftOut: [] }))

      // And the transcript draws "Implementing spec" muted (not bold) and the title bold in the text tone.
      const drawn = yield* transcript(parts)
      expect(drawn.lines).toEqual([`Implementing spec ${TITLE}`])
      expect(rgb(spanOf(drawn, "Implementing spec")?.fg)).toEqual(rgb(theme.textMuted))
      expect(bold(spanOf(drawn, "Implementing spec"))).toBe(false)
      expect(rgb(spanOf(drawn, TITLE)?.fg)).toEqual(rgb(theme.text))
      expect(bold(spanOf(drawn, TITLE))).toBe(true)
      // The markdown asterisks of the text are not drawn: the header comes from the metadata.
      expect(drawn.lines.join("\n")).not.toContain("**")

      // From that metadata, never the text: the same metadata on another text draws the same header, and the same
      // text without the metadata is drawn as plain text, asterisks and all.
      const other = yield* transcript([{ type: "text", text: "something else", metadata: parts[0]?.metadata }])
      expect(other.lines).toEqual([`Implementing spec ${TITLE}`])
      expect(bold(spanOf(other, TITLE))).toBe(true)
      const plain = yield* transcript([{ type: "text", text: parts[0]?.text ?? "" }])
      expect(plain.lines).toEqual([`Implementing spec **${TITLE}**`])
      expect(bold(spanOf(plain, TITLE))).toBe(false)
    }),
  { git: true },
)

it.instance(
  "[UI6] /task on the T1.2 subtree: Implementing, the task id and title, then from spec and the spec title; the left-out scenarios follow on a muted line",
  () =>
    Effect.gen(function* () {
      yield* seed(SPEC)
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(yield* TaskHarness.make, T1_2, jobs)
      expect(jobs.starts).toHaveLength(1)
      const part = inputs[0]?.parts[0]
      expect(inputs[0]?.parts).toHaveLength(1)

      // Pin the omitted ids from acceptance/S*.md, independent of the command's filter.
      const plan = yield* loadPlan(SPEC_ID, "T1.2")
      const leftOut = TaskCommand.leftOut(plan)
      expect(leftOut).toEqual(T1_2_LEFT_OUT)
      expect(leftOut).not.toContain("S3")
      // The first message: "Implementing **T1.2 <title>** from spec **<title>**", then the Left out line.
      const head = `Implementing **T1.2 ${T1_2_TITLE}** from spec **${TITLE}**`
      const leftLine = `Left out: ${T1_2_LEFT_OUT.join(", ")} — they need tasks outside this run.`
      expect(part?.text).toBe(`${head}\n${leftLine}`)
      expect(part?.metadata).toEqual({
        taskHarness: {
          header: {
            spec: { id: SPEC_ID, title: TITLE },
            task: { id: "T1.2", title: T1_2_TITLE },
            leftOut: T1_2_LEFT_OUT,
          },
        },
      })

      // The transcript: "Implementing" muted, the task bold, " from spec " muted, the spec title bold; then the
      // muted Left out line.
      const drawn = yield* transcript(inputs[0]?.parts ?? [], 200)
      expect(drawn.lines).toEqual([`Implementing T1.2 ${T1_2_TITLE} from spec ${TITLE}`, leftLine])
      expect(rgb(spanOf(drawn, "Implementing")?.fg)).toEqual(rgb(theme.textMuted))
      expect(bold(spanOf(drawn, "Implementing"))).toBe(false)
      expect(bold(spanOf(drawn, `T1.2 ${T1_2_TITLE}`))).toBe(true)
      expect(rgb(spanOf(drawn, `T1.2 ${T1_2_TITLE}`)?.fg)).toEqual(rgb(theme.text))
      expect(rgb(spanOf(drawn, " from spec ")?.fg)).toEqual(rgb(theme.textMuted))
      expect(bold(spanOf(drawn, " from spec "))).toBe(false)
      expect(bold(spanOf(drawn, TITLE))).toBe(true)
      expect(rgb(spanOf(drawn, "Left out:")?.fg)).toEqual(rgb(theme.textMuted))
      expect(bold(spanOf(drawn, "Left out:"))).toBe(false)

      // A run that leaves nothing out has no Left out line: the whole spec.
      const whole = TaskCommand.header(yield* loadPlan(SPEC_ID))
      expect(whole.text).toBe(`Implementing spec **${TITLE}**`)
      expect((yield* transcript([{ type: "text", ...whole }])).lines).toEqual([`Implementing spec ${TITLE}`])
    }),
  { git: true },
)

storedHeader.instance(
  "[UI6] SessionPrompt.command stores the T1.2 header text and structured metadata in the root session",
  () =>
    Effect.gen(function* () {
      yield* seed(SPEC)
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({
        title: "UI6 root",
        model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
      })
      const header = yield* prompt.command({ sessionID: chat.id, command: "task", arguments: T1_2 })
      expect(storedJobs.starts).toHaveLength(1)
      expect(header.info.role).toBe("user")
      const stored = yield* sessions.messages({ sessionID: chat.id })
      expect(stored).toHaveLength(1)
      expect(stored[0]?.info.id).toBe(header.info.id)
      expect(stored[0]?.parts).toEqual(header.parts)
      expect(stored[0]?.parts).toHaveLength(1)
      expect(stored[0]?.parts[0]).toMatchObject({
        type: "text",
        text: `Implementing **T1.2 ${T1_2_TITLE}** from spec **${TITLE}**\nLeft out: ${T1_2_LEFT_OUT.join(", ")} — they need tasks outside this run.`,
      })
      expect(stored[0]?.parts.find((part) => part.type === "text")?.metadata).toEqual({
        taskHarness: {
          header: {
            spec: { id: SPEC_ID, title: TITLE },
            task: { id: "T1.2", title: T1_2_TITLE },
            leftOut: T1_2_LEFT_OUT,
          },
        },
      })
    }),
  { git: true },
)

it.live(
  "[UI6] the status run carries the title, and for a subtree run the task; an empty title falls back to the spec id in the header, the transcript and the status",
  () =>
    Effect.gen(function* () {
      const whole = yield* loadPlan(SPEC_ID)
      const subtree = yield* loadPlan(SPEC_ID, "T1.2")

      // The whole-spec run's status carries the title and no task.
      const wholeStatus = yield* startedStatus(whole)
      expect(wholeStatus.run).toMatchObject({ specId: SPEC_ID, title: TITLE })
      expect("task" in wholeStatus.run).toBe(false)
      // The subtree run's status carries the title and the task.
      const subtreeStatus = yield* startedStatus(subtree)
      expect(subtreeStatus.run).toMatchObject({
        specId: SPEC_ID,
        title: TITLE,
        task: { id: "T1.2", title: T1_2_TITLE },
      })

      // The task-ui decodes the run title and shows it: the Ledger's line under the mark is the title, muted.
      const decoded = Option.getOrThrow(parse(wholeStatus.text))
      expect(decoded.run.title).toBe(TITLE)
      expect(runTitle(decoded)).toBe(TITLE)
      const { view, dispose } = yield* Effect.promise(() => viewFor(decoded, { design: 1 }))
      const ledger = yield* draw(
        () => createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 60 }),
        120,
        40,
      )
      dispose()
      expect(ledger.lines[1]).toBe(TITLE)
      expect(rgb(spanOf(ledger, TITLE)?.fg)).toEqual(rgb(theme.textMuted))

      // An empty title (a plan built with an empty H1; the loader refuses one) falls back to the spec id.
      const untitled: Plan = { ...whole, spec: { ...whole.spec, title: "" } }
      const header = TaskCommand.header(untitled)
      expect(header.text).toBe(`Implementing spec **${SPEC_ID}**`)
      // The metadata keeps the title as written; the transcript draws the spec id in the title's bold style.
      expect(header.metadata).toEqual({
        taskHarness: { header: { spec: { id: SPEC_ID, title: "" }, leftOut: [] } },
      })
      const drawn = yield* transcript([{ type: "text", ...header }])
      expect(drawn.lines).toEqual([`Implementing spec ${SPEC_ID}`])
      expect(bold(spanOf(drawn, SPEC_ID))).toBe(true)
      expect(rgb(spanOf(drawn, SPEC_ID)?.fg)).toEqual(rgb(theme.text))
      // The status run's title holds the spec id then, and the task-ui shows it.
      const untitledStatus = yield* startedStatus(untitled)
      expect(untitledStatus.run.title).toBe(SPEC_ID)
      expect(runTitle(Option.getOrThrow(parse(untitledStatus.text)))).toBe(SPEC_ID)
      // A subtree header with an empty spec title falls back the same way.
      const untitledSubtree: Plan = { ...subtree, spec: { ...subtree.spec, title: "" } }
      expect(TaskCommand.header(untitledSubtree).text).toStartWith(
        `Implementing **T1.2 ${T1_2_TITLE}** from spec **${SPEC_ID}**`,
      )
    }),
)

it.instance(
  "[UI6] an older header in the scrollback keeps its own title when a later run starts",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC, LATER)
      const harness = yield* TaskHarness.make
      // The first run: the whole release-notes spec.
      const jobs = jobsOf()
      const first = yield* runTaskInputs(harness, SPEC, jobs)
      expect(first[0]?.parts[0]?.text).toBe(`Implementing spec **${TITLE}**`)
      const before = yield* transcript(first[0]?.parts ?? [])
      expect(before.lines).toEqual([`Implementing spec ${TITLE}`])

      // That run ends (its lease is released), and a later run of another spec starts in the same directory.
      const ended = jobs.starts[0]?.id ?? ""
      expect(ended).not.toBe("")
      yield* harness.release(directory, ended)
      const laterJobs = jobsOf()
      const later = yield* runTaskInputs(harness, LATER, laterJobs)
      expect(laterJobs.starts).toHaveLength(1)
      expect(later[0]?.parts[0]?.text).toBe(`Implementing spec **${LATER_TITLE}**`)
      // The status file now belongs to the later run.
      const laterPlan = yield* loadPlan("example-scenarios.spec")
      const snapshot = TaskEngineXState.apply(
        laterPlan,
        TaskEngineXState.initial(laterPlan),
        facts().runStarted(laterPlan.path),
      )
      yield* TaskStatus.write(directory, TaskStatus.project(laterPlan, snapshot), 2_000)
      const fs = yield* FileSystem.FileSystem
      expect(Option.getOrThrow(parse(yield* fs.readFileString(statusFile(directory)))).run.title).toBe(LATER_TITLE)

      // The scrollback, drawn again: the older header still reads its own title; the later one reads its own.
      const older = yield* transcript(first[0]?.parts ?? [])
      expect(older.lines).toEqual([`Implementing spec ${TITLE}`])
      expect(bold(spanOf(older, TITLE))).toBe(true)
      expect(older.lines.join("\n")).not.toContain(LATER_TITLE)
      const newer = yield* transcript(later[0]?.parts ?? [])
      expect(newer.lines).toEqual([`Implementing spec ${LATER_TITLE}`])
      expect(bold(spanOf(newer, LATER_TITLE))).toBe(true)
      // Both in one transcript, oldest first, each from its own message's metadata.
      const both = yield* draw(() => [
        createComponent(MessageBody, { theme, split: splitHeader(first[0]?.parts ?? []) }),
        createComponent(MessageBody, { theme, split: splitHeader(later[0]?.parts ?? []) }),
      ])
      expect(both.lines).toEqual([`Implementing spec ${TITLE}`, `Implementing spec ${LATER_TITLE}`])
      // The header component reads only its header: given the older metadata it draws the older title.
      const header = Option.getOrThrow(headerOf(first[0]?.parts[0]?.metadata))
      expect((yield* draw(() => createComponent(TaskHeader, { theme, header }))).lines).toEqual([
        `Implementing spec ${TITLE}`,
      ])
    }),
  { git: true },
)
