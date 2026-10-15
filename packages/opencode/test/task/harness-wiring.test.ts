import { NodeServices } from "@effect/platform-node"
import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Fiber, Logger, Option, Schema } from "effect"
import { assign, setup } from "@jambudipa/xstate-effect"
import type { Tool as AITool } from "ai"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { TaskHarness } from "@/task/core/harness"
import { TaskHooks } from "@/task/core/hooks"
import type { Verdict } from "@/task/core/model"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The wiring of the task harness: the `task` command, its two hidden agents and their one-turn tools.

const it = testEffect(
  LayerNode.compile(LayerNode.group([Agent.node, Command.node, RuntimeFlags.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({})],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

const call = { toolCallId: "call_1", messages: [] }

const node = testEffect(NodeServices.layer)

const ToolResult = Schema.Struct({ title: Schema.String, output: Schema.String, metadata: Schema.Struct({ valid: Schema.Boolean }) })

// Runs a harness tool's `execute` and reads its result.
const exec = (tool: AITool, input: unknown) =>
  Effect.promise(() => Promise.resolve(tool.execute!(input, call))).pipe(
    Effect.map(Schema.decodeUnknownSync(ToolResult)),
  )

const tools = (agent: string, sessionID: SessionID, hooks?: TaskHooks.HarnessHooks) =>
  SessionPrompt.createTaskHarnessTools(agent, sessionID, hooks)

describe("the harness-only tools", () => {
  node.live("only the builder gets task_ready and only the verifier gets verdict", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_wiring_tools")
      expect(Object.keys(yield* tools(TaskHooks.BUILDER, sessionID))).toEqual(["task_ready"])
      expect(Object.keys(yield* tools(TaskHooks.VERIFIER, sessionID))).toEqual(["verdict"])
      expect(yield* tools("build", sessionID)).toEqual({})
    }),
  )

  node.live("task_ready records the request for the session", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_wiring_ready")
      const tool = (yield* tools(TaskHooks.BUILDER, sessionID)).task_ready
      const result = yield* exec(tool, { summary: "parser done" })
      expect(result.output).toBe("Ready recorded. End your turn now: the harness runs the proofs.")
      expect(TaskHooks.takeReady(sessionID)).toEqual({ summary: "parser done" })
    }),
  )

  node.live("verdict records every verdict, and refuses an invalid input without recording", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_wiring_verdict")
      const tool = (yield* tools(TaskHooks.VERIFIER, sessionID)).verdict
      const verdicts: Verdict[] = [
        { id: "T1.1.c1", verdict: "trusted" },
        { id: "T1.1.c2", verdict: "rejected", reason: "weak" },
      ]
      const result = yield* exec(tool, { verdicts })
      expect(result.output).toBe("Recorded 2 verdicts.")
      expect(TaskHooks.takeVerdicts(sessionID)).toEqual(verdicts)

      const invalid = yield* exec(tool, { verdicts: [{ id: "T1.1.c1", verdict: "maybe" }] })
      expect(invalid.metadata.valid).toBe(false)
      expect(TaskHooks.takeVerdicts(sessionID)).toBeUndefined()
    }),
  )
})

// An owner stand-in for the routing tests: it keeps the hook events it receives, and holds a repetition limit.
const ownerWith = (limit: number) =>
  setup({
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
    types: {} as {
      context: { events: ReadonlyArray<TaskHooks.HookEvent>; limit: number }
      events: TaskHooks.HookEvent
    },
  }).createMachine({
    context: { events: [], limit },
    on: {
      "hook.ready": { actions: assign({ events: ({ context, event }) => [...context.events, event] }) },
      "hook.verdicts": { actions: assign({ events: ({ context, event }) => [...context.events, event] }) },
      "hook.repeated": { actions: assign({ events: ({ context, event }) => [...context.events, event] }) },
    },
  })

const owner = ownerWith(3)

const decodeEvents = Schema.decodeUnknownSync(Schema.Struct({ context: Schema.Struct({ events: Schema.Array(Schema.Unknown) }) }))

const eventsOf = (harness: TaskHarness.Interface, runID: string) =>
  Effect.gen(function* () {
    const ref = yield* harness.system.get(TaskHarness.systemId.run(runID))
    if (Option.isNone(ref)) return yield* Effect.die(new Error(`no actor run:${runID}`))
    return decodeEvents(yield* ref.value.getSnapshot).context.events
  })

