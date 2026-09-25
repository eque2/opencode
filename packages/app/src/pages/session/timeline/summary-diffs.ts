import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { MutableHashSet } from "effect"
import type { SummaryDiff } from "./timeline-row"

// The diffs are optional because a user message summary may have none (rows.ts passes `summary?.diffs`).
export function uniqueSummaryDiffs(diffs?: SnapshotFileDiff[]) {
  const files = MutableHashSet.empty<string>()
  return (diffs ?? [])
    .reduceRight<SummaryDiff[]>((result, diff) => {
      if (!isSummaryDiff(diff)) return result
      const file = diff.file
      if (MutableHashSet.has(files, file)) return result
      MutableHashSet.add(files, file)
      result.push(diff)
      return result
    }, [])
    .reverse()
}

function isSummaryDiff(diff: SnapshotFileDiff): diff is SummaryDiff {
  return typeof diff.file === "string"
}
