import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer, Logger, Option, Predicate } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
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
import { type Hit, reply, TestLLMServer } from "../lib/llm-server"
import { git, seed, SPEC } from "./lib/command"
import { fail, facts, loadPlan, obligationsOf, pass } from "./lib/machine"

// Scenario UI8 (spec task-harness-feedback, D18, AD-18; task T4.11): the summary is written even when a turn is in
// flight or the run was cancelled.
//
//   Given a root session with a turn in flight
//   When the run ends, or the user aborts the root session, or the run is cancelled
//   Then the summary waits for the turn and is then written once
//   And a later user prompt in the root session still runs a model turn
//
// Everything is the product's own wiring, as for UI7: the session runtime of `SessionPrompt` (its layer graph as the
// session tests build it, with the scripted model server), the process-wide harness root `TaskHarness.Service`, the
// real background jobs, the real event and session stores, and a seeded git instance. `/task` is typed in the root
// session through `SessionPrompt.command`; the user's question and the later prompt go through `SessionPrompt.prompt`;
// the abort is `SessionPrompt.cancel` (the TUI's abort, which also cancels the session's /task job); the run's
// cancel is `BackgroundJob.cancel` of the run's job.
//
// The Given: a stored, unended slice of the whole release-notes spec in which only S4's judge is left (T1.5 is budget
// exhausted, so the outcome is "budget exhausted"). `/task` resumes it; the judge's scripted model reply is held. The
// user then asks a question in the root session, and its model reply is held too: the root turn is in flight. One
// test for each When.

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

// Each logged failure of a run's closing summary: its message and the first line of its cause, if any.
const summaryLog = (runID: string) =>
  logged.flatMap((entry) => {
    if (!Array.isArray(entry) || !String(entry[0]).includes("closing summary")) return []
    const detail: unknown = entry[1]
    if (!Predicate.hasProperty(detail, "runID") || detail.runID !== runID) return []
    const cause = Predicate.hasProperty(detail, "cause") ? detail.cause : undefined
    return [`${String(entry[0])}${Cause.isCause(cause) ? `: ${Cause.pretty(cause).split("\n")[0]}` : ""}`]
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
const OUTCOME = "Spec **Release notes from conventional commits** — budget exhausted"
const QUESTION = "how is the run going?"
const ANSWER = "it is going well"
const LATER = "and what comes next?"
const LATER_ANSWER = "the next spec"
const JUDGE = "You judge scenario S4"

// The stored slice: T9 trusted; T1.1 to T1.4 trusted; T1.5 failed its proof three times (budget exhausted), so T1 is
// blocked; every scenario whose needs are trusted is trusted, except S4, which passed its test and waits for its judge.
const sliceOf = (plan: Plan, base: string): ReadonlyArray<Fact> => {
  const start = Date.now() - 600_000
  const f = facts(start)
  const leaf = (task: string): ReadonlyArray<Fact> => [
    f.started(task),
    f.ready(task),
    f.proved(task, obligationsOf(plan, task).map(pass)),
    f.verified(task, []),
  ]
  const trusted = (id: string): ReadonlyArray<Fact> => [
    f.scenarioProved(id, "passed"),
    f.scenarioVerified({ id, verdict: "trusted" }),
  ]
  const obligation = obligationsOf(plan, "T1.5")[0] ?? ""
  return [
    { type: "run.started", at: start, base, path: SPEC },
    f.outside("T9"),
    ...leaf("T1.1"),
    ...leaf("T1.2"),
    ...leaf("T1.3"),
    ...leaf("T1.4"),
    f.started("T1.5"),
    ...[1, 2, 3].flatMap(() => [f.ready("T1.5"), f.proved("T1.5", [fail(obligation, "a proof failed")])]),
    ...["S1", "S2", "S3", "S6", "S7", "S8", "S9", "S10", "S11", "S12"].flatMap(trusted),
    f.scenarioProved("S4", "passed"),
  ]
}

const textOf = (message: SessionV1.WithParts) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

const holds = (hit: Hit, text: string) => JSON.stringify(hit.body).includes(text)

// A run whose S4 judge and root turn are both in flight: the instance holds the spec and the scripted model's config,
// the slice is stored, `/task` resumed it, the judge's reply waits for `judge`, and the root's turn on QUESTION waits
// for `root`.
const inFlight = Effect.gen(function* () {
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
  const slice = sliceOf(plan, branch)
  expect(TaskEngineXState.ended(TaskEvents.fold(TaskEngineXState.XStateEngine, plan, slice))).toBe(false)
  for (const fact of slice) yield* TaskEvents.publish(events, id, fact)

  const judge = yield* Deferred.make<void>()
  const root = yield* Deferred.make<void>()
  const released = (gate: Deferred.Deferred<void>) => Effect.runPromise(Deferred.await(gate))
  const judging = (hit: Hit) => holds(hit, JUDGE)
  yield* llm.pushMatch(
    judging,
    reply()
      .wait(released(judge))
      .tool("verdict", { verdicts: [{ id: "S4", verdict: "rejected", reason: "the test checks one heading" }] }),
  )
  yield* llm.pushMatch(judging, reply().text("Verdicts recorded.").stop())
  yield* llm.pushMatch(
    (hit) => holds(hit, QUESTION) && !holds(hit, LATER),
    reply().wait(released(root)).text(ANSWER).stop(),
  )
  yield* llm.pushMatch((hit) => holds(hit, LATER), reply().text(LATER_ANSWER).stop())

  const session = yield* sessions.create({ title: "UI8 root" })
  const header = yield* prompt.command({ sessionID: session.id, command: "task", arguments: SPEC })
  expect(textOf(header)).toBe(HEADER)
  // The run resumed, and S4's judge is waiting on its model.
  yield* pollWithTimeout(
    Effect.map(llm.hits, (hits) => (hits.some(judging) ? true : undefined)),
    "S4's judge never asked its model",
    "60 seconds",
  )
  // Given a root session with a turn in flight: the user's question waits on its model.
  const turn = yield* prompt
    .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: QUESTION }] })
    .pipe(Effect.forkChild)
  yield* pollWithTimeout(
    Effect.map(llm.hits, (hits) => (hits.some((hit) => holds(hit, QUESTION)) ? true : undefined)),
    "the root turn never asked its model",
    "30 seconds",
  )
  expect((yield* (yield* SessionStatus.Service).get(session.id)).type).toBe("busy")
  return { id, directory, session: session.id, header, judge, root, turn, prompt, sessions, harness, plan, llm }
})