// A send to a child only queues it: wait until the owner holds `count` events.
const received = (harness: TaskHarness.Interface, runID: string, count: number) =>
  Effect.gen(function* () {
    const wait = yield* Effect.forkChild(
      Effect.gen(function* () {
        while ((yield* eventsOf(harness, runID)).length < count) yield* Effect.sleep(5)
      }),
    )
    yield* Fiber.join(wait).pipe(Effect.timeout(2_000))
    return yield* eventsOf(harness, runID)
  })

// A harness with one live owner, `run:task_a`, that has claimed `session`.
const owned = (session: string, watch: boolean, logic = owner) =>
  Effect.gen(function* () {
    const harness = yield* TaskHarness.make
    yield* harness.spawnRun("task_a", logic)
    yield* harness.claimSession({ session, owner: TaskHarness.systemId.run("task_a"), watch })
    return harness
  })

const bash = { tool: "bash", input: { command: "ls" } }

describe("the hook routing (AD-11)", () => {
  node.live("task_ready in a claimed builder session sends hook.ready to its owner and answers as today", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_route_ready")
      const harness = yield* owned(sessionID, true)
      const tool = (yield* tools(TaskHooks.BUILDER, sessionID, harness.hooks)).task_ready
      const result = yield* exec(tool, { summary: "parser done" })
      expect(result).toEqual({
        title: "Task ready",
        output: "Ready recorded. End your turn now: the harness runs the proofs.",
        metadata: { valid: true },
      })
      expect(yield* received(harness, "task_a", 1)).toEqual([
        { type: "hook.ready", session: sessionID, summary: "parser done" },
      ])
      // The routed tool leaves the polled runner's map alone.
      expect(TaskHooks.takeReady(sessionID)).toBeUndefined()
    }),
  )

  node.live("verdict in a claimed verifier session sends hook.verdicts; an invalid verdict sends nothing", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_route_verdict")
      const harness = yield* owned(sessionID, false)
      const tool = (yield* tools(TaskHooks.VERIFIER, sessionID, harness.hooks)).verdict
      const invalid = yield* exec(tool, { verdicts: [{ id: "T1.1.c1", verdict: "maybe" }] })
      expect(invalid.metadata.valid).toBe(false)
      const verdicts: Verdict[] = [
        { id: "T1.1.c1", verdict: "trusted" },
        { id: "T1.1.c2", verdict: "rejected", reason: "weak" },
      ]
      const result = yield* exec(tool, { verdicts })
      expect(result.output).toBe("Recorded 2 verdicts.")
      // Only the valid call arrived.
      expect(yield* received(harness, "task_a", 1)).toEqual([{ type: "hook.verdicts", session: sessionID, verdicts }])
      expect(TaskHooks.takeVerdicts(sessionID)).toBeUndefined()
    }),
  )

  node.live("SV13 a tool call in a session with no owner records nothing and says so", () =>
    Effect.gen(function* () {
      const harness = yield* owned("ses_route_other", true)
      const sessionID = SessionID.make("ses_route_nobody")
      const ready = (yield* tools(TaskHooks.BUILDER, sessionID, harness.hooks)).task_ready
      const verdict = (yield* tools(TaskHooks.VERIFIER, sessionID, harness.hooks)).verdict
      expect(yield* exec(ready, { summary: "done" })).toEqual({
        title: "Task ready",
        output: "No task harness run owns this session. Nothing was recorded.",
        metadata: { valid: false },
      })
      const answer = yield* exec(verdict, { verdicts: [{ id: "T1.1.c1", verdict: "trusted" }] })
      expect(answer).toEqual({
        title: "Verdict",
        output: "No task harness run owns this session. Nothing was recorded.",
        metadata: { valid: false },
      })
      expect(yield* eventsOf(harness, "task_a")).toEqual([])
      expect(TaskHooks.takeReady(sessionID)).toBeUndefined()
      expect(TaskHooks.takeVerdicts(sessionID)).toBeUndefined()
    }),
  )

  node.live("a session whose owner has stopped records nothing; a re-claim by a respawned owner replaces it", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_route_stopped")
      const harness = yield* TaskHarness.make
      // The index names an owner that is not in the system: `system.get` answers none.
      yield* harness.claimSession({ session: sessionID, owner: TaskHarness.systemId.task("task_a", "T1.1"), watch: true })
      const tool = (yield* tools(TaskHooks.BUILDER, sessionID, harness.hooks)).task_ready
      const stopped = yield* exec(tool, {})
      expect(stopped.output).toBe("No task harness run owns this session. Nothing was recorded.")
      expect(stopped.metadata.valid).toBe(false)
      expect(yield* harness.hooks.limitOf(sessionID)).toEqual(Option.none())
      expect(yield* TaskHooks.repetitionStop(harness.hooks, sessionID, [bash, bash, bash])).toEqual(Option.none())
      // The respawned owner claims the reused session before its turn, and the next call reaches it.
      yield* harness.spawnRun("task_b", owner)
      yield* harness.claimSession({ session: sessionID, owner: TaskHarness.systemId.run("task_b"), watch: true })
      const again = yield* exec(tool, {})
      expect(again.metadata.valid).toBe(true)
      expect(yield* received(harness, "task_b", 1)).toEqual([{ type: "hook.ready", session: sessionID }])
    }),
  )
})

