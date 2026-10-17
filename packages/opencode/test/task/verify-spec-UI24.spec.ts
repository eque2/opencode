import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, FileSystem, Layer, Logger, Option, Predicate, Schema } from "effect"
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
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { git, seed, SPEC } from "./lib/command"
import { facts, loadPlan, trustLeaf } from "./lib/machine"

// Scenario UI24: a finished run frees its directory after the writer's done snapshot, while its summary waits on
// the root session's real permission prompt. The test uses the SessionPrompt graph and the real /task job.

const summaryStub = Layer.mock(SessionSummary.Service, {
  summarize: () => Effect.void,
  diff: () => Effect.succeed([]),
  computeDiff: () => Effect.succeed([]),
})
const mcp = Layer.mock(MCP.Service, {
  status: () => Effect.succeed({}),
  clients: () => Effect.succeed({}),
  instructions: () => Effect.succeed([]),
  tools: () => Effect.succeed({}),
  prompts: () => Effect.succeed({}),
  resources: () => Effect.succeed({}),
  resourceTemplates: () => Effect.succeed({}),
})
const lsp = Layer.mock(LSP.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  hasClients: () => Effect.succeed(false),
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
})

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

interface ReleaseObservation {
  readonly lease: "held" | "free"
  readonly writer: "ended" | "running" | "unknown"
  readonly state: TaskStatus.Status["run"]["state"]
}

// Observe the real writer fiber and status file just before the real harness processes release.
const observedHarness = (released: ReleaseObservation[]) =>
  LayerNode.make({
    service: TaskHarness.Service,
    layer: Layer.effect(
      TaskHarness.Service,
      Effect.gen(function* () {
        const real = yield* TaskHarness.make
        const fs = yield* FileSystem.FileSystem
        return TaskHarness.Service.of({
          ...real,
          release: (directory, runID) =>
            Effect.gen(function* () {
              const live = yield* real.live(directory)
              const ref = yield* real.system.get(TaskHarness.systemId.run(runID))
              const snapshot: unknown = Option.isSome(ref) ? yield* ref.value.getSnapshot : undefined
              const context = Predicate.hasProperty(snapshot, "context") ? snapshot.context : undefined
              const fiber = Predicate.hasProperty(context, "writer") ? context.writer : undefined
              const writer = Fiber.isFiber(fiber) ? (fiber.pollUnsafe() === undefined ? "running" : "ended") : "unknown"
              const text = yield* fs
                .readFileString(path.join(directory, ".opencode/task/status.json"))
                .pipe(Effect.orDie)
              const status = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(text)
              released.push({
                lease: Option.isSome(live) && live.value.runID === runID ? "held" : "free",
                writer,
                state: status.run.state,
              })
              yield* real.release(directory, runID)
            }),
        })
      }),
    ).pipe(Layer.provide(NodeServices.layer)),
    deps: [Session.node, SessionStatus.node, EventV2Bridge.node, BackgroundJob.node, Database.node],
    tag: TaskHarness.node.tag,
  })

