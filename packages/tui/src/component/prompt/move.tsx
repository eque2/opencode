import { Effect, Fiber, Option, Schema } from "effect"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import path from "path"
import { useTuiPaths } from "../../context/runtime"
import { errorMessage } from "../../util/error"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useToast } from "../../ui/toast"
import { DialogMoveSession, type MoveSessionSelection } from "../dialog-move-session"
import { DialogWorkspaceFileChanges, type WorkspaceFileChangesChoice } from "../dialog-workspace-file-changes"
import { useHomeSessionDestination } from "../../routes/home/session-destination"
import { useProject } from "../../context/project"

class PromptMoveError extends Schema.TaggedError<PromptMoveError>()("TuiPromptMove.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// Waits on an SDK call. A rejection becomes a PromptMoveError that keeps the thrown value as its cause.
function request<A>(evaluate: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new PromptMoveError({ message: errorMessage(cause), cause }),
  })
}

// A defect used to surface as an unhandled rejection of the floating move Promise.
function logDefect(defect: unknown) {
  return Effect.logError(defect)
}

function moveReminderText(directory: string) {
  return `<system-reminder>The user has changed the current working directory to "${directory}". This is still the same project but at a possibly new location; take this into account when working with any files from now on.</system-reminder>`
}

export function usePromptMove(input: { projectID: () => string | undefined; sessionID: () => string | undefined }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const homeDestination = useHomeSessionDestination()
  const project = useProject()
  const paths = useTuiPaths()
  const [creating, setCreating] = createSignal(false)
  const [creatingDots, setCreatingDots] = createSignal(3)
  const [progress, setProgress] = createSignal(Option.none<string>())

  // Copies the project for a new working directory. A failure shows a toast and gives Option.none().
  function create(context: Option.Option<string>) {
    return Effect.gen(function* () {
      const projectID = input.projectID()
      if (!projectID) return Option.none<string>()
      setCreating(true)
      setProgress(Option.some("Creating copy"))
      const generated = yield* request(() =>
        sdk.client.experimental.projectCopy.generateName(
          { projectID, context: Option.getOrUndefined(context) },
          { throwOnError: true },
        ),
      )
      const result = yield* request(() =>
        sdk.client.v2.projectCopy.create(
          {
            projectID,
            location: { directory: sdk.directory },
            projectCopyCreatePayload: {
              strategy: "git_worktree",
              directory: path.join(paths.worktree, projectID.slice(0, 6)),
              name: generated.data.name,
            },
          },
          { throwOnError: true },
        ),
      )
      const directory = yield* Option.match(Option.fromNullishOr(result.data?.directory), {
        onNone: () => Effect.fail(new PromptMoveError({ message: "No project copy directory returned" })),
        onSome: Effect.succeed,
      })

      // Call a location-based route to make sure it's bootstrapped
      // before moving on
      yield* request(() => sdk.client.path.get({ directory }, { throwOnError: true }))

      setProgress(Option.some("Creating session"))
      return Option.some(directory)
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          homeDestination?.clear()
          setProgress(Option.none())
          setCreating(false)
          toast.show({ title: "Creating workspace failed", message: error.message, variant: "error" })
          return Option.none<string>()
        }),
      ),
    )
  }

  function open() {
    const projectID = input.projectID()
    if (!projectID) return
    const session = Option.fromNullishOr(input.sessionID()).pipe(
      Option.filter((sessionID) => sessionID !== ""),
      Option.flatMapNullishOr((sessionID) => sync.session.get(sessionID)),
    )
    dialog.replace(() => (
      <DialogMoveSession
        projectID={projectID}
        current={
          homeDestination?.destination() ??
          Option.match(session, {
            onSome: (value): MoveSessionSelection => ({
              type: "directory",
              directory: value.directory,
              subdirectory: !!value.path,
            }),
            onNone: (): MoveSessionSelection => ({
              type: "directory",
              directory: project.instance.directory(),
              subdirectory: project.instance.directory() !== project.instance.path().worktree,
            }),
          })
        }
        onCurrentChange={(selection) => homeDestination?.setDestination(selection)}
        onSelect={(selection) => {
          const sessionID = input.sessionID()
          if (!sessionID) {
            homeDestination?.setDestination(selection)
            dialog.clear()
            return
          }
          Effect.runFork(moveExistingSession(sessionID, selection).pipe(Effect.tapDefect(logDefect)))
        }}
      />
    ))
  }

  function sessionContext(sessionID: string) {
    const session = sync.session.get(sessionID)
    const messages = (sync.data.message[sessionID] ?? [])
      .slice(-6)
      .map((message) =>
        [
          message.role + ":",
          ...(sync.data.part[message.id] ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
        ].join(" "),
      )
    return Option.some([session?.title, ...messages].filter(Boolean).join("\n")).pipe(
      Option.filter((text) => text.length > 0),
    )
  }

  function moveExistingSession(sessionID: string, selection: MoveSessionSelection) {
    return Effect.gen(function* () {
      const session = sync.session.get(sessionID)
      // A failed status lookup moves the session without asking about file changes.
      const status = yield* Effect.option(request(() => sdk.client.vcs.status({ directory: session?.directory })))
      const files = status.pipe(
        Option.flatMap((result) => Option.fromNullishOr(result.data)),
        Option.filter((data) => data.length > 0),
      )
      const choice = Option.isSome(files)
        ? yield* DialogWorkspaceFileChanges.choose(dialog, files.value)
        : Option.some<WorkspaceFileChangesChoice>("no")
      if (Option.isNone(choice)) return
      dialog.clear()
      const directory =
        selection.type === "new" ? yield* create(sessionContext(sessionID)) : Option.some(selection.directory)
      if (Option.isNone(directory)) {
        setProgress(Option.none())
        dialog.clear()
        return
      }
      yield* moveSession(sessionID, directory.value, choice.value === "yes")
    })
  }

  function moveSession(sessionID: string, directory: string, moveChanges: boolean) {
    return Effect.gen(function* () {
      setProgress(Option.some("Moving session"))
      yield* request(() =>
        sdk.client.experimental.controlPlane.moveSession(
          {
            sessionID,
            destination: { directory },
            moveChanges,
          },
          { throwOnError: true },
        ),
      )
      yield* Effect.ignore(
        request(() =>
          sdk.client.session.promptAsync({
            sessionID,
            directory,
            noReply: true,
            parts: [
              {
                type: "text",
                text: moveReminderText(directory),
                synthetic: true,
              },
            ],
          }),
        ),
      )
      dialog.clear()
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          toast.error(error.cause)
          dialog.clear()
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          setProgress(Option.none())
          setCreating(false)
        }),
      ),
    )
  }

  const pending = createMemo(() => Boolean(homeDestination?.destination()))
  const pendingNew = createMemo(() => homeDestination?.destination()?.type === "new")

  function getDirectory(context?: string): Promise<string | undefined> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const value = homeDestination?.destination()
        if (!value) return Option.none<string>()
        if (value.type === "directory") return Option.some(value.directory)
        return yield* create(Option.fromUndefinedOr(context))
      }).pipe(Effect.map(Option.getOrUndefined)),
    )
  }

  function startSubmit() {
    if (Option.isSome(progress())) setProgress(Option.some("Submitting prompt"))
  }

  function finishSubmit() {
    homeDestination?.clear()
    setProgress(Option.none())
    setCreating(false)
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

  return {
    creating,
    creatingDots,
    finishSubmit,
    getDirectory,
    open,
    pending,
    pendingNew,
    // The prompt reads the progress text in a Solid <Match when>, so absence crosses to it as undefined.
    progress: () => Option.getOrUndefined(progress()),
    startSubmit,
  }
}
