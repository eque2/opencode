import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Logger, Option, Predicate } from "effect"
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
import { InstanceRef } from "@/effect/instance-ref"
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
import { TaskCommand } from "@/task/core/command"
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
import { facts, loadPlan, trustLeaf, unitState } from "./lib/machine"

// Scenario UI23 (spec task-harness-feedback, D18, AD-18, AD-19; task T4.11): a summary that cannot be written does
// not hold the run open.
//
//   Given a run whose root session was deleted before the run ends
//   When the run machine reaches a final state
//   Then the failed say is logged
//   And the run supervisor reaches closed, the job ends and the directory lease is released
//   And the next /task in the directory is not busy
//
// Everything is the product's own wiring, as for UI7: the session runtime of `SessionPrompt` (its layer graph as the
// session tests build it, with the scripted model server), the process-wide harness root `TaskHarness.Service`, the
// real background jobs, the real event and session stores, and a seeded git instance; `/task` is typed through
// `SessionPrompt.command`, and the root session is deleted with `Session.remove`.
//
// The Given: a stored, unended slice of the whole spec in which T1.1 to T1.4 and every scenario they allow are
// trusted, and T1.5 waits on the outside T9 (`/task trust T9` was never typed). `/task` resumes it: the run is live,
// and no session of the run is active. Two ways the root session goes away:
// - deleted outside the run's instance (`Session.remove` with no instance, as for a session cleaned up without
//   instance state): the job is not touched, so the run is still live after the deletion; the user then cancels the
//   job, which makes the run machine final, and the summary's `say` finds no root session;
// - deleted by the product's own delete in the instance: `Session.remove` first cancels the session's background jobs,
//   so the deletion itself ends the run.
// The next /task comes from another session, with an untracked file in the checkout: it passes the busy check and is
// refused by the git readiness check that follows it, so it starts no second job.

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

// The stored slice: T1.1 to T1.4 trusted, every scenario they allow trusted; T1.5 waits on the untrusted T9, so T1,
// S5 and the run wait; S13 is parked on T8.
const sliceOf = (plan: Plan, base: string): ReadonlyArray<Fact> => {
  const start = Date.now() - 600_000
  const f = facts(start)
  return [
    { type: "run.started", at: start, base, path: SPEC },
    ...["T1.1", "T1.2", "T1.3", "T1.4"].flatMap((task) => trustLeaf(plan, f, task)),
    ...["S1", "S2", "S3", "S4", "S6", "S7", "S8", "S9", "S10", "S11", "S12"].flatMap((id) => [
      f.scenarioProved(id, "passed"),
      f.scenarioVerified({ id, verdict: "trusted" }),
    ]),
  ]
}

const textOf = (message: SessionV1.WithParts) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

// A live run of the stored slice, resumed by `/task` in a fresh root session.
const liveRun = Effect.gen(function* () {
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
  const background = yield* BackgroundJob.Service
  const plan = yield* loadPlan("release-notes.spec")
  const id = TaskEvents.runID(directory, SPEC)
  const slice = sliceOf(plan, branch)
  const given = TaskEvents.fold(TaskEngineXState.XStateEngine, plan, slice)
  expect(TaskEngineXState.ended(given)).toBe(false)
  expect(["T1.5", "S5", "S13"].map((unit) => unitState(given, unit))).toEqual(["waiting", "waiting", "parked"])
  for (const fact of slice) yield* TaskEvents.publish(events, id, fact)

  const root = yield* sessions.create({ title: "UI23 root" })
  const header = yield* prompt.command({ sessionID: root.id, command: "task", arguments: SPEC })
  expect(textOf(header)).toBe(HEADER)
  const stored = () => Effect.flatMap(Database.Service, (db) => TaskEvents.read(db.db, id))
  yield* pollWithTimeout(
    Effect.map(stored(), (list) => (list.some((fact) => fact.type === "run.resumed") ? true : undefined)),
    "the run never resumed",
    "60 seconds",
  )
  const supervisor = Option.getOrThrow(yield* harness.system.get(TaskHarness.systemId.run(id)))
  expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))
  expect((yield* background.get(id))?.status).toBe("running")

  // `/task` from another session in the directory: its reply.
  const other = yield* sessions.create({ title: "UI23 other" })
  const next = Effect.map(prompt.command({ sessionID: other.id, command: "task", arguments: SPEC }), textOf)
  // While the run is live, the directory is busy: the control for "not busy" below.
  const busy = TaskCommand.busyLine({ runID: id, spec: SPEC, path: SPEC })
  expect(yield* next).toBe(busy)
  return { directory, id, root: root.id, sessions, harness, background, supervisor, stored, next, busy }
})

