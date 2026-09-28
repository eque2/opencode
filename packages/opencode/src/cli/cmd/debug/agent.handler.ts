import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EOL } from "os"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { basename } from "path"
import { Cause, Clock, Effect, HashSet, Option, Predicate, Schema } from "effect"
import { Agent } from "../../../agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID } from "../../../session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "../../../permission"
import { fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const printJson = Effect.fn("Cli.debug.agent.printJson")(function* (value: unknown) {
  process.stdout.write((yield* encodeJson(value).pipe(Effect.orDie)) + EOL)
})

export const debugAgent = Effect.fn("Cli.debug.agent")(function* (args: {
  name: string
  tool?: string
  params?: string
}) {
  const instance = yield* InstanceRef
  if (Option.isNone(instance)) return
  yield* run(args, instance.value)
})

const run = Effect.fn("Cli.debug.agent.body")(function* (
  args: { name: string; tool?: string; params?: string },
  ctx: InstanceContext,
) {
  const agentName = args.name
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  if (!agent) {
    process.stderr.write(
      `Agent ${agentName} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  const availableTools = yield* getAvailableTools(agent)
  const resolvedTools = resolveTools(agent, availableTools)
  const toolID = args.tool
  if (toolID) {
    const tool = availableTools.find((item) => item.id === toolID)
    if (!tool) {
      process.stderr.write(`Tool ${toolID} not found for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    // resolveTools gives every available tool an entry, so a found tool always has one.
    if (!resolvedTools[toolID]) {
      process.stderr.write(`Tool ${toolID} is disabled for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    const params = yield* parseToolParams(args.params)
    const toolCtx = yield* createToolContext(agent, ctx)
    const result = yield* tool.execute(params, toolCtx)
    return yield* printJson({ tool: toolID, input: params, result })
  }

  return yield* printJson({
    ...agent,
    tools: resolvedTools,
  })
})

const getAvailableTools = Effect.fn("Cli.debug.agent.getAvailableTools")(function* (agent: Agent.Info) {
  const provider = yield* Provider.Service
  const registry = yield* ToolRegistry.Service
  const model =
    agent.model ??
    (yield* provider.defaultModel().pipe(
      Effect.matchCauseEffect({
        onSuccess: Effect.succeed,
        onFailure: (cause) => {
          const error = Cause.squash(cause)
          if (error instanceof Provider.ModelNotFoundError) {
            return fail(`Model not found: ${error.providerID}/${error.modelID}`)
          }
          if (error instanceof Provider.NoModelsError) return fail(`No models found for provider ${error.providerID}`)
          return fail("No providers found")
        },
      }),
    ))
  return yield* registry.tools({ ...model, agent })
})

function resolveTools(agent: Agent.Info, availableTools: { id: string }[]) {
  const disabled = Permission.disabled(
    availableTools.map((tool) => tool.id),
    agent.permission,
  )
  const resolved: Record<string, boolean> = {}
  for (const tool of availableTools) {
    resolved[tool.id] = !HashSet.has(disabled, tool.id)
  }
  return resolved
}

const parseToolParams = Effect.fn("Cli.debug.agent.parseToolParams")(function* (input?: string) {
  if (!input) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}

  const parsed: unknown = yield* decodeJson(trimmed).pipe(
    Effect.catch((jsonError) =>
      Effect.try({
        // --params accepts a JS object literal as well as JSON, so a JSON parse failure falls back to evaluation.
        try: (): unknown => new Function(`return (${trimmed})`)(),
        catch: (evalError) =>
          `Failed to parse --params. Use JSON or a JS object literal. JSON error: ${jsonError.message}. Eval error: ${String(evalError)}.`,
      }),
    ),
    Effect.catch((message) => fail(message)),
  )

  if (!Predicate.isObject(parsed)) return yield* fail("Tool params must be an object.")
  return parsed
})

const createToolContext = Effect.fn("Cli.debug.agent.createToolContext")(function* (
  agent: Agent.Info,
  ctx: InstanceContext,
) {
  const sessionSvc = yield* Session.Service
  const session = yield* sessionSvc.create({ title: `Debug tool run (${agent.name})` })
  const messageID = MessageID.ascending()
  const model = agent.model
    ? agent.model
    : yield* Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.defaultModel().pipe(
          Effect.matchCauseEffect({
            onSuccess: Effect.succeed,
            onFailure: (cause) => {
              const error = Cause.squash(cause)
              if (error instanceof Provider.ModelNotFoundError) {
                return fail(`Model not found: ${error.providerID}/${error.modelID}`)
              }
              if (error instanceof Provider.NoModelsError)
                return fail(`No models found for provider ${error.providerID}`)
              return fail("No providers found")
            },
          }),
        )
      })
  const now = yield* Clock.currentTimeMillis
  const message: SessionV1.Assistant = {
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    time: { created: now },
    parentID: messageID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "debug",
    agent: agent.name,
    path: {
      cwd: ctx.directory,
      root: ctx.worktree,
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* sessionSvc.updateMessage(message)

  const ruleset = Permission.merge(agent.permission, session.permission ?? [])

  return {
    sessionID: session.id,
    messageID,
    callID: PartID.ascending(),
    agent: agent.name,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask(req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) {
      // Tool.Context.ask has no error channel, so a denial is a defect, as the old throw was.
      const denied = req.patterns.some(
        (pattern) => Permission.evaluate(req.permission, pattern, ruleset).action === "deny",
      )
      return denied ? Effect.die(new PermissionV1.DeniedError({ ruleset })) : Effect.void
    },
  }
})
