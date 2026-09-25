import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { Effect, Option, Predicate, Schema } from "effect"
import { createMemo, createResource, createSignal, onMount, Show } from "solid-js"
import path from "path"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { abbreviateHome } from "../runtime"
import { useTuiPaths } from "../context/runtime"
import { Locale } from "../util/locale"
import { errorMessage } from "../util/error"
import { useToast } from "../ui/toast"
import { useCommandShortcut } from "../keymap"
import { useProject } from "../context/project"
import { Spinner } from "./spinner"
import { DialogWorkspaceFileChanges } from "./dialog-workspace-file-changes"
import type { ProjectDirectories, V2ProjectCopyRemoveError } from "@opencode-ai/sdk/v2"
import { useRoute } from "../context/route"

export type MoveSessionSelection = { type: "directory"; directory: string; subdirectory: boolean } | { type: "new" }
type ProjectDirectory = ProjectDirectories[number]

type DialogMoveSessionProps = {
  projectID: string
  current?: MoveSessionSelection
  onSelect: (selection: MoveSessionSelection) => void
  onCurrentChange?: (selection: MoveSessionSelection) => void
  initialDirectories?: ProjectDirectory[]
  initialRemoving?: string
}

class MoveSessionRequestError extends Schema.TaggedError<MoveSessionRequestError>()(
  "TuiDialogMoveSession.RequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Waits on an SDK call. A rejection becomes a MoveSessionRequestError that keeps the thrown value as its cause.
function request<A>(evaluate: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new MoveSessionRequestError({ message: errorMessage(cause), cause }),
  })
}

// A defect used to surface as an unhandled rejection of the floating remove Promise.
function logDefect(defect: unknown) {
  return Effect.logError(defect)
}

