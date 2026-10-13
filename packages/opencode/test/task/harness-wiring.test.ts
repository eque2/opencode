import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { TaskHooks } from "@/task/core/hooks"
import type { Verdict } from "@/task/core/model"
import { disposeAllInstances } from "../fixture/fixture"
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
      const action = (agent: Agent.Info, permission: string) =>
        Permission.evaluate(permission, "*", agent.permission).action
      // Deny by default: only the tools each role needs ride on its requests (a live run is capped in tokens).
      for (const permission of ["verdict", "question", "task", "webfetch", "todowrite", "skill"])
        expect(action(builder, permission)).toBe("deny")
      for (const permission of ["bash", "edit", "write", "read", "grep", "task_ready", "external_directory", "doom_loop"])
        expect(action(builder, permission)).toBe("allow")
      for (const permission of ["task_ready", "edit", "write", "apply_patch", "question", "task", "webfetch"])
        expect(action(verifier, permission)).toBe("deny")
      // The harness stops a repetition itself (TaskHooks.checkRepetition); doom_loop must not end the turn first.
      for (const permission of ["bash", "read", "verdict", "doom_loop"]) expect(action(verifier, permission)).toBe("allow")
      // A builder or verifier that would ask would hang a headless run.
      expect(builder.permission.some((rule) => rule.action === "ask")).toBe(false)
    }),
  )
})
