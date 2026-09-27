import path from "path"

import { createPlugTask, type PlugCtx, type PlugDeps } from "../../src/cli/cmd/plug"
import { Filesystem } from "@/util/filesystem"
import { Option, Schema } from "effect"

const Msg = Schema.Struct({
  dir: Schema.String,
  target: Schema.String,
  mod: Schema.String,
  global: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
  globalDir: Schema.optional(Schema.String),
  vcs: Schema.optional(Schema.String),
  worktree: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
  holdMs: Schema.optional(Schema.Number),
})
type Msg = typeof Msg.Type

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function input() {
  const raw = process.argv[2]
  if (!raw) {
    throw new Error("Missing plug worker input")
  }

  // dir, target and mod must be non-empty strings, as the former truthiness check required.
  const msg = Schema.decodeUnknownOption(Schema.fromJsonString(Msg))(raw).pipe(
    Option.filter((value) => value.dir !== "" && value.target !== "" && value.mod !== ""),
  )
  if (Option.isNone(msg)) {
    throw new Error("Invalid plug worker input")
  }

  return msg.value
}

function deps(msg: Msg): PlugDeps {
  return {
    spinner: () => ({
      start() {},
      stop() {},
    }),
    log: {
      error() {},
      info() {},
      success() {},
    },
    resolve: async () => msg.target,
    readText: (file) => Filesystem.readText(file),
    write: async (file, text) => {
      if (msg.holdMs && msg.holdMs > 0) {
        await sleep(msg.holdMs)
      }
      await Filesystem.write(file, text)
    },
    exists: (file) => Filesystem.exists(file),
    files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
    global: msg.globalDir ?? path.join(msg.dir, ".global"),
  }
}

function ctx(msg: Msg): PlugCtx {
  return {
    vcs: msg.vcs ?? "git",
    worktree: msg.worktree ?? msg.dir,
    directory: msg.directory ?? msg.dir,
  }
}

async function main() {
  const msg = input()
  const run = createPlugTask(
    {
      mod: msg.mod,
      global: msg.global,
      force: msg.force,
    },
    deps(msg),
  )

  const ok = await run(ctx(msg))
  if (!ok) {
    throw new Error("Plug task failed")
  }
}

await main().catch((err) => {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(text)
  process.exit(1)
})
