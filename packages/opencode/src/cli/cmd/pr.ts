import { Effect, Option, Schema } from "effect"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"
import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ChildProcess } from "effect/unstable/process"

// The fields that `gh pr view --json ...` returns. gh writes null for the head repository of a deleted fork.
const PrInfo = Schema.Struct({
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  headRepositoryOwner: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  headRefName: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
}).annotate({ identifier: "GhPrInfo", description: "The PR fields that the gh CLI prints as JSON." })

const decodePrInfo = Schema.decodeUnknownEffect(Schema.fromJsonString(PrInfo))

export const PrCommand = effectCmd({
  command: "pr <number>",
  describe: "fetch and checkout a GitHub PR branch, then run opencode",
  builder: (yargs) =>
    yargs.positional("number", {
      type: "number",
      describe: "PR number to checkout",
      demandOption: true,
    }),
  // AppRuntime does not provide AppProcess, so the handler provides its own.
  handler: Effect.fn("Cli.pr")(
    function* (args) {
      const instance = yield* InstanceRef
      if (Option.isNone(instance)) return yield* fail("Could not load instance context")
      const ctx = instance.value
      if (ctx.project.vcs !== "git") {
        return yield* fail("Could not find git repository. Please run this command from a git repository.")
      }

      const git = yield* Git.Service
      const appProcess = yield* AppProcess.Service
      const worktree = ctx.worktree

      // Runs gh or opencode and returns its stdout. A command that cannot start counts as a failed
      // command, with exit code 1 and no output.
      const runText = (argv: ReadonlyArray<string>) =>
        appProcess.run(ChildProcess.make(argv[0], argv.slice(1), { stdin: "ignore" })).pipe(
          Effect.map((result) => ({ code: result.exitCode, text: result.stdout.toString() })),
          Effect.orElseSucceed(() => ({ code: 1, text: "" })),
        )

      const prNumber = args.number
      const localBranchName = `pr/${prNumber}`
      UI.println(`Fetching and checking out PR #${prNumber}...`)

      const checkout = yield* runText(["gh", "pr", "checkout", `${prNumber}`, "--branch", localBranchName, "--force"])
      if (checkout.code !== 0) {
        return yield* fail(`Failed to checkout PR #${prNumber}. Make sure you have gh CLI installed and authenticated.`)
      }

      const prInfoResult = yield* runText([
        "gh",
        "pr",
        "view",
        `${prNumber}`,
        "--json",
        "headRepository,headRepositoryOwner,isCrossRepository,headRefName,body",
      ])

      let sessionId: string | undefined

      if (prInfoResult.code === 0 && prInfoResult.text.trim()) {
        const prInfo = yield* decodePrInfo(prInfoResult.text).pipe(Effect.orDie)

        if (prInfo.isCrossRepository && prInfo.headRepository && prInfo.headRepositoryOwner) {
          const forkOwner = prInfo.headRepositoryOwner.login
          const forkName = prInfo.headRepository.name
          const remoteName = forkOwner

          const remotes = (yield* git.run(["remote"], { cwd: worktree })).text().trim()
          if (!remotes.split("\n").includes(remoteName)) {
            yield* git.run(["remote", "add", remoteName, `https://github.com/${forkOwner}/${forkName}.git`], {
              cwd: worktree,
            })
            UI.println(`Added fork remote: ${remoteName}`)
          }

          yield* git.run(["branch", `--set-upstream-to=${remoteName}/${prInfo.headRefName}`, localBranchName], {
            cwd: worktree,
          })
        }

        if (prInfo.body) {
          const sessionMatch = prInfo.body.match(/https:\/\/opncd\.ai\/s\/([a-zA-Z0-9_-]+)/)
          if (sessionMatch) {
            const sessionUrl = sessionMatch[0]
            UI.println(`Found opencode session: ${sessionUrl}`)
            UI.println(`Importing session...`)

            const importResult = yield* runText(["opencode", "import", sessionUrl])
            if (importResult.code === 0) {
              const sessionIdMatch = importResult.text.trim().match(/Imported session: ([a-zA-Z0-9_-]+)/)
              if (sessionIdMatch) {
                sessionId = sessionIdMatch[1]
                UI.println(`Session imported: ${sessionId}`)
              }
            }
          }
        }
      }

      UI.println(`Successfully checked out PR #${prNumber} as branch '${localBranchName}'`)
      UI.println()
      UI.println("Starting opencode...")
      UI.println()

      const opencodeArgs = sessionId ? ["-s", sessionId] : []
      // The interactive child shares the terminal, so it stays in this process group (detached: false).
      // A spawn failure stays a defect, as the rejected exit Promise was.
      const code = yield* appProcess
        .run(
          ChildProcess.make("opencode", opencodeArgs, {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            cwd: process.cwd(),
            detached: false,
          }),
        )
        .pipe(
          Effect.map((result) => result.exitCode),
          Effect.orDie,
        )
      // Match legacy throw semantics — propagate as a defect so the top-level
      // index.ts catch handles it identically (exit 1, "Unexpected error" banner).
      if (code !== 0) return yield* Effect.die(new Error(`opencode exited with code ${code}`))
      return yield* Effect.void
    },
    Effect.provide(LayerNode.compile(AppProcess.node)),
  ),
})
