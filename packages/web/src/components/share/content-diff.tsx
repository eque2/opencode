import { Array, Effect, Option, Result } from "effect"
import { parsePatch } from "diff"
import { createMemo, For } from "solid-js"
import { ContentCode } from "./content-code"
import styles from "./content-diff.module.css"

type DiffRow = {
  left: string
  right: string
  type: "added" | "removed" | "unchanged" | "modified"
}

interface Props {
  diff: string
  lang?: string
}

type MobileBlock = {
  type: "removed" | "added" | "unchanged"
  lines: string[]
}

export function ContentDiff(props: Props) {
  const rows = createMemo(() =>
    Result.match(
      Result.try(() => parsePatch(props.diff)),
      {
        onFailure: (error): DiffRow[] => {
          Effect.runFork(Effect.logError("Failed to parse patch:", error))
          return []
        },
        onSuccess: (patches) =>
          Array.flatMap(patches, (patch) => Array.flatMap(patch.hunks, (hunk) => hunkRows(hunk.lines))),
      },
    ),
  )

  // Each step emits either one maximal run of changed rows or a single unchanged row.
  const mobileRows = createMemo(() =>
    Array.flatten(
      Array.chop(rows(), (rest): readonly [MobileBlock[], ReadonlyArray<DiffRow>] => {
        const [changed, after] = Array.span(rest, (row) => row.type !== "unchanged")
        if (!Array.isReadonlyArrayNonEmpty(changed)) {
          return [[{ type: "unchanged", lines: [rest[0].left] }], Array.drop(rest, 1)]
        }
        const removed = Array.map(
          Array.filter(changed, (row) => row.left !== "" && (row.type === "removed" || row.type === "modified")),
          (row) => row.left,
        )
        const added = Array.map(
          Array.filter(changed, (row) => row.right !== "" && (row.type === "added" || row.type === "modified")),
          (row) => row.right,
        )
        const blocks: MobileBlock[] = [
          { type: "removed", lines: removed },
          { type: "added", lines: added },
        ]
        return [Array.filter(blocks, (block) => block.lines.length > 0), after]
      }),
    ),
  )

  return (
    <div class={styles.root}>
      <div data-component="desktop">
        <For each={rows()}>
          {(row) => (
            <div data-component="diff-row" data-type={row.type}>
              <div
                data-slot="before"
                data-diff-type={row.type === "removed" || row.type === "modified" ? "removed" : ""}
              >
                <ContentCode code={row.left} flush lang={props.lang} />
              </div>
              <div data-slot="after" data-diff-type={row.type === "added" || row.type === "modified" ? "added" : ""}>
                <ContentCode code={row.right} lang={props.lang} flush />
              </div>
            </div>
          )}
        </For>
      </div>

      <div data-component="mobile">
        <For each={mobileRows()}>
          {(block) => (
            <div data-component="diff-block" data-type={block.type}>
              <For each={block.lines}>
                {(line) => (
                  <div data-diff-type={block.type === "removed" ? "removed" : block.type === "added" ? "added" : ""}>
                    <ContentCode code={line} lang={props.lang} flush />
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

// Each step consumes one run of removals with the additions that follow it, or one single line.
function hunkRows(lines: ReadonlyArray<string>): DiffRow[] {
  return Array.flatten(
    Array.chop(lines, (rest): readonly [DiffRow[], ReadonlyArray<string>] => {
      const line = rest[0]
      const content = line.slice(1)
      const prefix = line[0]

      if (prefix === "-") {
        // Pair the consecutive removals with the consecutive additions that follow them
        const [removedLines, afterRemovals] = Array.span(rest, (next) => next[0] === "-")
        const [addedLines, remaining] = Array.span(afterRemovals, (next) => next[0] === "+")
        const removals = Array.map(removedLines, (next) => next.slice(1))
        const additions = Array.map(addedLines, (next) => next.slice(1))
        const paired = Array.makeBy(Math.max(removals.length, additions.length), (k) =>
          pairRow(Array.get(removals, k), Array.get(additions, k)),
        )
        return [paired, remaining]
      }

      const tail = Array.drop(rest, 1)
      if (prefix === "+") {
        // Standalone addition (not paired with removal)
        return [[{ left: "", right: content, type: "added" }], tail]
      }
      if (prefix === " ") {
        const text = content === "" ? " " : content
        return [[{ left: text, right: text, type: "unchanged" }], tail]
      }
      return [[], tail]
    }),
  )
}

function pairRow(left: Option.Option<string>, right: Option.Option<string>): DiffRow {
  return Option.match(left, {
    // Pure addition
    onNone: () => ({ left: "", right: Option.getOrElse(right, () => ""), type: "added" }),
    onSome: (removed) =>
      Option.match(right, {
        // Pure removal
        onNone: () => ({ left: removed, right: "", type: "removed" }),
        // Replacement - left is removed, right is added
        onSome: (addedLine) => ({ left: removed, right: addedLine, type: "modified" }),
      }),
  })
}

// const testDiff = `--- combined_before.txt	2025-06-24 16:38:08
// +++ combined_after.txt	2025-06-24 16:38:12
// @@ -1,21 +1,25 @@
//  unchanged line
// -deleted line
// -old content
// +added line
// +new content
//
// -removed empty line below
// +added empty line above
//
// -	tab indented
// -trailing spaces
// -very long line that will definitely wrap in most editors and cause potential alignment issues when displayed in a two column diff view
// -unicode content: 🚀 ✨ 中文
// -mixed	content with	tabs and spaces
// +    space indented
// +no trailing spaces
// +short line
// +very long replacement line that will also wrap and test how the diff viewer handles long line additions after short line removals
// +different unicode: 🎉 💻 日本語
// +normalized content with consistent spacing
// +newline to content
//
// -content to remove
// -whitespace only:
// -multiple
// -consecutive
// -deletions
// -single deletion
// +
// +single addition
// +first addition
// +second addition
// +third addition
//  line before addition
// +first added line
// +
// +third added line
//  line after addition
//  final unchanged line`
