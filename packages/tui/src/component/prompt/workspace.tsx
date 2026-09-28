import { Effect, Fiber, Option, Schema } from "effect"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import {
  confirmWorkspaceFileChanges,
  openWorkspaceSelect,
  warpWorkspaceSession,
  type WorkspaceSelection,
} from "../dialog-workspace-create"
import type { WorkspaceStatus } from "../workspace-label"

class WorkspaceCreateError extends Schema.TaggedError<WorkspaceCreateError>()("TuiPromptWorkspace.CreateError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// A defect used to surface as an unhandled rejection of the floating create Promise.
function logDefect(defect: unknown) {
  return Effect.logError(defect)
}

export function usePromptWorkspace(sessionID?: string) {
  const dialog = useDialog()
  const sdk = useSDK()
  const project = useProject()
  const sync = useSync()
  const toast = useToast()
  const [selection, setSelection] = createSignal(Option.none<WorkspaceSelection>())
  const [creating, setCreating] = createSignal(false)
  const [creatingDots, setCreatingDots] = createSignal(3)
  const [notice, setNotice] = createSignal(Option.none<string>())

  // Creates the workspace and selects it. A failure clears the selection, shows a toast and gives Option.none().
  function create(selection: Extract<WorkspaceSelection, { type: "new" }>) {
    return Effect.gen(function* () {
      setCreating(true)
      const result = yield* Effect.tryPromise({
        try: () =>
          sdk.client.experimental.workspace.create({
            type: selection.workspaceType,
            // eslint-disable-next-line effect/no-null-use-option -- (b) the host passes this body to the plugin WorkspaceAdapter configure, whose WorkspaceInfo.branch is string | null; an omitted key would reach adapters as undefined
            branch: null,
          }),
        catch: (cause) => new WorkspaceCreateError({ message: errorMessage(cause), cause }),
      })
      if (result.error || !result.data) {
        return yield* new WorkspaceCreateError({ message: errorMessage(result.error ?? "no response") })
      }

      yield* Effect.promise(() => project.workspace.sync())
      const workspace = result.data
      setSelection(
        Option.some({
          type: "existing",
          workspaceID: workspace.id,
          workspaceType: workspace.type,
          workspaceName: workspace.name,
        }),
      )
      setCreating(false)
      return Option.some(workspace)
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          setSelection(Option.none())
          setCreating(false)
          toast.show({ title: "Creating workspace failed", message: error.message, variant: "error" })
          return Option.none()
        }),
      ),
    )
  }

  function warp(selection: WorkspaceSelection): Promise<void> {
    return Effect.runPromise(
      Effect.gen(function* () {
        if (!sessionID) {
          setSelection(Option.some(selection))
          dialog.clear()
          // The new workspace is created in the background, as the old `void create(selection)` did.
          if (selection.type === "new") yield* Effect.forkDetach(create(selection).pipe(Effect.tapDefect(logDefect)))
          return
        }
        const sourceWorkspaceID = project.workspace.current()
        const copyChanges = yield* Effect.promise(() => confirmWorkspaceFileChanges({ dialog, sdk, sourceWorkspaceID }))
        if (copyChanges === undefined) return
        setSelection(Option.some(selection))
        dialog.clear()

        // The local project has no workspace id; the warp API reads null as "detach to the local project".
        const workspace =
          selection.type === "none"
            ? Option.some({ id: Option.none<string>(), name: "local project" })
            : selection.type === "existing"
              ? Option.some({ id: Option.some(selection.workspaceID), name: selection.workspaceName })
              : Option.map(yield* create(selection), (created) => ({ id: Option.some(created.id), name: created.name }))
        if (Option.isNone(workspace)) return

        const warped = yield* Effect.promise(() =>
          warpWorkspaceSession({
            dialog,
            sdk,
            sync,
            project,
            toast,
            sourceWorkspaceID,
            workspaceID: Option.getOrNull(workspace.value.id),
            sessionID,
            copyChanges,
          }),
        )
        if (warped) showNotice(workspace.value.name)
      }),
    )
  }

  // A new notice restarts the 4 second hide delay; unmount stops it.
  let noticeTimer: Option.Option<Fiber.Fiber<void>> = Option.none()
  function stopNoticeTimer() {
    if (Option.isSome(noticeTimer)) Effect.runFork(Fiber.interrupt(noticeTimer.value))
    noticeTimer = Option.none()
  }
  onCleanup(stopNoticeTimer)

  function showNotice(name: string) {
    setNotice(Option.some(`Warped to ${name}`))
    stopNoticeTimer()
    noticeTimer = Option.some(
      Effect.runFork(Effect.sleep("4 seconds").pipe(Effect.andThen(Effect.sync(clearNotice)))),
    )
  }

  function clearNotice() {
    setNotice(Option.none())
  }

  function open() {
    void openWorkspaceSelect({ dialog, sdk, sync, project, toast, onSelect: warp })
  }

  createEffect(() => {
    if (!creating()) {
      setCreatingDots(3)
      return
    }
    // Each tick waits first, as the first setInterval tick did.
    const ticker = Effect.runFork(
      Effect.forever(Effect.delay(Effect.sync(() => setCreatingDots((dots) => (dots % 3) + 1)), "1 second")),
    )
    onCleanup(() => Effect.runFork(Fiber.interrupt(ticker)))
  })

  const label = createMemo<
    | { type: "new"; workspaceType: string }
    | { type: "existing"; workspaceType: string; workspaceName: string; status?: WorkspaceStatus }
    | undefined
  >(() => {
    const current = selection()
    // The prompt reads the label in a Solid <Match when>, so no label crosses to it as undefined.
    if (Option.isNone(current)) return undefined
    const selected = current.value
    if (selected.type === "none") return undefined
    if (sessionID && !creating()) return undefined
    if (selected.type === "new") return { type: "new", workspaceType: selected.workspaceType }
    return {
      type: "existing",
      workspaceType: selected.workspaceType,
      workspaceName: selected.workspaceName,
      status: "connected",
    }
  })

  // The prompt reads selection and notice as plain values, so absence crosses to it as undefined.
  return {
    selection: () => Option.getOrUndefined(selection()),
    creating,
    creatingDots,
    notice: () => Option.getOrUndefined(notice()),
    label,
    open,
    warp,
    clearNotice,
  }
}
