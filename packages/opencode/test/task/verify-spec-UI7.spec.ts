import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Layer, Logger, Option, Predicate } from "effect"
import { MarkdownRenderable, SyntaxStyle } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Env } from "../../src/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { Question } from "../../src/question"
import { SessionCompaction } from "../../src/session/compaction"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { git, seed, SPEC } from "./lib/command"
import { fail, facts, loadPlan, obligationsOf, pass, unitState } from "./lib/machine"

// Scenario UI7 (spec task-harness-feedback, D18, AD-18, SD-18, SD-20; task T4.11): a closing summary appears in the
// transcript when the run ends.
//
//   Given a run that ends with a dead task, a blocked task, a rejected scenario and a parked scenario
//   When the run machine reaches a final state
//   Then the root session gets one assistant-role markdown message with no model call
//   And it holds the outcome line, the counts line with the duration, tokens and cost, the stopped tasks with their
//     reasons, the scenarios that did not pass with their reasons, the scenarios not run, and a table of every task's
//     duration
//   And it holds the run-warning line when the spec stopped validating during the run
//   And a reason that holds <, *, _, a backtick or | shows each character as written, because the summary escapes
//     model text
//
// Everything is the product's own wiring: the session runtime of `SessionPrompt` (its layer graph as the session
// tests build it, with the scripted model server), the process-wide harness root `TaskHarness.Service` of that graph,
// the real background jobs, the real event store and session store, and a seeded git instance. `/task` is typed in the
// root session through `SessionPrompt.command`, so the run header, the job, the run supervisor, the scenario judge's
// session and turn, the `verdict` tool and the closing summary's `say` are the code the TUI drives.
//
// The Given is a stored, unended slice of the whole release-notes spec, resumed by `/task`: T9 is trusted, T8 is not;
// T1.1 to T1.4 are trusted; T1.5 failed its proof on each of its three attempts with a model reason that holds `<`
// and `|` (budget exhausted: the dead task), so T1 is blocked; the spec check failed once and then validated again;
// every scenario whose needs are trusted is trusted, except S4, which passed its test and waits for its judge; S5 is
// blocked by T1.5 and S13 waits on the outside T8 (parked). The root has two child sessions that already spent tokens
// and money. When the run resumes, S4's judge (a scripted model turn) calls the real `verdict` tool and rejects S4
// with a reason that holds `<`, `|`, `*`, a backtick and `_`; that verdict makes the run machine final.

const summaryStub = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

// The session runtime as `test/session/prompt.test.ts` builds it, with the harness root and the model server.
const root = LayerNode.group([
  SessionPrompt.node,
  TaskHarness.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

// The log of the runtime's services: the harness root and every actor it spawns log here.
const logged: Array<unknown> = []
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(root, [
      [SessionSummary.node, summaryStub],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ]).pipe(
      Layer.provide(
        Logger.layer([
          Logger.make<unknown, void>((options) => {
            logged.push(options.message)
          }),
        ]),
      ),
    ),
    NodeServices.layer,
  ),
)

// Each logged failure of the closing summary: its message and the first line of its cause.
const summaryLog = () =>
  logged.flatMap((entry) => {
    if (!Array.isArray(entry) || !String(entry[0]).includes("closing summary")) return []
    const detail: unknown = entry[1]
    const cause = Predicate.hasProperty(detail, "cause") ? detail.cause : undefined
    return [`${String(entry[0])}: ${Cause.isCause(cause) ? Cause.pretty(cause).split("\n")[0] : String(cause)}`]
  })

