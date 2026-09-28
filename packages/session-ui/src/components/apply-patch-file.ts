import { Array, Option, Predicate } from "effect"
import { normalize, type ViewDiff } from "./session-diff"

type Kind = "add" | "update" | "delete" | "move"

type Raw = {
  filePath?: string
  relativePath?: string
  type?: Kind
  patch?: string
  diff?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
  movePath?: string
}

export type ApplyPatchFile = {
  filePath: string
  relativePath: string
  type: Kind
  additions: number
  deletions: number
  movePath?: string
  view: ViewDiff
}

function kind(value: unknown): Option.Option<Kind> {
  if (value === "add" || value === "update" || value === "delete" || value === "move") return Option.some(value)
  return Option.none()
}

function status(type: Kind): "added" | "deleted" | "modified" {
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  return "modified"
}

const stringField = Option.liftPredicate(Predicate.isString)
const nonEmpty = (value: string) => value.length > 0

export function patchFile(raw: unknown): Option.Option<ApplyPatchFile> {
  if (!raw || typeof raw !== "object") return Option.none()

  const value = raw as Raw
  const type = kind(value.type)
  const filePath = Option.filter(stringField(value.filePath), nonEmpty)
  const relativePath = Option.filter(
    Option.orElse(stringField(value.relativePath), () => filePath),
    nonEmpty,
  )
  const patch = Option.orElse(stringField(value.patch), () => stringField(value.diff))
  const before = stringField(value.before)
  const after = stringField(value.after)

  if (Option.isNone(type) || Option.isNone(filePath) || Option.isNone(relativePath)) return Option.none()
  if (!Option.exists(patch, nonEmpty) && Option.isNone(before) && Option.isNone(after)) return Option.none()

  const additions = typeof value.additions === "number" ? value.additions : 0
  const deletions = typeof value.deletions === "number" ? value.deletions : 0
  const movePath = stringField(value.movePath)

  return Option.some({
    filePath: filePath.value,
    relativePath: relativePath.value,
    type: type.value,
    additions,
    deletions,
    movePath: Option.getOrUndefined(movePath),
    view: normalize({
      file: relativePath.value,
      patch: Option.getOrUndefined(patch),
      before: Option.getOrUndefined(before),
      after: Option.getOrUndefined(after),
      additions,
      deletions,
      status: status(type.value),
    }),
  })
}

export function patchFiles(raw: unknown): ApplyPatchFile[] {
  if (!Array.isArray(raw)) return []
  return Array.getSomes(raw.map(patchFile))
}