// A value in the context where the tools are created: the hook Effects must run with it (EFX-31).
class Captured extends Context.Service<Captured, string>()("test/TaskHarnessCaptured") {}

describe("the context of the tools' execute (EFX-31)", () => {
  node.live("runs each hook Effect with the context that createTaskHarnessTools captured", () =>
    Effect.gen(function* () {
      const seen: Array<Option.Option<string>> = []
      // A routing that reads the captured value when it sends.
      const hooks: TaskHooks.HarnessHooks = {
        ownerOf: () => Effect.succeed(Option.some({ owner: "run:task_a", watch: true })),
        limitOf: () => Effect.succeed(Option.some(3)),
        send: () =>
          Effect.map(Effect.serviceOption(Captured), (value) => {
            seen.push(value)
            return true
          }),
      }
      const sessionID = SessionID.make("ses_route_context")
      const created = yield* tools(TaskHooks.BUILDER, sessionID, hooks).pipe(Effect.provideService(Captured, "run 1"))
      const verdicts = yield* tools(TaskHooks.VERIFIER, sessionID, hooks).pipe(Effect.provideService(Captured, "run 2"))
      // `execute` runs later, outside the provide: only a captured context still holds the value.
      expect((yield* exec(created.task_ready, { summary: "done" })).metadata.valid).toBe(true)
      expect((yield* exec(verdicts.verdict, { verdicts: [{ id: "T1.1.c1", verdict: "trusted" }] })).metadata.valid).toBe(
        true,
      )
      expect(seen).toEqual([Option.some("run 1"), Option.some("run 2")])
    }),
  )
})

describe("the repetition stop over the hooks", () => {
  test("the pure check matches only the last limit calls of one tool with one input", () => {
    const other = { tool: "bash", input: { command: "pwd" } }
    expect(TaskHooks.repetition(3, [bash, bash])).toEqual(Option.none())
    expect(TaskHooks.repetition(3, [other, bash, bash, bash])).toEqual(
      Option.some("repetition: 3 identical bash calls in a row"),
    )
    expect(TaskHooks.repetition(3, [bash, other, bash])).toEqual(Option.none())
    expect(TaskHooks.repetition(2, [other, bash, bash])).toEqual(
      Option.some("repetition: 2 identical bash calls in a row"),
    )
  })

  node.live("reads the limit from the owner's snapshot, ends the turn on a match and sends hook.repeated", () =>
    Effect.gen(function* () {
      const sessionID = "ses_route_watch"
      const harness = yield* owned(sessionID, true)
      expect(yield* harness.hooks.limitOf(sessionID)).toEqual(Option.some(3))
      // Below the limit: no stop and no send.
      expect(yield* TaskHooks.repetitionStop(harness.hooks, sessionID, [bash, bash])).toEqual(Option.none())
      expect(yield* eventsOf(harness, "task_a")).toEqual([])
      const reason = "repetition: 3 identical bash calls in a row"
      expect(yield* TaskHooks.repetitionStop(harness.hooks, sessionID, [bash, bash, bash])).toEqual(Option.some(reason))
      expect(yield* received(harness, "task_a", 1)).toEqual([{ type: "hook.repeated", session: sessionID, reason }])
    }),
  )

  node.live("reads the owner's own limit, and reads it before any send", () =>
    Effect.gen(function* () {
      const sessionID = "ses_route_limit"
      const harness = yield* owned(sessionID, true, ownerWith(2))
      expect(yield* harness.hooks.limitOf(sessionID)).toEqual(Option.some(2))
      // One call is below the owner's limit of 2; two identical calls stop the turn.
      expect(yield* TaskHooks.repetitionStop(harness.hooks, sessionID, [bash])).toEqual(Option.none())
      const order: Array<string> = []
      const spy: TaskHooks.HarnessHooks = {
        ownerOf: (session) => harness.hooks.ownerOf(session).pipe(Effect.tap(() => Effect.sync(() => order.push("ownerOf")))),
        limitOf: (session) => harness.hooks.limitOf(session).pipe(Effect.tap(() => Effect.sync(() => order.push("limitOf")))),
        send: (event) =>
          Effect.sync(() => order.push(`send ${event.type}`)).pipe(Effect.andThen(harness.hooks.send(event))),
      }
      const reason = "repetition: 2 identical bash calls in a row"
      expect(yield* TaskHooks.repetitionStop(spy, sessionID, [bash, bash])).toEqual(Option.some(reason))
      expect(order).toEqual(["ownerOf", "limitOf", "send hook.repeated"])
      expect(yield* received(harness, "task_a", 1)).toEqual([{ type: "hook.repeated", session: sessionID, reason }])
    }),
  )

  node.live("never stops a session that is not watched or has no owner", () =>
    Effect.gen(function* () {
      const harness = yield* owned("ses_route_judge", false)
      expect(yield* TaskHooks.repetitionStop(harness.hooks, "ses_route_judge", [bash, bash, bash])).toEqual(
        Option.none(),
      )
      expect(yield* TaskHooks.repetitionStop(harness.hooks, "ses_route_none", [bash, bash, bash])).toEqual(
        Option.none(),
      )
      expect(yield* eventsOf(harness, "task_a")).toEqual([])
    }),
  )
})