type Live = Effect.Success<typeof liveRun>

// The run machine is final, the run supervisor has closed, the job has ended and the lease is free; the next /task
// in the directory is not busy.
const closedAndFree = (run: Live, job: BackgroundJob.Status) =>
  Effect.gen(function* () {
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const info = yield* run.background.get(run.id)
        if (info === undefined || info.status === "running") return undefined
        return (yield* run.harness.running(run.id)) ? undefined : info.status
      }),
      "the job never ended",
      "60 seconds",
    )
    // The run machine is final: the stored run ends with the cancel.
    const last = TaskEvents.latestRun(yield* run.stored())
    expect(Option.map(last, (list) => list.at(-1)?.type)).toEqual(Option.some("run.cancelled"))
    // The run supervisor reached closed; the job ended; the lease is released.
    const snapshot = yield* run.supervisor.getSnapshot
    expect({ status: snapshot.status, value: snapshot.value }).toEqual({ status: "done", value: "closed" })
    expect((yield* run.background.get(run.id))?.status).toBe(job)
    expect(yield* run.harness.live(run.directory)).toEqual(Option.none())
    expect(
      logged.filter(
        (entry) => JSON.stringify(entry).includes("run supervisor") && JSON.stringify(entry).includes(run.id),
      ),
    ).toEqual([])
    // And the next /task in the directory is not busy: it goes past the live-run check to the git readiness check,
    // which refuses it because of an untracked file, so it starts no job.
    const { directory } = run
    const fsutil = yield* FSUtil.Service
    yield* fsutil.writeWithDirs(path.join(directory, "notes.txt"), "not committed\n")
    const reply = yield* run.next
    expect(reply).not.toBe(run.busy)
    expect(reply).toStartWith(`Refused ${SPEC}. No work started.`)
    expect(reply).toContain("notes.txt")
    expect(yield* run.harness.live(directory)).toEqual(Option.none())
  })

it.instance(
  "[UI23] a root session deleted while its run goes on: when the run machine is final, the failed say is logged, the supervisor closes, the job ends, the lease is free and the next /task is not busy",
  () =>
    Effect.gen(function* () {
      const run = yield* liveRun
      // Given the root session deleted outside the run's instance: the run goes on.
      yield* run.sessions.remove(run.root).pipe(Effect.provideService(InstanceRef, Option.none()))
      expect(Exit.isFailure(yield* Effect.exit(run.sessions.get(run.root)))).toBe(true)
      expect((yield* run.background.get(run.id))?.status).toBe("running")
      expect(yield* run.harness.running(run.id)).toBe(true)
      // When the run machine reaches a final state: the user cancels the run's job.
      yield* run.background.cancel(run.id)
      yield* closedAndFree(run, "cancelled")
      // Then the failed say is logged: the summary found no root session.
      const failures = summaryLog(run.id)
      expect(failures).toHaveLength(1)
      expect(failures[0]).toStartWith("task harness: the closing summary could not be written: ")
      expect(failures[0]).toContain("NotFound")
    }),
  { git: true },
  180_000,
)

it.instance(
  "[UI23] a root session deleted by the product's delete: the run ends, the supervisor closes, the job ends, the lease is free and the next /task is not busy",
  () =>
    Effect.gen(function* () {
      const run = yield* liveRun
      // Given the root session deleted in its instance: the delete cancels the session's /task job first.
      yield* run.sessions.remove(run.root)
      expect(Exit.isFailure(yield* Effect.exit(run.sessions.get(run.root)))).toBe(true)
      yield* closedAndFree(run, "cancelled")
    }),
  { git: true },
  180_000,
)
