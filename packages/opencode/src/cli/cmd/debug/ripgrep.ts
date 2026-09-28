import { EOL } from "os"
import { Effect, Option, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { InstanceRef } from "@/effect/instance-ref"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const RipgrepCommand = cmd({
  command: "rg",
  describe: "ripgrep debugging utilities",
  builder: (yargs) => yargs.command(FilesCommand).command(SearchCommand).demandCommand(),
  handler() {},
})

const FilesCommand = effectCmd({
  command: "files",
  describe: "list files using ripgrep",
  builder: (yargs) =>
    yargs
      .option("query", {
        type: "string",
        description: "Filter files by query",
      })
      .option("glob", {
        type: "string",
        description: "Glob pattern to match files",
      })
      .option("limit", {
        type: "number",
        description: "Limit number of results",
      }),
  handler: Effect.fn("Cli.debug.rg.files")(function* (args) {
    const instance = yield* InstanceRef
    if (Option.isNone(instance)) return
    const ctx = instance.value
    const ripgrep = yield* Ripgrep.Service
    const files = yield* ripgrep
      .glob({
        cwd: ctx.directory,
        pattern: args.glob ?? "**/*",
        limit: args.limit ?? 10_000,
      })
      .pipe(Effect.orDie)
    process.stdout.write(files.map((file) => file.path).join(EOL) + EOL)
  }),
})

const SearchCommand = effectCmd({
  command: "search <pattern>",
  describe: "search file contents using ripgrep",
  builder: (yargs) =>
    yargs
      .positional("pattern", {
        type: "string",
        demandOption: true,
        description: "Search pattern",
      })
      .option("glob", {
        type: "array",
        description: "File glob patterns",
      })
      .option("limit", {
        type: "number",
        description: "Limit number of results",
      }),
  handler: Effect.fn("Cli.debug.rg.search")(function* (args) {
    const instance = yield* InstanceRef
    if (Option.isNone(instance)) return
    const ctx = instance.value
    const ripgrep = yield* Ripgrep.Service
    const results = yield* ripgrep
      .grep({
        cwd: ctx.directory,
        pattern: args.pattern,
        include: args.glob?.[0],
        limit: args.limit ?? 10_000,
      })
      .pipe(Effect.orDie)
    process.stdout.write((yield* encodeJson(results).pipe(Effect.orDie)) + EOL)
  }),
})
