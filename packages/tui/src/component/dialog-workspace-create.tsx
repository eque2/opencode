import type { ExperimentalWorkspaceAdapterListResponse, VcsApplyError, Workspace } from "@opencode-ai/sdk/v2"
import { Data, Effect, Equivalence, Option, Predicate } from "effect"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { createMemo, createSignal, onMount } from "solid-js"
import { errorMessage } from "../util/error"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogWorkspaceFileChanges } from "./dialog-workspace-file-changes"

type Adapter = ExperimentalWorkspaceAdapterListResponse[number]

export type WorkspaceSelection =
  | {
      type: "none"
    }
  | {
      type: "new"
      workspaceType: string
      workspaceName: string
    }
  | {
      type: "existing"
      workspaceID: string
      workspaceType: string
      workspaceName: string
    }

type WorkspaceSelectValue = WorkspaceSelection | { type: "existing-list" }

/** Workspace id Options are equal when both are none or both hold the same id. */
const sameWorkspaceID = Option.makeEquivalence(Equivalence.strictEqual<string>())
type ExistingWorkspaceSelectValue = { workspace: Workspace }

export function recentConnectedWorkspaces<WorkspaceInfo extends { id: string; timeUsed: number | string }>(input: {
  workspaces: readonly WorkspaceInfo[]
  status: (workspaceID: string) => string | undefined
  limit?: number
  omitWorkspaceID?: string
}) {
  const allWorkspaces = input.workspaces.filter((workspace) => input.status(workspace.id) === "connected")
  const workspaces = allWorkspaces.toSorted((a, b) => Number(b.timeUsed) - Number(a.timeUsed))
  const recent = workspaces.slice(0, input.limit ?? 3)

  return { recent, hasMore: recent.length < workspaces.length }
}

export function warpReminderText(dir: string) {
  return `<system-reminder>The user has changed the current working directory to "${dir}". This is still the same project but at a possibly new location; take this into account when working with any files from now on.</system-reminder>`
}

/** A workspace SDK request that rejected or returned an error response. */
class WorkspaceRequestError extends Data.TaggedError("WorkspaceRequestError")<{ readonly cause: unknown }> {}

/** The warp could not apply the session's file changes to the target workspace. */
class WorkspaceVcsConflictError extends Data.TaggedError("WorkspaceVcsConflictError")<{
  readonly cause: VcsApplyError
}> {}

function loadWorkspaceAdapters(input: {
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
}) {
  const dir = input.sync.path.directory || input.sdk.directory
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => input.sdk.client.experimental.workspace.adapter.list({ directory: dir }),
      catch: (cause) => new WorkspaceRequestError({ cause }),
    })
    if (response.error) return yield* new WorkspaceRequestError({ cause: response.error })
    return Option.fromNullishOr(response.data)
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        input.toast.show({
          title: "Failed to load workspace adapters",
          message: errorMessage(error.cause),
          variant: "error",
        })
        return Option.none<Adapter[]>()
      }),
    ),
  )
}

export function openWorkspaceSelect(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  toast: ReturnType<typeof useToast>
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  return Effect.runPromise(
    Effect.gen(function* () {
      input.dialog.clear()
      yield* Effect.tryPromise(() => input.sdk.client.experimental.workspace.syncList()).pipe(Effect.ignore)
      yield* Effect.tryPromise(() => input.project.workspace.sync()).pipe(Effect.ignore)
      const adapters = yield* loadWorkspaceAdapters(input)
      if (Option.isNone(adapters)) return
      input.dialog.replace(() => <DialogWorkspaceSelect adapters={adapters.value} onSelect={input.onSelect} />)
    }),
  )
}

export function warpWorkspaceSession(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  toast: ReturnType<typeof useToast>
  sourceWorkspaceID?: string
  workspaceID: string | null
  sessionID: string
  copyChanges: boolean
  done?: () => void
}): Promise<boolean> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          input.sdk.client.experimental.workspace.warp({
            id: input.workspaceID,
            sessionID: input.sessionID,
            copyChanges: input.copyChanges,
          }),
        catch: (cause) => new WorkspaceRequestError({ cause }),
      })
      if (!result.data) {
        const error = result.error
        if (error && "name" in error && error.name === "VcsApplyError")
          return yield* new WorkspaceVcsConflictError({ cause: error })
        return yield* new WorkspaceRequestError({ cause: error ?? "no response" })
      }

      input.project.workspace.set(input.workspaceID)

      yield* Effect.tryPromise(() => input.sync.bootstrap({ fatal: false })).pipe(Effect.ignore)

      const dir = input.project.instance.directory() || input.sync.path.directory
      if (dir) {
        yield* Effect.tryPromise(() =>
          input.sdk.client.session.promptAsync({
            sessionID: input.sessionID,
            ...(Predicate.isNotNull(input.workspaceID) ? { workspace: input.workspaceID } : {}),
            noReply: true,
            parts: [
              {
                type: "text",
                text: warpReminderText(dir),
                synthetic: true,
              },
            ],
          }),
        ).pipe(Effect.ignore)
      }

      yield* Effect.all(
        [Effect.promise(() => input.project.workspace.sync()), Effect.promise(() => input.sync.session.refresh())],
        { concurrency: "unbounded" },
      )

      if (input.done) {
        input.done()
        return true
      }
      input.dialog.clear()
      return true
    }).pipe(
      Effect.catchTags({
        WorkspaceVcsConflictError: () =>
          Effect.promise(() =>
            DialogAlert.show(
              input.dialog,
              "Unable to Warp Session",
              "Unable to apply file changes to this workspace. It has existing changes that conflict or is based off a different branch. Session has not been warped.",
            ),
          ).pipe(Effect.as(false)),
        WorkspaceRequestError: (error) =>
          Effect.sync(() => {
            input.toast.show({
              title: "Failed to warp session",
              message: errorMessage(error.cause),
              variant: "error",
            })
            return false
          }),
      }),
    ),
  )
}