describe("the harness agents' shell", () => {
  test("gets the proof allowlist: no provider key or token; other agents keep their environment", () => {
    const env = { PATH: "/bin", HOME: "/home/dev", OPENAI_API_KEY: "sk-1", GITHUB_TOKEN: "ghp-2" }
    expect(TaskHooks.shellEnvironment(TaskHooks.BUILDER, env)).toEqual({ PATH: "/bin", HOME: "/home/dev" })
    expect(TaskHooks.shellEnvironment(TaskHooks.VERIFIER, env)).toEqual({ PATH: "/bin", HOME: "/home/dev" })
    expect(TaskHooks.shellEnvironment("build", env)).toBe(env)
  })
})

describe("the repetition watch", () => {
  test("watches a session from watch to unwatch, and stops it after the limit of identical calls", () => {
    const sessionID = "ses_wiring_watch"
    const call = { tool: "bash", input: { command: "ls" } }
    expect(TaskHooks.watching(sessionID)).toBe(false)
    TaskHooks.watch(sessionID, 3)
    expect(TaskHooks.watching(sessionID)).toBe(true)
    expect(TaskHooks.checkRepetition(sessionID, [call, call])).toBeUndefined()
    expect(TaskHooks.checkRepetition(sessionID, [call, call, call])).toBe("repetition: 3 identical bash calls in a row")
    expect(TaskHooks.takeRepeated(sessionID)).toBe("repetition: 3 identical bash calls in a row")
    TaskHooks.unwatch(sessionID)
    expect(TaskHooks.watching(sessionID)).toBe(false)
    expect(TaskHooks.checkRepetition(sessionID, [call, call, call])).toBeUndefined()
  })
})

