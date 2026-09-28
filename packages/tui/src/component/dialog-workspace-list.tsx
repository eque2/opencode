import type { Workspace } from "@opencode-ai/sdk/v2"
import { Data, Effect, Equivalence, Option } from "effect"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { errorMessage } from "../util/error"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"

type WorkspaceOption = { workspace: Workspace }

/** Workspace id Options are equal when both are none or both hold the same id. */
const sameWorkspaceID = Option.makeEquivalence(Equivalence.strictEqual<string>())

/** The SDK rejected a workspace remove request or returned an error response. */
class WorkspaceRemoveError extends Data.TaggedError("WorkspaceRemoveError")<{ readonly cause: unknown }> {}

export function DialogWorkspaceList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const project = useProject()
  const { theme } = useTheme()
  const [deleting, setDeleting] = createSignal(Option.none<string>(), { equals: sameWorkspaceID })
  const [removing, setRemoving] = createSignal(Option.none<string>(), { equals: sameWorkspaceID })
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})

  const current = createMemo(() => {
    if (route.data.type === "session") return sync.session.get(route.data.sessionID)?.workspaceID
    return project.workspace.current()
  })

  const options = createMemo<DialogSelectOption<WorkspaceOption>[]>(() =>
    project.workspace
      .list()
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((workspace) => {
        const status = project.workspace.status(workspace.id)
        return {
          title: Option.contains(removing(), workspace.id)
            ? "Deleting…"
            : Option.contains(deleting(), workspace.id)
              ? `Delete ${workspace.name}? Press delete again`
              : workspace.name,
          value: { workspace },
          footer: workspace.type,
          ...(expanded[workspace.id] && workspace.directory ? { details: [workspace.directory] } : {}),
          gutter: () => <text fg={status === "connected" ? theme.success : theme.error}>●</text>,
        }
      }),
  )

  function showDetails(workspace: Workspace) {
    setExpanded(workspace.id, (open) => !open)
  }

  function remove(workspace: Workspace) {
    if (Option.isSome(removing())) return
    if (!Option.contains(deleting(), workspace.id)) {
      setDeleting(Option.some(workspace.id))
      return
    }

    setDeleting(Option.none())
    setRemoving(Option.some(workspace.id))
    Effect.runFork(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => sdk.client.experimental.workspace.remove({ id: workspace.id }),
          catch: (cause) => new WorkspaceRemoveError({ cause }),
        }).pipe(
          Effect.filterOrFail(
            (result) => !result.error,
            (result) => new WorkspaceRemoveError({ cause: result.error }),
          ),
        )

        if (current() === workspace.id) {
          project.workspace.set()
          route.navigate({ type: "home" })
        }
        yield* Effect.promise(() => project.workspace.sync())
        yield* Effect.tryPromise(() => sync.bootstrap({ fatal: false })).pipe(Effect.ignore)
        setRemoving(Option.none())
      }).pipe(
        Effect.catchTag("WorkspaceRemoveError", (error) =>
          Effect.sync(() => {
            setRemoving(Option.none())
            toast.show({
              variant: "error",
              title: "Failed to delete workspace",
              message: errorMessage(error.cause),
            })
          }),
        ),
        Effect.tapDefect((defect) => Effect.logError(defect)),
      ),
    )
  }

  onMount(() => {
    dialog.setSize("large")
    Effect.runFork(Effect.tryPromise(() => sdk.client.experimental.workspace.syncList()).pipe(Effect.ignore))
    void project.workspace.sync()
  })

  return (
    <DialogSelect
      title="Workspaces"
      options={options()}
      onMove={() => {
        setDeleting(Option.none())
      }}
      onSelect={(option) => showDetails(option.value.workspace)}
      actions={[
        {
          command: "session.delete",
          title: "delete",
          onTrigger: (option) => remove(option.value.workspace),
        },
      ]}
    />
  )
}