const logged: Array<unknown> = []
const scenario = (title: string, rootGone: boolean) => {
  const released: ReleaseObservation[] = []
  const it = testEffect(
    Layer.mergeAll(
      LayerNode.compile(root, [
        [TaskHarness.node, observedHarness(released)],
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
  it.instance(title, () => runCase(rootGone, released), { git: true }, 180_000)
}

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

const QUESTION = "ask permission for a shell command"
const OUTCOME = "Spec **Release notes from conventional commits** — done · 1 scenario not run"
const textOf = (message: SessionV1.WithParts) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

// All work is trusted except S4's judge; S13 is parked on T8. A trusted S4 ends the run done.
const sliceOf = (plan: Plan, base: string): ReadonlyArray<Fact> => {
  const start = Date.now() - 600_000
  const f = facts(start)
  return [
    { type: "run.started", at: start, base, path: SPEC },
    f.outside("T9"),
    ...["T1.1", "T1.2", "T1.3", "T1.4", "T1.5", "T1"].flatMap((task) => trustLeaf(plan, f, task)),
    ...["S1", "S2", "S3", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12"].flatMap((id) => [
      f.scenarioProved(id, "passed"),
      f.scenarioVerified({ id, verdict: "trusted" }),
    ]),
    f.scenarioProved("S4", "passed"),
  ]
}

const runCase = (rootGone: boolean, released: ReleaseObservation[]) =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const llm = yield* TestLLMServer
    const fsutil = yield* FSUtil.Service
    yield* fsutil.writeWithDirs(
      path.join(directory, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...configOf(llm.url) }),
    )
    yield* seed(SPEC)
    const base = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
    const plan = yield* loadPlan("release-notes.spec")
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const permission = yield* Permission.Service
    const harness = yield* TaskHarness.Service
    const background = yield* BackgroundJob.Service
    const id = TaskEvents.runID(directory, SPEC)
    const slice = sliceOf(plan, base)
    expect(TaskEngineXState.ended(TaskEvents.fold(TaskEngineXState.XStateEngine, plan, slice))).toBe(false)
    for (const fact of slice) yield* TaskEvents.publish(events, id, fact)

    const session = yield* sessions.create({
      title: "UI24 root",
      permission: [{ permission: "bash", pattern: "*", action: "ask" }],
    })
    const judge = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("You judge scenario S4")
    yield* llm.pushMatch(judge, reply().tool("verdict", { verdicts: [{ id: "S4", verdict: "trusted" }] }))
    yield* llm.pushMatch(judge, reply().text("Verdicts recorded.").stop())
    yield* llm.pushMatch(
      (hit) => JSON.stringify(hit.body).includes(QUESTION),
      reply().tool("bash", { command: "printf permission-granted", workdir: directory }),
    )
    yield* llm.pushMatch(
      (hit) => JSON.stringify(hit.body).includes(QUESTION),
      reply().text("The command finished.").stop(),
    )
    const header = yield* prompt.command({ sessionID: session.id, command: "task", arguments: SPEC })
    expect(textOf(header)).toContain("Implementing spec")
    expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))

    const turn = yield* prompt
      .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: QUESTION }] })
      .pipe(Effect.forkChild)
    const request = yield* pollWithTimeout(
      Effect.map(permission.list(), (pending) =>
        pending.find((item) => item.sessionID === session.id && item.permission === "bash"),
      ),
      "the root turn never reached a permission prompt",
      "60 seconds",
    )
    expect((yield* (yield* SessionStatus.Service).get(session.id)).type).toBe("busy")
    expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))

    // The judge ends the run while the permission request still holds the root turn.
    const final = yield* pollWithTimeout(
      Effect.gen(function* () {
        const stored = yield* TaskEvents.read((yield* Database.Service).db, id)
        if (!stored.some((fact) => fact.type === "scenario.verified" && fact.verdict.id === "S4")) return undefined
        const latest = TaskEvents.latestRun(stored)
        if (Option.isNone(latest)) return undefined
        const snapshot = TaskEvents.fold(TaskEngineXState.XStateEngine, plan, latest.value)
        return TaskEngineXState.ended(snapshot) ? snapshot : undefined
      }),
      "the run actor never reached done",
      "60 seconds",
    )
    expect(TaskEngineXState.view(final).run.state).toBe("done")
    yield* pollWithTimeout(
      Effect.map(harness.live(directory), (live) => (Option.isNone(live) ? true : undefined)),
      "the directory lease stayed busy while the summary waited",
      "60 seconds",
    )
    // The first release is the supervisor's, before the summary. The writer fiber has ended and
    // its final done snapshot is on disk while the lease is still held at that exact boundary.
    expect(released[0]).toEqual({ lease: "held", writer: "ended", state: "done" })
    const statusText = yield* fsutil.readFileString(path.join(directory, ".opencode/task/status.json"))
    const status = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(statusText)
    expect(status.run.state).toBe("done")
    expect(status.run.tags).toContain("ended")
    expect((yield* background.get(id))?.status).toBe("running")
    const before = yield* sessions.messages({ sessionID: session.id })
    expect(
      before.filter((message) => message.info.role === "assistant" && textOf(message).startsWith(OUTCOME)),
    ).toEqual([])
    expect((yield* permission.list()).map((item) => item.id)).toContain(request.id)

    // A second /task passes the live-run check. Git refuses the untracked file, so no second job disturbs the wait.
    yield* fsutil.writeWithDirs(path.join(directory, "notes.txt"), "not committed\n")
    const other = yield* sessions.create({ title: "UI24 next root" })
    const next = textOf(yield* prompt.command({ sessionID: other.id, command: "task", arguments: SPEC }))
    expect(next).not.toBe(TaskCommand.busyLine({ runID: id, spec: SPEC, path: SPEC }))
    expect(next).toStartWith(`Refused ${SPEC}. No work started.`)
    expect(next).toContain("notes.txt")
    expect((yield* background.get(id))?.status).toBe("running")

    if (rootGone) {
      // Deletion outside the instance leaves the job alive, as when the root session disappears remotely.
      yield* sessions.remove(session.id).pipe(Effect.provideService(InstanceRef, Option.none()))
      expect(Exit.isFailure(yield* Effect.exit(sessions.get(session.id)))).toBe(true)
    }
    yield* permission.reply({ requestID: request.id, reply: "once" })
    if (rootGone) yield* Fiber.await(turn)
    else yield* Fiber.join(turn)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const job = yield* background.get(id)
        return job?.status === "completed" && !(yield* harness.running(id)) ? true : undefined
      }),
      "the run did not close after the permission reply",
      "60 seconds",
    )
    const failures = logged.filter(
      (entry) => JSON.stringify(entry).includes("closing summary") && JSON.stringify(entry).includes(id),
    )
    if (rootGone) {
      expect(failures).toHaveLength(1)
      expect(JSON.stringify(failures[0])).toContain("could not be written")
      return
    }
    expect(failures).toEqual([])
    const messages = yield* sessions.messages({ sessionID: session.id })
    const summaries = messages.filter(
      (message) => message.info.role === "assistant" && textOf(message).startsWith(OUTCOME),
    )
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]
    if (summary?.info.role !== "assistant") throw new Error("no closing summary")
    expect(summary.info.parentID).toBe(header.info.id)
    expect(messages.at(-1)?.info.id).toBe(summary.info.id)
  })

scenario(
  "[UI24] a permission prompt holds the root turn; the done status precedes lease release, a second /task is not busy, and one summary follows the reply",
  false,
)

scenario(
  "[UI24] when the root disappears during the permission wait, the done run stays free and logs one failed summary",
  true,
)
