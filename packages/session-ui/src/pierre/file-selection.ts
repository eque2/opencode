import { type SelectedLineRange } from "@pierre/diffs"
import { Array as Arr, Option } from "effect"
import { readShadowSelection, toRange } from "./selection-bridge"

export function findElement(node: Node | null): HTMLElement | undefined {
  if (!node) return
  if (node instanceof HTMLElement) return node
  return node.parentElement ?? undefined
}

export function findFileLineNumber(node: Node | null): number | undefined {
  const el = findElement(node)
  if (!el) return

  const line = el.closest("[data-line]")
  if (!(line instanceof HTMLElement)) return

  const value = parseInt(line.dataset.line ?? "", 10)
  if (Number.isNaN(value)) return
  return value
}

export function findDiffLineNumber(node: Node | null): number | undefined {
  const el = findElement(node)
  if (!el) return

  const line = el.closest("[data-line], [data-alt-line]")
  if (!(line instanceof HTMLElement)) return

  const primary = parseInt(line.dataset.line ?? "", 10)
  if (!Number.isNaN(primary)) return primary

  const alt = parseInt(line.dataset.altLine ?? "", 10)
  if (!Number.isNaN(alt)) return alt
}

export function findCodeSelectionSide(node: Node | null): SelectedLineRange["side"] {
  const el = findElement(node)
  if (!el) return

  const code = el.closest("[data-code]")
  if (!(code instanceof HTMLElement)) return
  if (code.hasAttribute("data-deletions")) return "deletions"
  return "additions"
}

// Selection.getComposedRanges is missing in older engines, so check for it before the call.
function composedRange(selection: Selection, root: ShadowRoot): Option.Option<StaticRange> {
  if (typeof selection.getComposedRanges !== "function") return Option.none()
  return Arr.head(selection.getComposedRanges({ shadowRoots: [root] }))
}

export function readShadowLineSelection(opts: {
  root: ShadowRoot
  lineForNode: (node: Node | null) => number | undefined
  sideForNode?: (node: Node | null) => SelectedLineRange["side"]
  preserveTextSelection?: boolean
}) {
  const found = readShadowSelection(opts.root)
  if (Option.isNone(found) || found.value.isCollapsed) return
  const selection = found.value

  const domRange = Option.orElse(composedRange(selection, opts.root), () =>
    selection.rangeCount > 0 ? Option.some(selection.getRangeAt(0)) : Option.none(),
  )

  const startNode = Option.match(domRange, {
    onNone: () => selection.anchorNode,
    onSome: (range) => range.startContainer,
  })
  const endNode = Option.match(domRange, {
    onNone: () => selection.focusNode,
    onSome: (range) => range.endContainer,
  })
  if (!startNode || !endNode) return
  if (!opts.root.contains(startNode) || !opts.root.contains(endNode)) return

  const start = opts.lineForNode(startNode)
  const end = opts.lineForNode(endNode)
  if (start === undefined || end === undefined) return

  const startSide = opts.sideForNode?.(startNode)
  const endSide = opts.sideForNode?.(endNode)
  const side = startSide ?? endSide

  const range: SelectedLineRange = { start, end }
  if (side) range.side = side
  if (endSide && side && endSide !== side) range.endSide = endSide

  return {
    range,
    text: opts.preserveTextSelection && Option.isSome(domRange) ? toRange(domRange.value).cloneRange() : undefined,
  }
}
