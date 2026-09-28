import { Effect, Schema } from "effect"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import type { Worktree } from "@/worktree"
import type { InstanceContext } from "@/project/instance-context"
import { type WorkspaceAdapter, type WorkspaceAdapterContext, WorkspaceInfo } from "../types"

const WorktreeConfig = Schema.Struct({
  name: WorkspaceInfo.fields.name,
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  directory: Schema.String,
}).annotate({ identifier: "WorktreeConfig" })
const decodeWorktreeConfig = Schema.decodeUnknownSync(WorktreeConfig)

export class WorktreeAdapterError extends Schema.TaggedError<WorktreeAdapterError>()("WorktreeAdapterError", {
  message: Schema.String,
}) {}

// The app runtime and the worktree service import the control plane, so this
// adapter loads them on first use to avoid an import cycle.
const loadWorktree = Effect.fn("WorktreeAdapter.load")(function* () {
  const [{ AppRuntime }, { Worktree }] = yield* Effect.all(
    [Effect.promise(() => import("@/effect/app-runtime")), Effect.promise(() => import("@/worktree"))],
    { concurrency: 2 },
  )
  return { AppRuntime, Worktree }
})

const requireInstance = Effect.fn("WorktreeAdapter.requireInstance")(function* (
  context: WorkspaceAdapterContext | undefined,
) {
  if (context?.instance) return context.instance
  return yield* new WorktreeAdapterError({ message: "Worktree adapter requires an instance context" })
})

// WorkspaceAdapter is a Promise contract (plugins and tests implement it), so
// each method runs its Effect here and the AppRuntime run supplies the services.
const run = <A, E>(
  context: WorkspaceAdapterContext | undefined,
  use: (worktree: Worktree.Interface, instance: InstanceContext) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { AppRuntime, Worktree } = yield* loadWorktree()
      const instance = yield* requireInstance(context)
      const exit = yield* Effect.promise(() =>
        AppRuntime.runPromiseExit(
          Worktree.Service.use((svc) => use(svc, instance)).pipe(
            Effect.provideService(InstanceRef, instance),
            Effect.provideService(WorkspaceRef, context?.workspaceID),
          ),
        ),
      )
      return yield* exit
    }),
  )

export const WorktreeAdapter: WorkspaceAdapter = {
  name: "Worktree",
  description: "Create a git worktree",
  configure: (info, context) =>
    run(context, (svc) =>
      svc.makeWorktreeInfo({ detached: true }).pipe(
        Effect.map((next) => ({
          ...info,
          name: next.name,
          directory: next.directory,
        })),
      ),
    ),
  create: (info, _env, _from, context) =>
    run(context, (svc) => {
      const config = decodeWorktreeConfig(info)
      return svc
        .createFromInfo({
          name: config.name,
          directory: config.directory,
          ...(config.branch ? { branch: config.branch } : {}),
        })
        .pipe(Effect.asVoid)
    }),
  list: (context) =>
    run(context, (svc, instance) =>
      svc.list().pipe(
        Effect.map((items) =>
          items.map((item) => ({
            type: "worktree",
            name: item.name,
            branch: item.branch,
            directory: item.directory,
            projectID: instance.project.id,
          })),
        ),
      ),
    ),
  remove: (info, context) =>
    run(context, (svc) => svc.remove({ directory: decodeWorktreeConfig(info).directory }).pipe(Effect.asVoid)),
  target(info) {
    const config = decodeWorktreeConfig(info)
    return {
      type: "local",
      directory: config.directory,
    }
  },
}
