import { type SelectedLineRange, type SelectionSide } from "@pierre/diffs"
import { Array as Arr, Option } from "effect"
import { readShadowSelection, toRange } from "./selection-bridge"

export type ShadowLineSelection = {
  range: SelectedLineRange
  text: Option.Option<Range>
}

/** Parses a line number attribute value. None when the value is missing or is not a number. */
export function parseLineNumber(raw: string | undefined): Option.Option<number> {
  const value = parseInt(raw ?? "", 10)
  return Number.isNaN(value) ? Option.none() : Option.some(value)
}

export function findElement(node: Node | null): Option.Option<HTMLElement> {
  if (!node) return Option.none()
  if (node instanceof HTMLElement) return Option.some(node)
  return Option.fromNullOr(node.parentElement)
}

export function findFileLineNumber(node: Node | null): Option.Option<number> {
  return Option.flatMap(findElement(node), (el) => {
    const line = el.closest("[data-line]")
    if (!(line instanceof HTMLElement)) return Option.none()
    return parseLineNumber(line.dataset.line)
  })
}

export function findDiffLineNumber(node: Node | null): Option.Option<number> {
  return Option.flatMap(findElement(node), (el) => {
    const line = el.closest("[data-line], [data-alt-line]")
    if (!(line instanceof HTMLElement)) return Option.none()
    return Option.orElse(parseLineNumber(line.dataset.line), () => parseLineNumber(line.dataset.altLine))
  })
}

export function findCodeSelectionSide(node: Node | null): Option.Option<SelectionSide> {
  return Option.flatMap(findElement(node), (el): Option.Option<SelectionSide> => {
    const code = el.closest("[data-code]")
    if (!(code instanceof HTMLElement)) return Option.none()
    if (code.hasAttribute("data-deletions")) return Option.some("deletions")
    return Option.some("additions")
  })
}

// Selection.getComposedRanges is missing in older engines, so check for it before the call.
function composedRange(selection: Selection, root: ShadowRoot): Option.Option<StaticRange> {
  if (typeof selection.getComposedRanges !== "function") return Option.none()
  return Arr.head(selection.getComposedRanges({ shadowRoots: [root] }))
}

export function readShadowLineSelection(opts: {
  root: ShadowRoot
  lineForNode: (node: Node | null) => Option.Option<number>
  sideForNode?: (node: Node | null) => Option.Option<SelectionSide>
  preserveTextSelection?: boolean
}): Option.Option<ShadowLineSelection> {
  const found = readShadowSelection(opts.root)
  if (Option.isNone(found) || found.value.isCollapsed) return Option.none()
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
  if (!startNode || !endNode) return Option.none()
  if (!opts.root.contains(startNode) || !opts.root.contains(endNode)) return Option.none()

  const start = opts.lineForNode(startNode)
  const end = opts.lineForNode(endNode)
  if (Option.isNone(start) || Option.isNone(end)) return Option.none()

  const sideForNode = opts.sideForNode ?? (() => Option.none<SelectionSide>())
  const startSide = sideForNode(startNode)
  const endSide = sideForNode(endNode)
  const side = Option.orElse(startSide, () => endSide)

  const range: SelectedLineRange = { start: start.value, end: end.value }
  if (Option.isSome(side)) range.side = side.value
  if (Option.isSome(endSide) && Option.isSome(side) && endSide.value !== side.value) range.endSide = endSide.value

  return Option.some({
    range,
    text: opts.preserveTextSelection ? Option.map(domRange, (value) => toRange(value).cloneRange()) : Option.none(),
  })
}