describe("the task command and agents", () => {
  it.instance("are always present, with the harness permissions", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service.use((svc) => svc.get("task"))
      expect(command).toMatchObject({ name: "task", description: "Run a blend task tree", source: "command" })
      expect(command?.template).toBe("")

      const builder = yield* Agent.Service.use((svc) => svc.get(TaskHooks.BUILDER))
      const verifier = yield* Agent.Service.use((svc) => svc.get(TaskHooks.VERIFIER))
      expect(builder).toMatchObject({ mode: "primary", hidden: true, native: true })
      expect(verifier).toMatchObject({ mode: "primary", hidden: true, native: true })
      const action = (agent: Agent.Info, permission: string, pattern = "*") =>
        Permission.evaluate(permission, pattern, agent.permission).action
      // Deny by default: only the tools each role needs ride on its requests (a live run is capped in tokens).
      for (const permission of ["verdict", "question", "task", "webfetch", "todowrite", "skill"])
        expect(action(builder, permission)).toBe("deny")
      for (const permission of ["bash", "edit", "write", "read", "grep", "task_ready", "doom_loop"])
        expect(action(builder, permission)).toBe("allow")
      // Builders stay in their worktree, and the verifier reads only.
      expect(action(builder, "external_directory", "/etc/*")).toBe("deny")
      expect(action(verifier, "external_directory", "/etc/*")).toBe("deny")
      for (const permission of ["task_ready", "edit", "write", "apply_patch", "question", "task", "webfetch"])
        expect(action(verifier, permission)).toBe("deny")
      for (const command of ["bun --no-env-file test", "git diff HEAD~1", "git log --oneline", "git show HEAD", "git status"])
        expect(action(verifier, "bash", command)).toBe("allow")
      // A plain `bun test` would load the checkout's .env files.
      for (const command of ["bun test", "rm -rf src", "echo x > src/a.ts", "git commit -am x", "git checkout -- .", "sh -c 'x'"])
        expect(action(verifier, "bash", command)).toBe("deny")
      // The harness stops a repetition itself (TaskHooks.checkRepetition); doom_loop must not end the turn first.
      for (const permission of ["read", "verdict", "doom_loop"]) expect(action(verifier, permission)).toBe("allow")
      // A builder or verifier that would ask would hang a headless run.
      expect(builder.permission.some((rule) => rule.action === "ask")).toBe(false)
    }),
  )

  it.instance(
    "keep the user's deny rules, and leave out the user's allow and ask rules",
    () =>
      Effect.gen(function* () {
        const builder = yield* Agent.Service.use((svc) => svc.get(TaskHooks.BUILDER))
        const verifier = yield* Agent.Service.use((svc) => svc.get(TaskHooks.VERIFIER))
        const action = (agent: Agent.Info, permission: string, pattern = "*") =>
          Permission.evaluate(permission, pattern, agent.permission).action
        expect(action(builder, "bash", "rm -rf src")).toBe("deny")
        expect(action(builder, "edit", "secrets/key.ts")).toBe("deny")
        expect(action(verifier, "bash", "git log --oneline")).toBe("deny")
        // The harness rules still decide what the user did not deny.
        expect(action(builder, "bash", "bun test")).toBe("allow")
        expect(action(builder, "edit", "src/a.ts")).toBe("allow")
        expect(action(verifier, "bash", "git status")).toBe("allow")
        // An ask would hang a headless run, and a user allow must not widen a role.
        expect(action(builder, "bash", "git push origin dev")).toBe("allow")
        expect(action(builder, "webfetch")).toBe("deny")
        expect(builder.permission.some((rule) => rule.action === "ask")).toBe(false)
        expect(verifier.permission.some((rule) => rule.action === "ask")).toBe(false)
      }),
    {
      config: {
        permission: {
          bash: { "rm *": "deny", "git log*": "deny", "git push*": "ask" },
          edit: { "secrets/*": "deny" },
          webfetch: "allow",
        },
      },
    },
  )
})

describe("a configured task command", () => {
  it.instance(
    "does not replace the harness, and is reported by name",
    () =>
      Effect.gen(function* () {
        const messages: unknown[] = []
        const command = yield* Command.Service.use((svc) => svc.get("task")).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make<unknown, void>((options) => {
                messages.push(options.message)
              }),
            ]),
          ),
        )
        expect(command).toMatchObject({ name: "task", description: "Run a blend task tree", source: "command" })
        expect(command?.template).toBe("")
        expect(messages).toContainEqual([
          "command shadowed by the built-in task harness",
          expect.objectContaining({ command: "task", source: "config" }),
        ])
      }),
    { config: { command: { task: { template: "Do my own task flow for $ARGUMENTS", description: "mine" } } } },
  )

  it.instance(
    "a skill named task does not replace the harness either, and is reported by name",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        yield* Effect.promise(() =>
          Bun.write(
            `${directory}/.opencode/skill/task/SKILL.md`,
            "---\nname: task\ndescription: My own task skill.\n---\n\nDo the task my way.\n",
          ),
        )
        const messages: unknown[] = []
        const command = yield* Command.Service.use((svc) => svc.get("task")).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make<unknown, void>((options) => {
                messages.push(options.message)
              }),
            ]),
          ),
        )
        expect(command).toMatchObject({ name: "task", source: "command", template: "" })
        expect(messages).toContainEqual([
          "command shadowed by the built-in task harness",
          expect.objectContaining({ command: "task", source: "skill" }),
        ])
      }),
    { git: true },
  )
})
