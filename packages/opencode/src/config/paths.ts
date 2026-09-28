export * as ConfigPaths from "./paths"

import path from "path"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

/**
 * OPENCODE_CONFIG_DIR, read live on each run. An empty value counts as not set. The flag is
 * optional, so a ConfigError is a defect.
 */
export const customDirectory = FlagConfig.OPENCODE_CONFIG_DIR.pipe(
  Effect.orDie,
  Effect.map(Option.filter((dir) => dir !== "")),
)

/** OPENCODE_DISABLE_PROJECT_CONFIG, read live on each run. It defaults to false, so a ConfigError is a defect. */
export const projectConfigDisabled = FlagConfig.OPENCODE_DISABLE_PROJECT_CONFIG.pipe(Effect.orDie)

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  const global = yield* Global.Service
  const disableProjectConfig = yield* projectConfigDisabled
  const configDir = yield* customDirectory
  return unique([
    Global.Path.config,
    ...(!disableProjectConfig
      ? yield* afs.up({
          targets: [".opencode"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".opencode"],
      start: global.home,
      stop: global.home,
    })),
    ...Option.toArray(configDir),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