// The scripted model: a provider "test" whose model "test-model" is served by the test model server; it costs nothing.
const configOf = (url: string): Partial<ConfigV1.Info> => ({
  model: "test/test-model",
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const HEADER = "Implementing spec **Release notes from conventional commits**"
// The model texts: T1.5's proof failure (its reason), and S4's judge's rejection.
const PROOF_REASON = "Type 'Promise<void>' | x"
const JUDGE_REASON = "the test checks <h2> only | and *bold* `code` _under_"
const MINUTE = 60_000

// The stored slice. `START` is the run's start; each fact carries the time named for it, so each task's duration is
// known: T1.1 3m 2s, T1.2 2m 40s, T1.3 5m 12s, T1.4 6m 40s, T1.5 6m 40s over its three attempts.
const sliceOf = (plan: Plan, base: string, start: number): ReadonlyArray<Fact> => {
  const f = facts()
  const at = (ms: number, fact: Fact): Fact => ({ ...fact, at: start + ms })
  const leaf = (task: string, from: number, to: number): ReadonlyArray<Fact> => [
    at(from, f.started(task)),
    at(from + 1_000, f.ready(task)),
    at(to - 1_000, f.proved(task, obligationsOf(plan, task).map(pass))),
    at(to, f.verified(task, [])),
  ]
  const exhaust = (task: string, from: number, to: number): ReadonlyArray<Fact> => {
    const step = (to - from) / 3
    const obligation = obligationsOf(plan, task)[0] ?? ""
    return [
      at(from, f.started(task)),
      ...[1, 2, 3].flatMap((attempt) => [
        at(from + step * attempt - 2_000, f.ready(task)),
        at(from + step * attempt, f.proved(task, [fail(obligation, PROOF_REASON)])),
      ]),
    ]
  }
  const trusted = (id: string, ms: number): ReadonlyArray<Fact> => [
    at(ms, f.scenarioProved(id, "passed")),
    at(ms + 1_000, f.scenarioVerified({ id, verdict: "trusted" })),
  ]
  return [
    { type: "run.started", at: start, base, path: SPEC },
    at(1_000, f.outside("T9")),
    ...leaf("T1.1", 2_000, 184_000),
    ...leaf("T1.2", 2_000, 162_000),
    // The spec stopped validating during the run, then validated again.
    at(170_000, f.checked([{ rule: "R4", path: "T1-release-notes.task/TASK.md", message: "the task has no H1" }])),
    ...leaf("T1.3", 184_000, 496_000),
    at(260_000, f.checked([])),
    ...trusted("S2", 500_000),
    ...trusted("S3", 502_000),
    ...trusted("S7", 504_000),
    ...trusted("S12", 506_000),
    ...leaf("T1.4", 496_000, 896_000),
    ...exhaust("T1.5", 896_000, 1_296_000),
    ...["S1", "S6", "S8", "S9", "S10", "S11"].flatMap((id, index) => trusted(id, 1_300_000 + index * 2_000)),
    // S4 passed its test and waits for its judge.
    at(1_320_000, f.scenarioProved("S4", "passed")),
  ]
}

// A child session of the root that has spent tokens (input, output, reasoning, and a cache that is never counted) and
// money: one assistant step whose usage the session store sums into the session.
const spender = (rootID: SessionID, title: string, tokens: [number, number, number], cost: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const child = yield* sessions.create({ parentID: rootID, title })
    const message: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: child.id,
      mode: "build",
      agent: "build",
      cost,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: tokens[0], output: tokens[1], reasoning: tokens[2], cache: { read: 900_000, write: 900_000 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    }
    yield* sessions.updateMessage(message)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID: child.id,
      type: "step-finish",
      reason: "stop",
      cost,
      tokens: { input: tokens[0], output: tokens[1], reasoning: tokens[2], cache: { read: 900_000, write: 900_000 } },
    })
    return child.id
  })

const textOf = (message: SessionV1.WithParts) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

// The summary the run said, for the render test below.
const said: { text?: string } = {}

