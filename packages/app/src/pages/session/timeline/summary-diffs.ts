import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { MutableHashSet } from "effect"
import type { SummaryDiff } from "./timeline-row"

export function uniqueSummaryDiffs(diffs: SnapshotFileDiff[] | undefined) {
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
