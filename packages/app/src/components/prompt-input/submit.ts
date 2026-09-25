import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, startTransition, type Accessor } from "solid-js"
import { Cause, Clock, Data, Effect, MutableHashMap, Option, Predicate } from "effect"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { normalizeSessionInfo } from "@/utils/session"
import { Event } from "@opencode-ai/schema/event"
import { blobDataUrl } from "@/utils/draft-store"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = MutableHashMap.empty<string, PendingPrompt>()

/** An SDK request or an attachment read rejected. `cause` holds the original rejection. */
class PromptRequestError extends Data.TaggedError("App.PromptRequestError")<{ readonly cause: unknown }> {}

/** The worktree of a new session failed, or was still preparing when the wait timed out. */
class WorktreeWaitError extends Data.TaggedError("App.WorktreeWaitError")<{ readonly message: string }> {}

type PromptSubmitError = PromptRequestError | WorktreeWaitError

/** The value that a Promise caller receives: the original rejection of a request, or the error itself. */
const rejection = (error: PromptSubmitError): unknown => (error._tag === "App.PromptRequestError" ? error.cause : error)

const request = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new PromptRequestError({ cause }) })

const attachmentDataUrl = (attachment: ImageAttachmentPart) =>
  request(() => blobDataUrl(attachment.blob, attachment.mime))

const commandFiles = (images: ReadonlyArray<ImageAttachmentPart>) =>
  Effect.forEach(
    images,
    (attachment) => attachmentDataUrl(attachment).pipe(Effect.map((uri) => ({ uri, name: attachment.filename }))),
    { concurrency: "unbounded" },
  )

type WorktreeWaitResult = Awaited<ReturnType<typeof WorktreeState.wait>>

const worktreeWaitAborted = (signal: AbortSignal) =>
  Effect.callback<WorktreeWaitResult>((resume) => {
    const aborted = () => resume(Effect.succeed({ status: "failed", message: "aborted" }))
    signal.addEventListener("abort", aborted, { once: true })
    if (signal.aborted) aborted()
    return Effect.sync(() => signal.removeEventListener("abort", aborted))
  })

/** The model selection that a submit reads. `useLocal().model` satisfies it. */
type SubmitModelSelection = {
  current: () => { id: string; provider: { id: string } } | undefined
  variant: { current: () => string | undefined }
}