export function confirmWorkspaceFileChanges(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sourceWorkspaceID?: string
}) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* Effect.tryPromise(() =>
        input.sdk.client.vcs.status({ workspace: input.sourceWorkspaceID }),
      ).pipe(Effect.option)
      const files = status.pipe(
        Option.flatMapNullishOr((response) => response.data),
        Option.filter((data) => data.length > 0),
      )
      const fileChangeChoice = Option.isSome(files)
        ? yield* Effect.promise(() => DialogWorkspaceFileChanges.show(input.dialog, files.value))
        : "no"
      if (!fileChangeChoice) return undefined
      return fileChangeChoice === "yes"
    }),
  )
}

export function DialogWorkspaceSelect(props: {
  adapters?: Adapter[]
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  const dialog = useDialog()
  const project = useProject()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [adapters, setAdapters] = createSignal(Option.fromNullishOr(props.adapters))
  const omittedWorkspaceID = createMemo(
    () => (route.data.type === "session" ? Option.fromNullishOr(project.workspace.current()) : Option.none<string>()),
    Option.none<string>(),
    { equals: sameWorkspaceID },
  )

  onMount(() => {
    dialog.setSize("medium")
    if (Option.isSome(adapters())) return
    Effect.runFork(
      loadWorkspaceAdapters({ sdk, sync, toast }).pipe(
        Effect.tap((loaded) =>
          Effect.sync(() => {
            if (Option.isSome(loaded)) setAdapters(loaded)
          }),
        ),
      ),
    )
  })

  const options = createMemo<DialogSelectOption<WorkspaceSelectValue>[]>(() => {
    const loaded = adapters()
    if (Option.isNone(loaded)) return []
    const { recent, hasMore } = recentConnectedWorkspaces({
      workspaces: project.workspace.list(),
      status: project.workspace.status,
      omitWorkspaceID: Option.getOrUndefined(omittedWorkspaceID()),
    })
    return [
      ...loaded.value.map((adapter) => ({
        title: adapter.name,
        value: { type: "new" as const, workspaceType: adapter.type, workspaceName: adapter.name },
        description: adapter.description,
        category: "New workspace",
      })),
      {
        title: "None",
        value: { type: "none" as const },
        description: "Use the local project",
        category: "Choose workspace",
      },
      ...recent.map((workspace: Workspace) => ({
        title: workspace.name,
        description: `(${workspace.type})`,
        value: {
          type: "existing" as const,
          workspaceID: workspace.id,
          workspaceType: workspace.type,
          workspaceName: workspace.name,
        },
        category: "Choose workspace",
      })),
      ...(hasMore
        ? [
            {
              title: "View all workspaces",
              value: { type: "existing-list" as const },
              description: "Choose from all workspaces",
              category: "Choose workspace",
            },
          ]
        : []),
    ]
  })

  if (Option.isNone(adapters())) return null
  return (
    <DialogSelect<WorkspaceSelectValue>
      title="Warp"
      skipFilter={true}
      renderFilter={false}
      options={options()}
      onSelect={(option) => {
        if (!option.value) return
        if (option.value.type === "none") {
          void props.onSelect(option.value)
          return
        }
        if (option.value.type === "new") {
          void props.onSelect(option.value)
          return
        }
        if (option.value.type === "existing") {
          void props.onSelect(option.value)
          return
        }

        dialog.replace(() => (
          <DialogExistingWorkspaceSelect omitWorkspaceID={omittedWorkspaceID()} onSelect={props.onSelect} />
        ))
      }}
    />
  )
}

function DialogExistingWorkspaceSelect(props: {
  omitWorkspaceID: Option.Option<string>
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  const project = useProject()

  const options = createMemo<DialogSelectOption<ExistingWorkspaceSelectValue>[]>(() =>
    project.workspace
      .list()
      .filter((workspace) => project.workspace.status(workspace.id) === "connected")
      .filter((workspace) => !Option.contains(props.omitWorkspaceID, workspace.id))
      .map((workspace: Workspace) => ({
        title: workspace.name,
        description: `(${workspace.type})`,
        value: { workspace },
      })),
  )

  return (
    <DialogSelect<ExistingWorkspaceSelectValue>
      title="Existing Workspace"
      options={options()}
      onSelect={(option) => {
        void props.onSelect({
          type: "existing",
          workspaceID: option.value.workspace.id,
          workspaceType: option.value.workspace.type,
          workspaceName: option.value.workspace.name,
        })
      }}
    />
  )
}
