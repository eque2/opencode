import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Logger } from "effect"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
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

describe("the harness-only tools", () => {
  test("only the builder gets task_ready and only the verifier gets verdict", () => {
    const sessionID = SessionID.make("ses_wiring_tools")
    expect(Object.keys(SessionPrompt.createTaskHarnessTools(TaskHooks.BUILDER, sessionID))).toEqual(["task_ready"])
    expect(Object.keys(SessionPrompt.createTaskHarnessTools(TaskHooks.VERIFIER, sessionID))).toEqual(["verdict"])
    expect(SessionPrompt.createTaskHarnessTools("build", sessionID)).toEqual({})
  })

  test("task_ready records the request for the session", async () => {
    const sessionID = SessionID.make("ses_wiring_ready")
    const tool = SessionPrompt.createTaskHarnessTools(TaskHooks.BUILDER, sessionID).task_ready
    const result = await tool.execute!({ summary: "parser done" }, call)
    expect(result.output).toBe("Ready recorded. End your turn now: the harness runs the proofs.")
    expect(TaskHooks.takeReady(sessionID)).toEqual({ summary: "parser done" })
  })

  test("verdict records every verdict, and refuses an invalid input without recording", async () => {
    const sessionID = SessionID.make("ses_wiring_verdict")
    const tool = SessionPrompt.createTaskHarnessTools(TaskHooks.VERIFIER, sessionID).verdict
    const verdicts: Verdict[] = [
      { id: "T1.1.c1", verdict: "trusted" },
      { id: "T1.1.c2", verdict: "rejected", reason: "weak" },
    ]
    const result = await tool.execute!({ verdicts }, call)
    expect(result.output).toBe("Recorded 2 verdicts.")
    expect(TaskHooks.takeVerdicts(sessionID)).toEqual(verdicts)

    const invalid = await tool.execute!({ verdicts: [{ id: "T1.1.c1", verdict: "maybe" }] }, call)
    expect(invalid.metadata.valid).toBe(false)
    expect(TaskHooks.takeVerdicts(sessionID)).toBeUndefined()
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
      for (const command of ["bun test", "git diff HEAD~1", "git log --oneline", "git show HEAD", "git status"])
        expect(action(verifier, "bash", command)).toBe("allow")
      for (const command of ["rm -rf src", "echo x > src/a.ts", "git commit -am x", "git checkout -- .", "sh -c 'x'"])
        expect(action(verifier, "bash", command)).toBe("deny")
      // The harness stops a repetition itself (TaskHooks.checkRepetition); doom_loop must not end the turn first.
      for (const permission of ["read", "verdict", "doom_loop"]) expect(action(verifier, permission)).toBe("allow")
      // A builder or verifier that would ask would hang a headless run.
      expect(builder.permission.some((rule) => rule.action === "ask")).toBe(false)
    }),
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
