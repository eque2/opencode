// Dev-only JSONL event trace for direct interactive mode.
//
// Enable with OPENCODE_DIRECT_TRACE=1. Writes one JSON line per event to
// ~/.local/share/opencode/log/direct/<timestamp>-<pid>.jsonl. Also writes
// a latest.json pointer so you can quickly find the most recent trace.
//
// The trace captures the full closed loop: outbound prompts, inbound SDK
// events, reducer output, footer commits, and turn lifecycle markers.
// Useful for debugging stream ordering, permission behavior, and
// footer/transcript mismatches.
//
// Lazy-initialized: the first run of loadTrace decides whether tracing is
// active based on the env var, and later runs return the cached result.
//
// The writes stay synchronous. Callers record events from synchronous SDK and
// renderer callbacks, the run command can end with process.exit, and each line
// must land in event order before that. Effect FileSystem offers only
// asynchronous writes, so it would reorder or drop the last lines.
// eslint-disable-next-line effect/no-fs-use-effect-fs -- (a) the trace needs synchronous, ordered appends that survive process.exit; effect FileSystem has no synchronous write
import fs from "fs"
import path from "path"
import { Config, DateTime, Effect, Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"

export type Trace = {
  write(type: string, data?: unknown): void
}

let state: Option.Option<Trace> | undefined

// BigInt values have no JSON form, so they are written as decimal strings.
const encodeLine = Schema.encodeSync(
  Schema.fromJsonString(Schema.Unknown, {
    replacer: (_key: string, value: unknown) => (typeof value === "bigint" ? String(value) : value),
  }),
)

function stamp(time: DateTime.DateTime) {
  return DateTime.formatIso(time)
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

function latest() {
  return path.join(Global.Path.log, "direct", "latest.json")
}

// An unreadable OPENCODE_DIRECT_TRACE counts as not set, as a missing one does.
const enabled = Config.option(Config.String("OPENCODE_DIRECT_TRACE")).pipe(
  Effect.map(Option.isSome),
  Effect.orElseSucceed(() => false),
)

const start = Effect.gen(function* () {
  if (!(yield* enabled)) {
    return Option.none<Trace>()
  }

  const time = yield* DateTime.now
  const target = path.join(Global.Path.log, "direct", `${stamp(time)}-${process.pid}.jsonl`)
  return yield* Effect.sync(() => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(
      latest(),
      encodeLine({
        time: DateTime.formatIso(time),
        pid: process.pid,
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        path: target,
      }) + "\n",
    )
    const result: Trace = {
      // write runs inside synchronous callbacks, so it reads the clock directly.
      write(type: string, data?: unknown) {
        fs.appendFileSync(
          target,
          encodeLine({
            time: DateTime.formatIso(DateTime.nowUnsafe()),
            pid: process.pid,
            type,
            data,
          }) + "\n",
        )
      },
    }
    result.write("trace.start", {
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      path: target,
    })
    return Option.some(result)
  })
})

/** The process trace. The first run decides from OPENCODE_DIRECT_TRACE; later runs reuse that result. */
export const loadTrace: Effect.Effect<Option.Option<Trace>> = Effect.suspend(() =>
  state === undefined
    ? start.pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            state = value
          }),
        ),
      )
    : Effect.succeed(state),
)