export function DialogMoveSession(props: DialogMoveSessionProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const sync = useSync()
  const projectContext = useProject()
  const route = useRoute()
  const toast = useToast()
  const paths = useTuiPaths()
  const [working, setWorking] = createSignal(Boolean(props.initialRemoving))
  const [toDelete, setToDelete] = createSignal(Option.none<string>())
  const [removing, setRemoving] = createSignal(Option.fromUndefinedOr(props.initialRemoving))
  const [replacementCurrent, setReplacementCurrent] = createSignal<string>()
  const [loadError, setLoadError] = createSignal(Option.none<unknown>())
  const deleteHint = useCommandShortcut("dialog.move_session.delete")
  onMount(() => dialog.setSize("xlarge"))

  function reopen(initialRemoving?: string) {
    dialog.replace(() => (
      <DialogMoveSession {...props} initialDirectories={directoryData()} initialRemoving={initialRemoving} />
    ))
  }

  // A failed current-checkout lookup only affects which row is highlighted, so
  // swallow it and let the directory list render without a current marker.
  const [loadedProject] = createResource(
    // A false source tells createResource not to fetch.
    () => projectContext.project() !== props.projectID && props.projectID,
    (projectID) =>
      Effect.runPromise(
        Effect.option(request(() => sdk.client.project.current({}, { throwOnError: true }))).pipe(
          Effect.map((result) =>
            result.pipe(
              Option.flatMapNullishOr((response) => response.data),
              Option.filter((data) => data.id === projectID),
              Option.map((data) => data.worktree),
              Option.getOrUndefined,
            ),
          ),
        ),
      ),
  )
  const currentCheckout = createMemo(() => {
    if (projectContext.project() === props.projectID) return projectContext.instance.path().worktree
    return loadedProject()
  })

  const [directories, { refetch }] = createResource(
    () => !props.initialRemoving && props.projectID,
    (projectID, info): Promise<ProjectDirectory[] | undefined> =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* request(() =>
            sdk.client.v2.projectCopy.refresh(
              { projectID, location: { directory: sdk.directory } },
              { throwOnError: true },
            ),
          )
          const loaded = yield* request(() => sdk.client.project.directories({ projectID }, { throwOnError: true }))
          setLoadError(Option.none())
          return loaded.data ?? []
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              // A falsy thrown value counts as no error, as the old Boolean(loadError()) check did.
              setLoadError(Option.liftPredicate(error.cause, Boolean))
              // An initial load with no data surfaces the inline error view below. A
              // failed refresh intentionally stays quiet and keeps the already-shown
              // list interactive; reopening the dialog retries the load.
              return info.value
            }),
          ),
        ),
      ),
  )
  const directoryData = createMemo(() => directories() ?? props.initialDirectories)
  // Show the locked error view only when we have nothing to display. A refresh
  // that fails after the list rendered keeps the list and its actions.
  const errorText = createMemo(() => (directoryData() ? Option.none<string>() : Option.map(loadError(), errorMessage)))
  const showError = createMemo(() => Option.isSome(errorText()))

  const currentDirectory = createMemo(
    () => replacementCurrent() ?? (props.current?.type === "directory" ? props.current.directory : currentCheckout()),
  )
  const currentRoot = createMemo<ProjectDirectory | undefined>(() => {
    if (showError()) return undefined
    const directory = currentDirectory()
    if (!directory) return undefined
    return (
      directoryData()
        ?.filter((root) => contains(root.directory, directory))
        .toSorted((a, b) => b.directory.length - a.directory.length)[0] ?? { directory }
    )
  })

  // A row with Option.none() is a status line that cannot be selected.
  const options = createMemo<DialogSelectOption<Option.Option<MoveSessionSelection>>[]>(() => {
    if (showError()) return []
    const data = directoryData()
    const current = currentRoot()?.directory
    if (directories.loading && !data && !current)
      return [{ title: "Loading project directories…", value: Option.none() }]
    const loaded = data ?? []
    const unsorted: ProjectDirectory[] =
      current && !loaded.some((item) => item.directory === current) ? [{ directory: current }, ...loaded] : loaded
    const roots = unsorted.toSorted((a, b) => {
      if (a.directory === current) return -1
      if (b.directory === current) return 1
      if (Boolean(a.strategy) !== Boolean(b.strategy)) return a.strategy ? 1 : -1
      if (!a.strategy && !b.strategy) return a.directory.length - b.directory.length
      return 0
    })
    if (roots.length === 0) return [{ title: "No project directories found", value: Option.none() }]

    const subdirectories = sync.data.session
      .filter((session) => session.projectID === props.projectID && session.path && ![".", "/"].includes(session.path))
      .map((session) => session.directory)
      .filter((directory) => !roots.some((root) => root.directory === directory))
      .filter((directory, index, directories) => directories.indexOf(directory) === index)
      .map((location) => ({
        location,
        root: roots
          .filter((root) => {
            const relative = path.relative(root.directory, location)
            return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
          })
          .toSorted((a, b) => b.directory.length - a.directory.length)[0],
      }))
      .filter((item): item is { location: string; root: ProjectDirectory } => item.root !== undefined)

    const list = [...roots.map((root) => ({ location: root.directory, root })), ...subdirectories].toSorted((a, b) => {
      const root = roots.indexOf(a.root) - roots.indexOf(b.root)
      if (root !== 0) return root
      if (a.location === a.root.directory) return -1
      if (b.location === b.root.directory) return 1
      return a.location.localeCompare(b.location)
    })
    const titleWidth = Math.max(1, Math.min(116, dimensions().width - 2) - 12)

    return list.map((item) => {
      const title = abbreviateHome(item.location, paths.home)
      const suffix =
        item.location === item.root.directory
          ? Option.none<string>()
          : Option.some(path.sep + path.relative(item.root.directory, item.location))
      const visible = Locale.truncateLeft(title, titleWidth)
      const deleting = Option.contains(toDelete(), item.location)
      const isRemoving = Option.contains(removing(), item.location)
      const titleView = isRemoving
        ? Option.some(<span style={{ fg: theme.error }}>Deleting {item.location}</span>)
        : deleting
          ? Option.some(<span style={{ fg: theme.text }}>Press {deleteHint()} again to confirm</span>)
          : Option.map(suffix, (value) => {
              const split = Math.max(0, visible.length - value.length)
              return (
                <>
                  {visible.slice(0, split)}
                  <span style={{ fg: theme.textMuted }}>{visible.slice(split)}</span>
                </>
              )
            })
      return {
        title,
        ...Option.match(titleView, { onNone: () => ({}), onSome: (view) => ({ titleView: view }) }),
        ...(deleting ? { bg: theme.error } : {}),
        value: Option.some<MoveSessionSelection>({
          type: "directory",
          directory: item.location,
          subdirectory: item.location !== item.root.directory,
        }),
        category: item.root.directory === current ? "Current" : "Other",
        titleWidth,
        truncateTitle: "left" as const,
      }
    })
  })

  const current = createMemo((): Option.Option<MoveSessionSelection> => {
    if (directories.loading || loadedProject.loading) return Option.none()
    const replacement = replacementCurrent()
    if (replacement) return Option.some({ type: "directory", directory: replacement, subdirectory: false })
    return Option.fromUndefinedOr(props.current)
  })

  function removedCurrent(current: boolean) {
    if (!current) return false
    const fallback = projectContext.data.project.mainDir
    if (fallback) setReplacementCurrent(fallback)
    if (route.data.type === "session") {
      route.navigate({ type: "home" })
      dialog.clear()
      return true
    }
    if (fallback) {
      props.onCurrentChange?.({ type: "directory", directory: fallback, subdirectory: false })
      return true
    }
    dialog.clear()
    return true
  }

  function remove(option: DialogSelectOption<Option.Option<MoveSessionSelection>>) {
    if (Option.isNone(option.value) || Option.isSome(removing())) return
    const selected = option.value.value
    if (selected.type !== "directory" || selected.subdirectory) return
    const data = directoryData()
    const root = data?.find((item) => item.directory === selected.directory)
    if (!root?.strategy) return
    const deletingCurrent = selected.directory === currentRoot()?.directory
    if (!Option.contains(toDelete(), selected.directory)) {
      setToDelete(Option.some(selected.directory))
      return
    }
    setToDelete(Option.none())
    setRemoving(Option.some(selected.directory))
    setWorking(true)
    Effect.runFork(removeDirectory(selected.directory, deletingCurrent).pipe(Effect.tapDefect(logDefect)))
  }

  // Gives the API or transport error of a copy removal, or Option.none() when the copy is gone.
  function removeCopy(
    directory: string,
    force: boolean,
  ): Effect.Effect<Option.Option<V2ProjectCopyRemoveError | MoveSessionRequestError>> {
    return request(() =>
      sdk.client.v2.projectCopy.remove({
        projectID: props.projectID,
        location: { directory: sdk.directory },
        projectCopyRemovePayload: {
          directory,
          force,
        },
      }),
    ).pipe(
      Effect.map((result) => Option.fromNullishOr(result.error)),
      Effect.catch((error) => Effect.succeed(Option.some(error))),
    )
  }

  function removeDirectory(directory: string, deletingCurrent: boolean) {
    return Effect.gen(function* () {
      const failure = yield* removeCopy(directory, false)
      if (Option.isNone(failure)) {
        const reload = refetch()
        // refetch gives a Promise while the list reloads. Wait for it, so the spinner stops with the new list.
        if (Predicate.isPromiseLike(reload)) yield* Effect.promise(() => reload)
        setRemoving(Option.none())
        setWorking(false)
        removedCurrent(deletingCurrent)
        return
      }
      setRemoving(Option.none())
      setWorking(false)
      const error = failure.value
      if (!("data" in error && error.data.forceRequired)) {
        toast.show({
          variant: "error",
          title: "Failed to delete project copy",
          message: errorMessage(error),
        })
        return
      }
      const status = yield* Effect.option(request(() => sdk.client.vcs.status({ directory })))
      const choice = yield* DialogWorkspaceFileChanges.choose(
        dialog,
        status.pipe(
          Option.flatMapNullishOr((result) => result.data),
          Option.getOrElse(() => []),
        ),
        {
          title: "Delete working copy?",
          message: "This working copy has file changes. Do you want to delete it anyway?",
        },
      )
      if (!Option.contains(choice, "yes")) {
        reopen()
        return
      }
      reopen(directory)
      const forced = yield* removeCopy(directory, true)
      if (Option.isSome(forced)) {
        toast.show({
          variant: "error",
          title: "Failed to delete project copy",
          message: errorMessage(forced.value),
        })
        reopen()
        return
      }
      setRemoving(Option.none())
      setWorking(false)
      if (removedCurrent(deletingCurrent)) return
      reopen()
    })
  }

  const fullHeight = createMemo(() =>
    Math.max(8, Math.min(16, dimensions().height - Math.floor(dimensions().height / 4) - 2)),
  )

  return (
    <box minHeight={showError() ? 5 : fullHeight()}>
      <DialogSelect
        title="Move session"
        titleView={
          <box flexDirection="row" gap={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Move session
            </text>
            <Show when={working() || directories.loading || loadedProject.loading}>
              <Spinner />
            </Show>
          </box>
        }
        renderFilter={!showError()}
        options={options()}
        {...Option.match(errorText(), {
          onNone: () => ({}),
          onSome: (message) => ({
            emptyView: (
              <box paddingLeft={4} paddingRight={4}>
                <text fg={theme.error} attributes={TextAttributes.BOLD}>
                  Could not load project directories
                </text>
                <text fg={theme.textMuted}>{message}</text>
              </box>
            ),
          }),
        })}
        locked={showError() || directories.loading || loadedProject.loading || Option.isSome(removing())}
        current={current()}
        onSelect={(option) => {
          if (Option.isSome(option.value)) props.onSelect(option.value.value)
        }}
        onMove={() => setToDelete(Option.none())}
        actions={
          showError()
            ? []
            : [
                {
                  command: "dialog.move_session.new",
                  title: "new",
                  onTrigger: () => props.onSelect({ type: "new" }),
                },
                {
                  command: "dialog.move_session.delete",
                  title: "delete",
                  disabled: (option) => {
                    if (!option || Option.isNone(option.value)) return true
                    const value = option.value.value
                    if (value.type !== "directory" || value.subdirectory) return true
                    return !directoryData()?.find((item) => item.directory === value.directory)?.strategy
                  },
                  onTrigger: remove,
                },
                {
                  command: "dialog.move_session.refresh",
                  title: "refresh",
                  onTrigger: () => void refetch(),
                },
              ]
        }
      />
    </box>
  )
}

function contains(root: string, directory: string) {
  if (root === directory) return true
  const relative = path.relative(root, directory)
  return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}
