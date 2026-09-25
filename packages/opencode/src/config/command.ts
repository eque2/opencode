export * as ConfigCommand from "./command"

import path from "path"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigCommandV1 } from "@opencode-ai/core/v1/config/command"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "@opencode-ai/core/v1/config/error"
import * as ConfigMarkdown from "./markdown"

const decodeInfo = Schema.decodeUnknownExit(ConfigCommandV1.Info)

export const load = Effect.fn("ConfigCommand.load")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  const result: Record<string, ConfigCommandV1.Info> = {}
  for (const item of yield* fs.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    // A file that does not read or parse is skipped.
    const md = yield* ConfigMarkdown.read(item).pipe(Effect.option)
    if (Option.isNone(md)) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])

    const config = {
      name,
      ...md.value.data,
      template: md.value.content.trim(),
    }
    const parsed = decodeInfo(config, { errors: "all" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = parsed.value
      continue
    }
    throw new InvalidError({ path: item, message: Cause.pretty(parsed.cause) }, { cause: Cause.squash(parsed.cause) })
  }
  return result
})
