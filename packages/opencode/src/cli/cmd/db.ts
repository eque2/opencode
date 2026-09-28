import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { Console, Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"

const encodePrettyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query
    if (query) return yield* printQuery(query, args.format)
    const child = spawn("sqlite3", [yield* Database.path], {
      stdio: "inherit",
    })
    return yield* Effect.callback<void>((resume) => {
      child.on("close", () => resume(Effect.void))
    })
  }),
})

const printQuery = Effect.fnUntraced(function* (query: string, format: string) {
  const { db } = yield* Database.Service
  const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
  if (format === "json") {
    yield* Console.log(yield* encodePrettyJson(result).pipe(Effect.orDie))
    return
  }
  if (result.length === 0) return
  const keys = Object.keys(result[0])
  yield* Console.log(keys.join("\t"))
  yield* Effect.forEach(result, (row) => Console.log(keys.map((key) => row[key]).join("\t")), { discard: true })
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    yield* Console.log(yield* Database.path)
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
