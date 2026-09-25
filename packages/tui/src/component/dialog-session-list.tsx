import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import path from "path"
import { Data, DateTime, Effect, Equivalence, HashMap, HashSet, MutableHashSet, Option, Predicate } from "effect"
import { Locale } from "../util/locale"
import { useProject } from "../context/project"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { DialogSessionRename } from "./dialog-session-rename"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { openWorkspaceSelect, type WorkspaceSelection, warpWorkspaceSession } from "./dialog-workspace-create"
import { Spinner } from "./spinner"
import { errorMessage } from "../util/error"
import { DialogSessionDeleteFailed } from "./dialog-session-delete-failed"
import { useCommandShortcut } from "../keymap"
import { useEvent } from "../context/event"

type SessionListFilter = { scope?: "project"; path?: string }

/** The SDK rejected a workspace create request or returned no workspace. */
class WorkspaceCreateError extends Data.TaggedError("WorkspaceCreateError")<{ readonly cause: unknown }> {}

/** The SDK returned an error response for a workspace remove request. */
class WorkspaceRemoveError extends Data.TaggedError("WorkspaceRemoveError")<{ readonly cause: unknown }> {}

/** The SDK rejected a session delete request or returned an error response. */
class SessionDeleteError extends Data.TaggedError("SessionDeleteError")<{ readonly cause: unknown }> {}

/** Session id Options are equal when both are none or both hold the same id. */
const sameSessionID = Option.makeEquivalence(Equivalence.strictEqual<string>())

/** Waits for a Solid resource refetch, which returns either the value or a Promise of it. */
function awaitRefetch(pending: unknown) {
  return Predicate.isPromiseLike(pending) ? Effect.asVoid(Effect.promise(() => pending)) : Effect.void
}

export function createDialogSessionListQuery(input: { search?: string; filter: SessionListFilter }) {
  const search = input.search?.trim()
  return {
    roots: true,
    limit: search ? 30 : 100,
    ...(search ? { search } : {}),
    ...input.filter,
  }
}

