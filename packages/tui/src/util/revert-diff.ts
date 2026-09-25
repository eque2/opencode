import { parsePatch } from "diff"
import { Result } from "effect"

export function getRevertDiffFiles(diffText: string) {
  if (!diffText) return []

  // parsePatch throws on malformed patch text; a revert whose diff cannot be read lists no files.
  const files = Result.try(() =>
    parsePatch(diffText).map((patch) => {
      const filename = [patch.newFileName, patch.oldFileName].find((item) => item && item !== "/dev/null") ?? "unknown"
      return {
        filename: filename.replace(/^[ab]\//, ""),
        additions: patch.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("+")).length, 0),
        deletions: patch.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("-")).length, 0),
      }
    }),
  )
  return Result.getOrElse(files, () => [])
}