/** No popover. The prompt-input setPopover callback takes this as null. */
const closedPopover = Option.none<"at" | "slash">()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  api: DirectorySDK["api"]["session"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: Effect.Effect<boolean, WorktreeWaitError>
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

const sendFollowup = Effect.fn("PromptSubmit.sendFollowup")(function* (input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const proceed = input.before ?? Effect.succeed(true)

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    return yield* Effect.gen(function* () {
      if (!(yield* proceed)) {
        setIdle()
        return false
      }

      const messageID = Identifier.ascending("message")
      const files = yield* commandFiles(images)
      yield* request(() =>
        input.api.command({
          sessionID: input.draft.sessionID,
          id: messageID,
          command: cmd,
          arguments: tail.join(" "),
          agent: input.draft.agent,
          model: {
            id: input.draft.model.modelID,
            providerID: input.draft.model.providerID,
            variant: input.draft.variant,
          },
          files,
        }),
      )
      return true
    }).pipe(Effect.onError(() => Effect.sync(setIdle)))
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const encodedImages = yield* Effect.forEach(
    images,
    (attachment) => attachmentDataUrl(attachment).pipe(Effect.map((dataUrl) => ({ ...attachment, dataUrl }))),
    { concurrency: "unbounded" },
  )
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images: encodedImages,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const created = yield* Clock.currentTimeMillis
  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  const rollback = () =>
    batch(() => {
      setIdle()
      remove()
    })

  batch(() => {
    setBusy()
    add()
  })

  return yield* Effect.gen(function* () {
    if (!(yield* proceed)) {
      rollback()
      return false
    }

    yield* request(() =>
      input.api.prompt({
        sessionID: input.draft.sessionID,
        id: messageID,
        agent: input.draft.agent,
        model: input.draft.model,
        variant: input.draft.variant,
        legacyParts: requestParts,
        text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        files: requestParts.flatMap((part) => {
          if (part.type !== "file") return []
          const text = part.source?.text
          return [
            {
              uri: part.url,
              name: part.filename,
              mention: text ? { start: text.start, end: text.end, text: text.value } : undefined,
            },
          ]
        }),
        agents: requestParts.flatMap((part) =>
          part.type === "agent"
            ? [
                {
                  name: part.name,
                  mention: part.source
                    ? { start: part.source.start, end: part.source.end, text: part.source.value }
                    : undefined,
                },
              ]
            : [],
        ),
      }),
    )
    return true
  }).pipe(Effect.onError(() => Effect.sync(rollback)))
})

export function sendFollowupDraft(input: FollowupSendInput): Promise<boolean> {
  return Effect.runPromise(sendFollowup(input).pipe(Effect.mapError(rejection)))
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  model?: SubmitModelSelection
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
    if (err && typeof err === "object" && "data" in err) {
      const data = err.data
      if (Predicate.hasProperty(data, "message") && Predicate.isString(data.message) && data.message)
        return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const interrupt = Effect.fn("PromptSubmit.abort")(function* () {
    const sessionID = params.id
    if (!sessionID) return

    serverSync().session.set("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = MutableHashMap.get(pending, key)
    if (Option.isSome(queued)) {
      queued.value.abort.abort()
      queued.value.cleanup()
      MutableHashMap.remove(pending, key)
      return
    }
    yield* request(() => sdk().api.session.interrupt({ sessionID })).pipe(Effect.ignore)
  })

  const abort = () => Effect.runPromise(interrupt())

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const submit = Effect.fn("PromptSubmit.submit")(function* () {
    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) yield* Effect.forkDetach(interrupt(), { startImmediately: true })
      return
    }

    const modelSelection = input.model ?? local.model
    const currentModel = modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = modelSelection.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk().directory
    const permissionState = permission.currentServerState()
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk().client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdDirectory = yield* request(() => client.worktree.create({ directory: projectDirectory })).pipe(
          Effect.map((result) =>
            Option.fromNullishOr(result.data?.directory).pipe(Option.filter((directory) => directory !== "")),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              showToast({
                title: language.t("prompt.toast.worktreeCreateFailed.title"),
                description: errorMessage(error.cause),
              })
              return Option.none<string>()
            }),
          ),
        )

        if (Option.isNone(createdDirectory)) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk().scope, createdDirectory.value)
        sessionDirectory = createdDirectory.value
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk().createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      const created = yield* request(() =>
        sdk().api.session.create({
          agent: currentAgent.name,
          model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
          location: { directory: sessionDirectory },
        }),
      ).pipe(
        Effect.map((info) => Option.some(normalizeSessionInfo(info))),
        Effect.catch((error) =>
          Effect.sync(() => {
            showToast({
              title: language.t("prompt.toast.sessionCreateFailed.title"),
              description: errorMessage(error.cause),
            })
            return Option.none<Session>()
          }),
        ),
      )
      if (Option.isSome(created)) {
        const info = created.value
        seed(sessionDirectory, info)
        session = info
        // The server build of solid-js runs the transition synchronously and returns no promise.
        const transition = Option.fromNullishOr(
          startTransition(() => {
            if (shouldAutoAccept) permissionState.enableAutoAccept(info.id, sessionDirectory)
            local.session.promote(sessionDirectory, info.id, {
              agent: currentAgent.name,
              model: { providerID: currentModel.provider.id, modelID: currentModel.id },
              variant: Option.getOrNull(Option.fromNullishOr(variant)),
            })
            layout.handoff.setTabs(base64Encode(sessionDirectory), info.id)
            const draftID = search.draftId
            if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: info.id })
            else navigate(`/${base64Encode(sessionDirectory)}/session/${info.id}`)
            submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: info.id }))
          }),
        )
        if (Option.isSome(transition)) yield* Effect.promise(() => transition.value)
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(Option.getOrNull(closedPopover))
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(Option.getOrNull(closedPopover))
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext(submission.target())
      clearInput()
      return
    }

    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      const eventID = Event.ID.create()
      yield* request(() =>
        sdk().api.session.shell({
          sessionID: session.id,
          id: eventID,
          command: text,
          agent,
          model,
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            showToast({
              title: language.t("prompt.toast.shellSendFailed.title"),
              description: errorMessage(error.cause),
            })
            restoreInput()
          }),
        ),
        Effect.forkDetach({ startImmediately: true }),
      )
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync().data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        const messageID = Identifier.ascending("message")
        serverSync().session.set("session_status", session.id, { type: "busy" })
        const files = yield* commandFiles(images)
        yield* request(() =>
          sdk().api.session.command({
            sessionID: session.id,
            id: messageID,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: { id: model.modelID, providerID: model.providerID, variant },
            files,
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              serverSync().session.set("session_status", session.id, { type: "idle" })
              showToast({
                title: language.t("prompt.toast.commandSendFailed.title"),
                description: formatServerError(error.cause, language.t, language.t("common.requestFailed")),
              })
              restoreInput()
            }),
          ),
          Effect.forkDetach({ startImmediately: true }),
        )
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = Effect.gen(function* () {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      MutableHashMap.set(pending, pendingKey(session.id), { abort: controller, cleanup })

      const result = yield* Effect.promise(() => WorktreeState.wait(sdk().scope, sessionDirectory)).pipe(
        Effect.raceFirst(worktreeWaitAborted(controller.signal)),
        Effect.timeoutOrElse({
          duration: "5 minutes",
          orElse: () =>
            Effect.succeed<WorktreeWaitResult>({
              status: "failed",
              message: language.t("workspace.error.stillPreparing"),
            }),
        }),
      )
      MutableHashMap.remove(pending, pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") return yield* Effect.fail(new WorktreeWaitError({ message: result.message }))
      return true
    })

    const recover = (err: unknown) => {
      MutableHashMap.remove(pending, pendingKey(session.id))
      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    }

    yield* sendFollowup({
      api: sdk().api.session,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).pipe(
      Effect.mapError(rejection),
      Effect.catchCause((cause) => Effect.sync(() => recover(Cause.squash(cause)))),
      Effect.forkDetach({ startImmediately: true }),
    )
  })

  const handleSubmit = (event: Event) => {
    event.preventDefault()
    return Effect.runPromise(submit().pipe(Effect.mapError(rejection)))
  }

  return {
    abort,
    handleSubmit,
  }
}
