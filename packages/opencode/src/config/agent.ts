export * as ConfigAgent from "./agent"

import path from "path"
import { Effect, Exit, Option, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

const scanOptions = (dir: string) => ({ cwd: dir, absolute: true, dot: true, symlink: true })

export const load = Effect.fn("ConfigAgent.load")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of yield* fs.scan("{agent,agents}/**/*.md", scanOptions(dir))) {
    // A file that does not read or parse is skipped.
    const md = yield* ConfigMarkdown.read(item).pipe(Effect.option)
    if (Option.isNone(md)) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])

    const config = {
      name,
      ...md.value.data,
      prompt: md.value.content.trim(),
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
})

export const loadMode = Effect.fn("ConfigAgent.loadMode")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of yield* fs.scan("{mode,modes}/*.md", scanOptions(dir))) {
    // A file that does not read or parse is skipped.
    const md = yield* ConfigMarkdown.read(item).pipe(Effect.option)
    if (Option.isNone(md)) continue

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.value.data,
      prompt: md.value.content.trim(),
    }
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...parsed.value,
        mode: "primary" as const,
      }
    }
  }
  return result
})
