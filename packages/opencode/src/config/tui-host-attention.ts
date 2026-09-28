import { TuiConfig } from "@opencode-ai/tui/config"
import { isRecord } from "@opencode-ai/tui/util/record"
import path from "path"
import { fileURLToPath } from "url"
import { Schema } from "effect"

export function resolveHostAttentionSoundPaths(
  root: string,
  sounds: unknown,
  options?: { trim?: boolean },
): TuiConfig.AttentionSoundPaths {
  if (!isRecord(sounds)) return {}
  return Object.fromEntries(
    Object.entries(sounds).flatMap(([name, file]) => {
      if (!Schema.is(TuiConfig.AttentionSoundName)(name)) return []
      if (typeof file !== "string") return []
      const value = options?.trim ? file.trim() : file
      if (!value) return []
      const resolved = value.startsWith("file://") ? fileURLToPath(value) : value
      return [[name, path.isAbsolute(resolved) ? resolved : path.resolve(root, resolved)]]
    }),
  )
}