it.instance(
  "[UI7] a run that ends with a dead task, a blocked task, a rejected scenario and a parked scenario writes one assistant markdown summary in the root session, with no model call",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      const fsutil = yield* FSUtil.Service
      yield* fsutil.writeWithDirs(
        path.join(directory, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", ...configOf(llm.url) }),
      )
      yield* seed(SPEC)
      const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const harness = yield* TaskHarness.Service
      const plan = yield* loadPlan("release-notes.spec")
      const id = TaskEvents.runID(directory, SPEC)

      // Given the root session, whose two child sessions spent 1.5M tokens and $2.31 so far.
      const rootSession = yield* sessions.create({ title: "UI7 root" })
      yield* spender(rootSession.id, "T1.1 builder", [1_000_000, 150_000, 50_000], 2)
      yield* spender(rootSession.id, "T1.2 builder", [250_000, 40_000, 10_000], 0.31)
      const children = yield* sessions.children(rootSession.id)
      expect(children.map((child) => child.cost ?? 0).toSorted((a, b) => a - b)).toEqual([0.31, 2])

      // And the stored, unended slice: a dead task (T1.5), a blocked task (T1), S4 waiting for its judge, S5
      // blocked, S13 parked on T8 (outside), and a spec check that failed.
      const start = Date.now() - (24 * MINUTE + 10_000)
      const slice = sliceOf(plan, branch, start)
      const given = TaskEvents.fold(TaskEngineXState.XStateEngine, plan, slice)
      expect(TaskEngineXState.ended(given)).toBe(false)
      expect(["T1", "T1.1", "T1.2", "T1.3", "T1.4", "T1.5"].map((task) => unitState(given, task))).toEqual([
        "blocked",
        "trusted",
        "trusted",
        "trusted",
        "trusted",
        "budget_exhausted",
      ])
      expect(["S4", "S5", "S13"].map((scenario) => unitState(given, scenario))).toEqual([
        "verifying",
        "blocked",
        "parked",
      ])
      expect(TaskEngineXState.warned(given)).toBe(true)
      for (const fact of slice) yield* TaskEvents.publish(events, id, fact)

      // S4's judge: the scripted model calls the real `verdict` tool, then ends its turn.
      yield* llm.tool("verdict", { verdicts: [{ id: "S4", verdict: "rejected", reason: JUDGE_REASON }] })
      yield* llm.text("Verdicts recorded.")

      // When `/task` resumes the slice in the root session, and the judge's verdict makes the run machine final.
      const header = yield* prompt.command({ sessionID: rootSession.id, command: "task", arguments: SPEC })
      expect(header.info.role).toBe("user")
      expect(textOf(header)).toBe(HEADER)
      // The run supervisor closes after its closing step; then the job ends.
      const background = yield* BackgroundJob.Service
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const job = yield* background.get(id)
          return job?.status === "completed" && !(yield* harness.running(id)) ? true : undefined
        }),
        "the run never closed",
        "90 seconds",
      )
      // The run machine is final: S4 was rejected by its judge, and the run ended budget exhausted.
      const end = TaskEvents.fold(
        TaskEngineXState.XStateEngine,
        plan,
        Option.getOrThrow(TaskEvents.latestRun(yield* TaskEvents.read((yield* Database.Service).db, id))),
      )
      expect(TaskEngineXState.ended(end)).toBe(true)
      expect(TaskEngineXState.view(end).run.state).toBe("budget_exhausted")
      expect(unitState(end, "S4")).toBe("rejected")
      expect(yield* harness.live(directory)).toEqual(Option.none())

      // The closing step logged no failure: the summary was said.
      expect(summaryLog()).toEqual([])
      const messages = yield* sessions.messages({ sessionID: rootSession.id })
      // Then the root session gets one assistant-role message: the run header, then the summary, nothing else.
      expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant"])
      const summary = messages[1]
      if (summary?.info.role !== "assistant" || messages[0]?.info.role !== "user") throw new Error("no summary")
      expect(summary.info.parentID).toBe(messages[0].info.id)
      expect(summary.info.finish).toBe("stop")
      expect(summary.info.cost).toBe(0)
      expect(summary.info.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
      expect(summary.parts.map((part) => part.type)).toEqual(["text"])
      // With no model call: every model request came from S4's judge; none carried the root session's transcript.
      const hits = yield* llm.hits
      expect(hits.length).toBeGreaterThan(0)
      for (const hit of hits) {
        const body = JSON.stringify(hit.body)
        expect({ judge: body.includes("You judge scenario S4"), root: body.includes(HEADER) }).toEqual({
          judge: true,
          root: false,
        })
      }

      // And it holds the outcome line, the counts line with the duration, tokens and cost, the stopped tasks with
      // their reasons, the scenarios that did not pass with their reasons, the scenarios not run, the run-warning
      // line, and a table of every task's duration. Model text is escaped for CommonMark.
      const text = textOf(summary)
      said.text = text
      const lines = text.split("\n")
      expect(lines[0]).toBe("Spec **Release notes from conventional commits** — budget exhausted")
      expect(lines[1]).toBe("")
      expect(lines[2]).toMatch(
        /^Tasks 4\/6 trusted · 1 budget exhausted · 1 blocked · Scenarios 10\/13 trusted · 1 rejected · 1 blocked · 1 not run · 24m \d{1,2}s · 1\.5M tokens · \$2\.31$/,
      )
      expect(lines.slice(3)).toEqual([
        "",
        "**Stopped**",
        "",
        "- ⊘ **T1.5** budget exhausted after 3 attempts · 6m 40s",
        "  T1.5.c1: Type 'Promise\\<void\\>' \\| x",
        "- ⊖ **T1** blocked by T1.5: budget exhausted",
        "",
        "**Scenarios that did not pass**",
        "",
        "- ✗ **S4** rejected · Notes are grouped under fixed headings",
        "  the test checks \\<h2\\> only \\| and \\*bold\\* \\`code\\` \\_under\\_",
        "",
        "**Not run**",
        "",
        "- ○ **S13** The published package runs from the registry — waiting on T8 (outside)",
        "",
        "The spec stopped validating during the run. The run kept the plan it loaded.",
        "",
        "**Tasks**",
        "",
        "| Task | State | Attempts | Time |",
        "|---|---|---|---|",
        "| T1 | blocked | 0 | — |",
        "| T1.1 | trusted | 1 | 3m 2s |",
        "| T1.2 | trusted | 1 | 2m 40s |",
        "| T1.3 | trusted | 1 | 5m 12s |",
        "| T1.4 | trusted | 1 | 6m 40s |",
        "| T1.5 | budget exhausted | 3 | 6m 40s |",
      ])
    }),
  { git: true },
  180_000,
)

