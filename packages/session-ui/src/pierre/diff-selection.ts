import { type SelectedLineRange } from "@pierre/diffs"
import { Array as Arr, Data, Option, Predicate } from "effect"

export type DiffSelectionSide = "additions" | "deletions"

/**
 * The result of fitting a selected range to the rendered diff rows.
 *
 * - `Pending`: the diff rows are not rendered yet, so the caller keeps the range as it is or tries again later.
 * - `Resolved`: the range to apply. `None` clears the selection.
 */
export type DiffSelectionFix = Data.TaggedEnum<{
  Pending: {}
  Resolved: { readonly range: Option.Option<SelectedLineRange> }
}>
export const DiffSelectionFix = Data.taggedEnum<DiffSelectionFix>()

export function findDiffSide(node: HTMLElement): DiffSelectionSide {
  const line = node.closest("[data-line], [data-alt-line]")
  if (line instanceof HTMLElement) {
    const type = line.dataset.lineType
    if (type === "change-deletion") return "deletions"
    if (type === "change-addition" || type === "change-additions") return "additions"
  }

  const code = node.closest("[data-code]")
  if (!(code instanceof HTMLElement)) return "additions"
  return code.hasAttribute("data-deletions") ? "deletions" : "additions"
}

export function diffLineIndex(split: boolean, node: HTMLElement): Option.Option<number> {
  const values = (node.dataset.lineIndex ?? "")
    .split(",")
    .map((x) => parseInt(x, 10))
    .filter((x) => !Number.isNaN(x))
  if (split && values.length === 2) return Arr.get(values, 1)
  return Arr.head(values)
}

export function diffRowIndex(
  root: ShadowRoot,
  split: boolean,
  line: number,
  side: DiffSelectionSide | undefined,
): Option.Option<number> {
  const rows = Array.from(root.querySelectorAll(`[data-line="${line}"], [data-alt-line="${line}"]`)).filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  )

  const target = side ?? "additions"
  for (const row of rows) {
    if (findDiffSide(row) === target) return diffLineIndex(split, row)
    if (parseInt(row.dataset.altLine ?? "", 10) === line) return diffLineIndex(split, row)
  }
  return Option.none()
}

export function fixDiffSelection(
  root: Option.Option<ShadowRoot>,
  range: Option.Option<SelectedLineRange>,
): DiffSelectionFix {
  if (Option.isNone(range)) return DiffSelectionFix.Resolved({ range })
  if (Option.isNone(root)) return DiffSelectionFix.Pending()
  const shadow = root.value
  const selected = range.value

  const diffs = shadow.querySelector("[data-diff]")
  if (!(diffs instanceof HTMLElement)) return DiffSelectionFix.Pending()

  const split = diffs.dataset.diffType === "split"
  const start = diffRowIndex(shadow, split, selected.start, selected.side)
  const end = diffRowIndex(shadow, split, selected.end, selected.endSide ?? selected.side)

  if (Option.isNone(start) || Option.isNone(end)) {
    // No rendered line at all means the diff is still rendering. Otherwise the range is outside the diff.
    if (Predicate.isNull(shadow.querySelector("[data-line], [data-alt-line]"))) return DiffSelectionFix.Pending()
    return DiffSelectionFix.Resolved({ range: Option.none() })
  }
  if (start.value <= end.value) return DiffSelectionFix.Resolved({ range })

  const side = selected.endSide ?? selected.side
  const swapped: SelectedLineRange = {
    start: selected.end,
    end: selected.start,
  }

  if (side) swapped.side = side
  if (selected.endSide && selected.side) swapped.endSide = selected.side
  return DiffSelectionFix.Resolved({ range: Option.some(swapped) })
}
