import { Effect, MutableHashMap, Option, Schema } from "effect"
import type { ProjectV2 } from "@opencode-ai/core/project"
import type { WorkspaceAdapter, WorkspaceAdapterEntry } from "../types"
import { WorktreeAdapter } from "./worktree"

export class UnknownWorkspaceAdapterError extends Schema.TaggedError<UnknownWorkspaceAdapterError>()(
  "UnknownWorkspaceAdapterError",
  {
    message: Schema.String,
    type: Schema.String,
  },
) {}

const BUILTIN: Record<string, WorkspaceAdapter> = {
  worktree: WorktreeAdapter,
}

const state = MutableHashMap.empty<ProjectV2.ID, MutableHashMap.MutableHashMap<string, WorkspaceAdapter>>()

// An unknown type is a defect, not a typed failure: the stored workspace or the
// request names an adapter that no plugin registered for this project.
export const getAdapter = Effect.fn("WorkspaceAdapters.get")(function* (projectID: ProjectV2.ID, type: string) {
  const found = MutableHashMap.get(state, projectID).pipe(
    Option.flatMap((adapters) => MutableHashMap.get(adapters, type)),
    Option.orElse(() => Option.fromNullishOr(BUILTIN[type])),
  )
  if (Option.isSome(found)) return found.value
  return yield* Effect.die(new UnknownWorkspaceAdapterError({ message: `Unknown workspace adapter: ${type}`, type }))
})

export function listAdapters(projectID: ProjectV2.ID): WorkspaceAdapterEntry[] {
  return registeredAdapters(projectID).map(([type, adapter]) => ({
    type,
    name: adapter.name,
    description: adapter.description,
  }))
}

export function registeredAdapters(projectID: ProjectV2.ID): [string, WorkspaceAdapter][] {
  const custom = Option.getOrElse(MutableHashMap.get(state, projectID), () =>
    MutableHashMap.empty<string, WorkspaceAdapter>(),
  )
  // A custom adapter replaces a builtin of the same type and keeps its position.
  return Array.from(MutableHashMap.fromIterable([...Object.entries(BUILTIN), ...custom]))
}

// Plugins can be loaded per-project so we need to scope them. If you
// want to install a global one pass `ProjectV2.ID.global`
export function registerAdapter(projectID: ProjectV2.ID, type: string, adapter: WorkspaceAdapter) {
  const adapters = Option.getOrElse(MutableHashMap.get(state, projectID), () =>
    MutableHashMap.empty<string, WorkspaceAdapter>(),
  )
  MutableHashMap.set(adapters, type, adapter)
  MutableHashMap.set(state, projectID, adapters)
}