it.live(
  "[UI7] in the transcript, the summary's reasons show <, *, _, a backtick and | as the model wrote them",
  () =>
    Effect.promise(async () => {
      const text = said.text
      if (text === undefined) throw new Error("the run wrote no summary")
      // The root transcript draws an assistant text part with opentui's markdown element, concealing markup
      // (`TextPart` in packages/tui/src/routes/session/index.tsx); the same element and options here.
      const out = await createTestRenderer({ width: 160, height: 60 })
      const markdown = new MarkdownRenderable(out.renderer, {
        content: text.trim(),
        syntaxStyle: SyntaxStyle.create(),
        streaming: true,
        internalBlockMode: "top-level",
        conceal: true,
        tableOptions: { style: "grid" },
      })
      out.renderer.root.add(markdown)
      // The markup is concealed once the parser has highlighted the text.
      const drawn = async (tries: number): Promise<string> => {
        await out.renderOnce()
        const frame = out.captureCharFrame()
        if ((frame.includes("Spec Release notes") && frame.includes("T1.5.c1")) || tries === 0) return frame
        await Bun.sleep(50)
        return drawn(tries - 1)
      }
      const frame = await drawn(200)
      out.renderer.destroy()
      const rows = frame.split("\n").map((row) => row.trimEnd())
      expect(rows).toContain("  T1.5.c1: Type 'Promise<void>' | x")
      expect(rows).toContain("  the test checks <h2> only | and *bold* `code` _under_")
    }),
  60_000,
)
