import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown as ConfigMarkdownCore } from "@opencode-ai/core/config/markdown"

export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
export const SHELL_REGEX = /!`([^`]+)`/g

export function files(template: string) {
  return Array.from(template.matchAll(FILE_REGEX))
}

export function shell(template: string) {
  return Array.from(template.matchAll(SHELL_REGEX))
}

// other coding agents like claude code allow invalid yaml in their
// frontmatter, we need to fallback to a more permissive parser for those cases
export const fallbackSanitization = ConfigMarkdownCore.sanitize

/** Reads a markdown file and parses its frontmatter. */
export const read = Effect.fn("ConfigMarkdown.read")(function* (filePath: string) {
  const fs = yield* FSUtil.Service
  const template = yield* fs.readFileString(filePath)
  return yield* Effect.try({
    try: () => ConfigMarkdownCore.parse(template),
    catch: (err) =>
      new FrontmatterError(
        {
          path: filePath,
          message: `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        },
        { cause: err },
      ),
  })
})

const fileSystemLayer = LayerNode.compile(FSUtil.node)

/**
 * Promise form of read for callers outside Effect. It rejects with the FrontmatterError, or with the
 * read error.
 */
export function parse(filePath: string) {
  return Effect.runPromise(read(filePath).pipe(Effect.provide(fileSystemLayer)))
}

export * as ConfigMarkdown from "./markdown"