export function loadDialogSessionList<T>(input: {
  search?: string
  filter: SessionListFilter
  list: (query: ReturnType<typeof createDialogSessionListQuery>) => Promise<{ data?: T[] }>
}) {
  return Effect.runPromise(
    Effect.tryPromise(() => input.list(createDialogSessionListQuery(input))).pipe(
      Effect.option,
      // createResource reads an undefined value as "no data", so a failed or empty list crosses as undefined.
      Effect.map((result) => Option.getOrUndefined(Option.flatMapNullishOr(result, (response) => response.data))),
    ),
  )
}

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const project = useProject()
  const { theme } = useTheme()
  const sdk = useSDK()
  const event = useEvent()
  const local = useLocal()
  const toast = useToast()
  const [toDelete, setToDelete] = createSignal(Option.none<string>(), { equals: sameSessionID })
  const [deleted, setDeleted] = createSignal(HashSet.empty<string>())
  const [search, setSearch] = createDebouncedSignal("", 150)
  const deleteHint = useCommandShortcut("session.delete")
  const quickSwitch1 = useCommandShortcut("session.quick_switch.1")
  const quickSwitch9 = useCommandShortcut("session.quick_switch.9")

  const [browseResults, { refetch: refetchBrowse }] = createResource(
    () => sync.session.query(),
    (filter) => loadDialogSessionList({ filter, list: (query) => sdk.client.session.list(query) }),
  )
  const [searchResults, { refetch }] = createResource(
    () => ({ query: search(), filter: sync.session.query() }),
    (input) => {
      if (!input.query) return undefined
      return loadDialogSessionList({
        search: input.query,
        filter: input.filter,
        list: (query) => sdk.client.session.list(query),
      })
    },
  )

  const currentSessionID = createMemo(
    () => (route.data.type === "session" ? Option.some(route.data.sessionID) : Option.none<string>()),
    Option.none<string>(),
    { equals: sameSessionID },
  )
  const sessions = createMemo(() => {
    const result = searchResults() ?? browseResults() ?? sync.data.session
    const synced = HashMap.fromIterable(sync.data.session.map((session) => [session.id, session]))
    const ids = MutableHashSet.fromIterable(result.map((session) => session.id))
    const extra = [...Option.toArray(currentSessionID()), ...local.session.pinned()].flatMap((id) => {
      if (!id || MutableHashSet.has(ids, id)) return []
      const session = HashMap.get(synced, id)
      if (Option.isSome(session)) MutableHashSet.add(ids, id)
      return Option.toArray(session)
    })
    const query = search().trim().toLowerCase()
    return [...result.map((session) => Option.getOrElse(HashMap.get(synced, session.id), () => session)), ...extra]
      .filter((session) => !HashSet.has(deleted(), session.id))
      .filter((session) => !query || session.title.toLowerCase().includes(query))
  })

  onCleanup(
    event.on("session.deleted", (event) => {
      setDeleted((current) => HashSet.add(current, event.properties.info.id))
    }),
  )

  type SessionInfo = NonNullable<ReturnType<typeof sessions>[number]>

  function recover(session: SessionInfo) {
    const workspace = project.workspace.get(session.workspaceID!)
    const list = () => dialog.replace(() => <DialogSessionList />)
    const createWorkspace = (workspaceType: string) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => sdk.client.experimental.workspace.create({ type: workspaceType, branch: null }),
          catch: (cause) => new WorkspaceCreateError({ cause }),
        })
        const workspace = result.data
        if (!workspace) return yield* new WorkspaceCreateError({ cause: result.error ?? "no response" })
        yield* Effect.promise(() => project.workspace.sync())
        return workspace.id
      })
    const warp = (selection: WorkspaceSelection) =>
      Effect.gen(function* () {
        const workspaceID =
          selection.type === "none"
            ? Option.none<string>()
            : selection.type === "existing"
              ? Option.some(selection.workspaceID)
              : Option.some(yield* createWorkspace(selection.workspaceType))
        yield* Effect.promise(() =>
          warpWorkspaceSession({
            dialog,
            sdk,
            sync,
            project,
            toast,
            sourceWorkspaceID: session.workspaceID,
            workspaceID: Option.getOrNull(workspaceID),
            sessionID: session.id,
            copyChanges: false,
            done: list,
          }),
        )
      }).pipe(
        Effect.catchTag("WorkspaceCreateError", (error) =>
          Effect.sync(() =>
            toast.show({
              title: "Failed to create workspace",
              message: errorMessage(error.cause),
              variant: "error",
            }),
          ),
        ),
        Effect.tapDefect((defect) => Effect.logError(defect)),
      )
    dialog.replace(() => (
      <DialogSessionDeleteFailed
        session={session.title}
        workspace={workspace?.name ?? session.workspaceID!}
        onDone={list}
        onDelete={() => {
          const info = currentSessionID().pipe(
            Option.flatMapNullishOr((current) => sync.data.session.find((item) => item.id === current)),
          )
          return Effect.runPromise(
            Effect.gen(function* () {
              const result = yield* Effect.promise(() =>
                sdk.client.experimental.workspace.remove({ id: session.workspaceID! }),
              )
              if (result.error) return yield* new WorkspaceRemoveError({ cause: result.error })
              yield* Effect.promise(() => project.workspace.sync())
              yield* Effect.promise(() => sync.session.refresh())
              yield* awaitRefetch(refetchBrowse())
              if (search()) yield* awaitRefetch(refetch())
              if (Option.exists(info, (item) => item.workspaceID === session.workspaceID)) {
                route.navigate({ type: "home" })
              }
              return true
            }).pipe(
              Effect.catchTag("WorkspaceRemoveError", (error) =>
                Effect.sync(() => {
                  toast.show({
                    variant: "error",
                    title: "Failed to delete workspace",
                    message: errorMessage(error.cause),
                  })
                  return false
                }),
              ),
            ),
          )
        }}
        onRestore={() => {
          void openWorkspaceSelect({
            dialog,
            sdk,
            sync,
            project,
            toast,
            onSelect: (selection) => {
              Effect.runFork(warp(selection))
            },
          })
          return false
        }}
      />
    ))
  }

  function orderByRecency(sessionsList: NonNullable<ReturnType<typeof sessions>>) {
    return sessionsList
      .filter((x) => x.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .map((x) => x.id)
  }

  const browseOrder = createMemo(() => orderByRecency(browseResults() ?? sync.data.session))

  const quickSwitchHint = createMemo(() => {
    const first = quickSwitch1()
    const last = quickSwitch9()
    if (!first || !last) return undefined
    return quickSwitchRange(first, last)
  })
  const quickSwitchFooterHints = createMemo(() => {
    const hint = quickSwitchHint()
    return hint && local.session.slots().length > 0 ? [{ title: "switch", label: hint }] : []
  })

  const options = createMemo(() => {
    // toDateString is the category label format; DateTime.toDate crosses to it.
    const today = DateTime.toDate(DateTime.nowUnsafe()).toDateString()
    const sessionMap = HashMap.fromIterable(
      sessions()
        .filter((x) => x.parentID === undefined)
        .map((x) => [x.id, x]),
    )

    const searchResult = searchResults()
    const order = searchResult ? orderByRecency(sessions()) : browseOrder()
    const currentOutsideOrder = currentSessionID().pipe(
      Option.filter((id) => HashMap.has(sessionMap, id) && !order.includes(id)),
      Option.toArray,
    )
    const displayOrder = [...order, ...currentOutsideOrder]

    const pinned = local.session.pinned().filter((id) => HashMap.has(sessionMap, id))
    const pinnedSet = HashSet.fromIterable(pinned)
    const slotByID = HashMap.fromIterable(local.session.slots().map((id, i) => [id, i + 1]))

    function buildOption(x: SessionInfo, category: string): DialogSelectOption<string> {
      const directory = x.path
        ? x.directory.endsWith(x.path)
          ? Option.some(x.directory.slice(0, -x.path.length).replace(/\/$/, ""))
          : Option.none<string>()
        : Option.some(x.directory)
      const footer = directory.pipe(
        Option.filter((dir) => dir !== "" && dir !== project.data.project.mainDir),
        Option.match({ onNone: () => "", onSome: (dir) => Locale.truncate(path.basename(dir), 20) }),
      )

      const isDeleting = Option.contains(toDelete(), x.id)
      const status = sync.data.session_status?.[x.id]
      const isWorking = status?.type === "busy" || status?.type === "retry"
      const gutter = isWorking
        ? Option.some(() => <Spinner />)
        : HashMap.get(slotByID, x.id).pipe(Option.map((slot) => () => <text fg={theme.accent}>{slot}</text>))
      return {
        title: isDeleting ? `Press ${deleteHint()} again to confirm` : x.title,
        ...(isDeleting ? { bg: theme.error } : {}),
        value: x.id,
        category,
        footer,
        ...Option.match(gutter, { onNone: () => ({}), onSome: (render) => ({ gutter: render }) }),
      }
    }

    const remaining = displayOrder
      .filter((id) => !HashSet.has(pinnedSet, id))
      .flatMap((id) =>
        HashMap.get(sessionMap, id).pipe(
          Option.map((x) => {
            const label = DateTime.toDate(DateTime.makeUnsafe(x.time.updated)).toDateString()
            return buildOption(x, label === today ? "Today" : label)
          }),
          Option.toArray,
        ),
      )

    return [
      ...pinned.flatMap((id) =>
        HashMap.get(sessionMap, id).pipe(
          Option.map((x) => buildOption(x, "Pinned")),
          Option.toArray,
        ),
      ),
      ...remaining,
    ]
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Sessions"
      options={options()}
      skipFilter={true}
      preserveSelection={true}
      current={Option.getOrUndefined(currentSessionID())}
      onFilter={setSearch}
      onMove={() => {
        setToDelete(Option.none())
      }}
      onSelect={(option) => {
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
      actions={[
        {
          command: "session.pin.toggle",
          title: "pin/unpin",
          onTrigger: (option: { value: string }) => {
            local.session.togglePin(option.value)
          },
        },
        {
          command: "session.delete",
          title: "delete",
          onTrigger: (option) => {
            if (Option.contains(toDelete(), option.value)) {
              const session = sessions().find((item) => item.id === option.value)
              const status = Option.fromNullishOr(session?.workspaceID).pipe(
                Option.filter(Predicate.isTruthy),
                Option.flatMapNullishOr((workspaceID) => project.workspace.status(workspaceID)),
              )

              Effect.runFork(
                Effect.gen(function* () {
                  yield* Effect.tryPromise({
                    try: () =>
                      sdk.client.session.delete({
                        sessionID: option.value,
                      }),
                    catch: (cause) => new SessionDeleteError({ cause }),
                  }).pipe(
                    Effect.filterOrFail(
                      (result) => !result.error,
                      (result) => new SessionDeleteError({ cause: result.error }),
                    ),
                  )
                  if (Option.exists(status, (value) => value !== "connected")) {
                    yield* Effect.promise(() => sync.session.refresh())
                  }
                  yield* awaitRefetch(refetchBrowse())
                  if (search()) yield* awaitRefetch(refetch())
                  setToDelete(Option.none())
                }).pipe(
                  Effect.catchTag("SessionDeleteError", (error) =>
                    Effect.sync(() => {
                      if (session?.workspaceID) {
                        recover(session)
                      } else {
                        toast.show({
                          variant: "error",
                          title: "Failed to delete session",
                          message: errorMessage(error.cause),
                        })
                      }
                      setToDelete(Option.none())
                    }),
                  ),
                  Effect.tapDefect((defect) => Effect.logError(defect)),
                ),
              )
              return
            }
            setToDelete(Option.some(option.value))
          },
        },
        {
          command: "session.rename",
          title: "rename",
          onTrigger: (option) => {
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
      ]}
      footerHints={quickSwitchFooterHints()}
    />
  )
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}