type Flight = Effect.Success<typeof inFlight>

// The summaries in the root session: assistant messages whose text starts with the outcome line.
const summariesOf = (flight: Flight) =>
  Effect.map(flight.sessions.messages({ sessionID: flight.session }), (messages) =>
    messages.filter((message) => message.info.role === "assistant" && textOf(message).startsWith(OUTCOME)),
  )

// The lease is free and the run stored `last`: the summary step is next. The run frees its lease only after the writer
// wrote the final snapshot (SD-19), so the poll reads the lease and the store and does not fold: a fold of this slice
// takes seconds on a loaded host, and a fold every 20 ms slowed the run it waited for past the cancel deadline and past
// a 60 s bound (2026-10-18 and 2026-10-19 suite runs). It returns the run's slice for `ended`.
const runFinal = (flight: Flight, last: Fact["type"]) =>
  pollWithTimeout(
    Effect.gen(function* () {
      if (Option.isSome(yield* flight.harness.live(flight.directory))) return undefined
      const run = TaskEvents.latestRun(yield* TaskEvents.read((yield* Database.Service).db, flight.id))
      return Option.isSome(run) && run.value.some((fact) => fact.type === last) ? run.value : undefined
    }),
    "the run never stored its last fact with a free lease",
    "120 seconds",
  )

// The run machine of the slice is final.
const ended = (flight: Flight, slice: ReadonlyArray<Fact>) =>
  expect(TaskEngineXState.ended(TaskEvents.fold(TaskEngineXState.XStateEngine, flight.plan, slice))).toBe(true)

// The run has closed: its job ended and its supervisor is gone.
const closed = (flight: Flight) =>
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const job = yield* background.get(flight.id)
        if (job === undefined || job.status === "running") return undefined
        return (yield* flight.harness.running(flight.id)) ? undefined : true
      }),
      "the run never closed",
      "60 seconds",
    )
  })

