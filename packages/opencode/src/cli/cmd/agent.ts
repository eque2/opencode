import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import matter from "gray-matter"
import { EOL } from "os"
import type { Argv } from "yargs"
import { Cause, Console, Effect, Option, Schema } from "effect"
import { effectCmd } from "../effect-cmd"
import * as Prompt from "../effect/prompt"

type AgentMode = "all" | "primary" | "subagent"

const encodePrettyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

// Permission keys (not raw tool names). Multiple tools can map to a single
// permission — e.g. write/edit/apply_patch all gate on `edit` — so we configure
// agents at the permission level to match how the runtime actually enforces it.
const AVAILABLE_PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
]

const AgentCreateCommand = effectCmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: "directory path to generate the agent file",
      })
      .option("description", {
        type: "string",
        describe: "what the agent should do",
      })
      .option("mode", {
        type: "string",
        describe: "agent mode",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("permissions", {
        type: "string",
        alias: ["tools"],
        describe: `comma-separated list of permissions to allow (default: all). Available: "${AVAILABLE_PERMISSIONS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      }),
  handler: Effect.fn("Cli.agent.create")(function* (args) {
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    // effectCmd always provides the instance for this command; a missing one is a defect.
    const ctx = yield* Effect.fromOption(yield* InstanceRef).pipe(
      Effect.catch(() => Effect.die("InstanceRef not provided")),
    )
    const agentSvc = yield* Agent.Service
    const fs = yield* FSUtil.Service
    const perms = args.permissions

    const isFullyNonInteractive = Boolean(args.path && args.description && args.mode && perms !== undefined)

    if (!isFullyNonInteractive) {
      yield* Effect.sync(() => UI.empty())
      yield* Prompt.intro("Create agent")
    }

    // Determine scope/path
    const targetPath = args.path
      ? path.join(args.path, "agents")
      : path.join(
          (ctx.project.vcs === "git" ? yield* selectScope(ctx.worktree) : "global") === "global"
            ? Global.Path.config
            : path.join(ctx.worktree, ".opencode"),
          "agents",
        )

    // Get description
    const description = args.description
      ? args.description
      : yield* Prompt.text({
          message: "Description",
          placeholder: "What should this agent do?",
          validate: (x) => {
            if (x && x.length > 0) return undefined
            return "Required"
          },
        }).pipe(Effect.flatMap(required))

    // Generate agent
    const spinner = Prompt.spinner()
    yield* spinner.start("Generating agent configuration...")
    const generated = yield* agentSvc
      .generate({ description, ...(args.model ? { model: Provider.parseModel(args.model) } : {}) })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Cause.squash(cause)
            yield* spinner.stop(`LLM failed to generate agent: ${error instanceof Error ? error.message : String(error)}`, 1)
            if (isFullyNonInteractive) yield* exit(1)
            return yield* cancelled()
          }),
        ),
      )
    yield* spinner.stop(`Agent ${generated.identifier} generated`)

    // Select permissions to allow
    const selected =
      perms !== undefined
        ? perms
          ? perms.split(",").map((t) => t.trim())
          : AVAILABLE_PERMISSIONS
        : yield* Effect.promise(() =>
            prompts.multiselect({
              message: "Select permissions to allow (Space to toggle)",
              options: AVAILABLE_PERMISSIONS.map((permission) => ({
                label: permission,
                value: permission,
              })),
              initialValues: AVAILABLE_PERMISSIONS,
            }),
          ).pipe(Effect.flatMap((result) => (prompts.isCancel(result) ? cancelled() : Effect.succeed(result))))

    // Get mode
    const mode: AgentMode = args.mode
      ? args.mode
      : yield* Prompt.select({
          message: "Agent mode",
          options: [
            {
              label: "All",
              value: "all" as const,
              hint: "Can function in both primary and subagent roles",
            },
            {
              label: "Primary",
              value: "primary" as const,
              hint: "Acts as a primary/main agent",
            },
            {
              label: "Subagent",
              value: "subagent" as const,
              hint: "Can be used as a subagent by other agents",
            },
          ],
          initialValue: "all" as const,
        }).pipe(Effect.flatMap(required))

    // Build permissions config — deny anything not explicitly selected.
    const permissions: Record<string, "deny"> = Object.fromEntries(
      AVAILABLE_PERMISSIONS.filter((permission) => !selected.includes(permission)).map((permission) => [
        permission,
        "deny" as const,
      ]),
    )

    // Build frontmatter
    const frontmatter: {
      description: string
      mode: AgentMode
      permission?: Record<string, "deny">
    } = {
      description: generated.whenToUse,
      mode,
      ...(Object.keys(permissions).length > 0 ? { permission: permissions } : {}),
    }

    // Write file
    const content = matter.stringify(generated.systemPrompt, frontmatter)
    const filePath = path.join(targetPath, `${generated.identifier}.md`)

    yield* fs.ensureDir(targetPath).pipe(Effect.orDie)

    if (yield* fs.existsSafe(filePath)) return yield* fileExists(filePath, isFullyNonInteractive)

    yield* fs.writeWithDirs(filePath, content).pipe(Effect.orDie)

    if (isFullyNonInteractive) return yield* Console.log(filePath)
    yield* Prompt.log.success(`Agent created: ${filePath}`)
    return yield* Prompt.outro("Done")
  }),
})

const cancelled = () => Effect.die(new UI.CancelledError())

const required = <A>(value: Option.Option<A>) => Option.match(value, { onNone: cancelled, onSome: Effect.succeed })

// process.exit returns never; the void annotation keeps the thunk from reading as a Promise-returning one.
const exit = (code: number) => Effect.sync((): void => process.exit(code))

const selectScope = (worktree: string) =>
  Prompt.select({
    message: "Location",
    options: [
      {
        label: "Current project",
        value: "project" as const,
        hint: worktree,
      },
      {
        label: "Global",
        value: "global" as const,
        hint: Global.Path.config,
      },
    ],
  }).pipe(Effect.flatMap(required))

const fileExists = Effect.fnUntraced(function* (filePath: string, isFullyNonInteractive: boolean) {
  if (isFullyNonInteractive) {
    yield* Console.error(`Error: Agent file already exists: ${filePath}`)
    yield* exit(1)
  }
  yield* Prompt.log.error(`Agent file already exists: ${filePath}`)
  return yield* cancelled()
})

const AgentListCommand = effectCmd({
  command: "list",
  describe: "list all available agents",
  handler: Effect.fn("Cli.agent.list")(function* () {
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const sortedAgents = agents.sort((a, b) => {
      if (a.native !== b.native) {
        return a.native ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    yield* Effect.forEach(
      sortedAgents,
      (agent) =>
        Effect.gen(function* () {
          const permission = yield* encodePrettyJson(agent.permission).pipe(Effect.orDie)
          yield* Effect.sync(() => {
            process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
            process.stdout.write(`  ${permission}` + EOL)
          })
        }),
      { discard: true },
    )
  }),
})

export const AgentCommand = cmd({
  command: "agent",
  describe: "manage agents",
  builder: (yargs) => yargs.command(AgentCreateCommand).command(AgentListCommand).demandCommand(),
  handler() {},
})