// Then the summary is written once, after the root turn, answering the run header; and a later prompt runs a model
// turn.
const writtenOnceAfterTheTurn = (flight: Flight) =>
  Effect.gen(function* () {
    expect(summaryLog(flight.id)).toEqual([])
    const messages = yield* flight.sessions.messages({ sessionID: flight.session })
    const summaries = messages.filter(
      (message) => message.info.role === "assistant" && textOf(message).startsWith(OUTCOME),
    )
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]
    if (summary?.info.role !== "assistant") throw new Error("no summary")
    expect(summary.info.parentID).toBe(flight.header.info.id)
    // It comes after every message of the root turn.
    const question = messages.findIndex((message) => message.info.role === "user" && textOf(message) === QUESTION)
    expect(question).toBeGreaterThan(0)
    expect(messages.indexOf(summary)).toBe(messages.length - 1)
    expect(messages.slice(question + 1, -1).every((message) => message.info.role === "assistant")).toBe(true)

    // And a later user prompt in the root session still runs a model turn.
    const before = (yield* flight.llm.hits).length
    const answer = yield* flight.prompt.prompt({
      sessionID: flight.session,
      agent: "build",
      parts: [{ type: "text", text: LATER }],
    })
    expect(answer.info.role).toBe("assistant")
    expect(textOf(answer)).toBe(LATER_ANSWER)
    expect((yield* flight.llm.hits).slice(before).some((hit) => holds(hit, LATER))).toBe(true)
    expect(yield* summariesOf(flight)).toHaveLength(1)
  })

it.instance(
  "[UI8] the run ends while a root turn is in flight: the summary waits for the turn, is then written once, and a later prompt runs a model turn",
  () =>
    Effect.gen(function* () {
      const flight = yield* inFlight
      // When the run ends: the judge's verdict makes the run machine final, and the lease is freed.
      yield* Deferred.succeed(flight.judge, undefined)
      ended(flight, yield* runFinal(flight, "scenario.verified"))
      // Then the summary waits for the turn: nothing is written while the root turn runs.
      yield* Effect.sleep("1 second")
      expect(yield* summariesOf(flight)).toEqual([])
      expect(summaryLog(flight.id)).toEqual([])
      expect(yield* flight.harness.running(flight.id)).toBe(true)
      // The root turn ends.
      yield* Deferred.succeed(flight.root, undefined)
      const turn = yield* Fiber.join(flight.turn)
      expect(textOf(turn)).toBe(ANSWER)
      yield* closed(flight)
      yield* writtenOnceAfterTheTurn(flight)
    }),
  { git: true },
  300_000,
)

it.instance(
  "[UI8] the user aborts the root session while its turn is in flight: the turn and the run stop, the summary is written once after the turn, and a later prompt runs a model turn",
  () =>
    Effect.gen(function* () {
      const flight = yield* inFlight
      // When the user aborts the root session: its turn stops, and the /task job of the session is cancelled.
      yield* flight.prompt.cancel(flight.session)
      yield* Fiber.await(flight.turn)
      yield* closed(flight)
      const stored = yield* TaskEvents.read((yield* Database.Service).db, flight.id)
      expect(stored.filter((fact) => fact.type === "run.cancelled")).toHaveLength(1)
      expect(stored.some((fact) => fact.type === "scenario.verified" && fact.verdict.id === "S4")).toBe(false)
      // Then the summary is written once, after the aborted turn.
      yield* writtenOnceAfterTheTurn(flight)
      yield* Deferred.succeed(flight.judge, undefined)
      yield* Deferred.succeed(flight.root, undefined)
    }),
  { git: true },
  300_000,
)

it.instance(
  "[UI8] the run is cancelled while a root turn is in flight: the summary waits for the turn, is then written once, and a later prompt runs a model turn",
  () =>
    Effect.gen(function* () {
      const flight = yield* inFlight
      // When the run is cancelled: its job is cancelled; the run records run.cancelled and frees the lease. The cancel
      // returns once the job's finalizers end, so it runs on its own fiber while the root turn goes on.
      const cancelling = yield* (yield* BackgroundJob.Service).cancel(flight.id).pipe(Effect.forkChild)
      const slice = yield* runFinal(flight, "run.cancelled")
      // Then the summary waits for the turn: nothing is written while the root turn runs.
      yield* Effect.sleep("500 millis")
      expect(yield* summariesOf(flight)).toEqual([])
      expect(summaryLog(flight.id)).toEqual([])
      // The root turn ends (within the cancel deadline).
      yield* Deferred.succeed(flight.root, undefined)
      const turn = yield* Fiber.join(flight.turn)
      expect(textOf(turn)).toBe(ANSWER)
      yield* Fiber.join(cancelling)
      yield* closed(flight)
      ended(flight, slice)
      yield* writtenOnceAfterTheTurn(flight)
      yield* Deferred.succeed(flight.judge, undefined)
    }),
  { git: true },
  300_000,
)
