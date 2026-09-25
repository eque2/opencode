import { useNavigate } from "@solidjs/router"
import { Data, Effect, Option, Predicate } from "effect"
import { useCommand, type CommandOption } from "@/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { previewSelectedLines } from "@opencode-ai/session-ui/pierre/selection-bridge"
import { useFile, selectionFromLines, type FileSelection } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePermission } from "@/context/permission"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { showToast } from "@/utils/toast"
import {
  downloadSessionExport,
  fetchSessionExport,
  sessionExportFailureCause,
  sessionExportFilename,
} from "@/utils/session-export"
import { createSessionTabs, readSelectedLineRange } from "@/pages/session/helpers"
import { extractPromptFromParts } from "@/utils/prompt"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useSessionArchive } from "@/pages/session/session-archive"
import { createSessionOwnership } from "./session-ownership"
import { useLocal } from "@/context/local"

export type SessionCommandContext = {
  navigateMessageByOffset: (offset: number) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  focusInput: () => void
  review?: () => boolean
  fileBrowser?: () => boolean
}

class SessionCommandError extends Data.TaggedError("SessionCommandError")<{ readonly cause: unknown }> {}

class SessionExportError extends Data.TaggedError("SessionExportError")<{ readonly cause: unknown }> {}

// Runs a command program from a command handler. The handler does not wait
// for it, so a failure is logged, as the unhandled rejection was before.
const runDetached = <A, E>(program: Effect.Effect<A, E>) => {
  Effect.runFork(program.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const permission = usePermission()
  const prompt = usePrompt()
  const sdk = useSDK()
  const settings = useSettings()
  const sync = useSync()
  const terminal = useTerminal()
  const layout = useLayout()
  const local = useLocal()
  const navigate = useNavigate()
  const { params, sessionKey, tabs, view } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const sessionArchive = useSessionArchive()
  const openDialog = <T,>(load: () => Promise<T>, show: (value: T) => void) => {
    const owner = sessionOwnership.capture()
    runDetached(Effect.map(Effect.promise(load), (value) => owner.run(() => show(value))))
  }
  const runCommand = <T,>(input: {
    owner: ReturnType<ReturnType<typeof createSessionOwnership>["capture"]>
    prompt: T
    request: () => Promise<unknown>
    updatePrompt: (prompt: T) => void
    updateViewport: () => void
  }) =>
    Effect.tryPromise({ try: input.request, catch: (cause) => new SessionCommandError({ cause }) }).pipe(
      Effect.map(() => {
        input.updatePrompt(input.prompt)
        input.owner.run(input.updateViewport)
      }),
    )

  const info = () => {
    const id = params.id
    if (!id) return undefined
    return sync().session.get(id)
  }
  const hasReview = () => !!params.id
  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: actions.review,
    hasReview,
    fileBrowser: actions.fileBrowser,
  })
  const activeFileTab = tabState.activeFileTab
  const closableTab = tabState.closableTab
  const shown = settings.visibility.fileTree

  const messages = () => {
    const id = params.id
    if (!id) return []
    return sync().data.message[id] ?? []
  }
  const userMessages = () => messages().filter((m) => m.role === "user")
  const visibleUserMessages = () => {
    const revert = info()?.revert?.messageID
    if (!revert) return userMessages()
    const boundary = userMessages().findIndex((message) => message.id === revert)
    return boundary < 0 ? userMessages() : userMessages().slice(0, boundary)
  }

  const showAllFiles = () => {
    if (layout.fileTree.tab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const canAddSelectionContext = () => {
    const tab = activeFileTab()
    if (!tab) return false
    const path = file.pathFromTab(tab)
    if (!path) return false
    return Predicate.isNotNullish(file.selectedLines(path))
  }

  const navigateMessageByOffset = actions.navigateMessageByOffset
  const setActiveMessage = actions.setActiveMessage
  const focusInput = actions.focusInput

  const sessionCommand = withCategory(language.t("command.category.session"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const isAutoAcceptActive = () => {
    const sessionID = params.id
    if (sessionID) return permission.isAutoAccepting(sessionID, sdk().directory)
    return permission.isAutoAcceptingDirectory(sdk().directory)
  }
  // Copies through a hidden textarea and execCommand. False when there is no
  // document or the browser refuses the copy.
  const copyWithTextarea = (value: string) => {
    if (typeof document === "undefined") return false
    const body = document.body
    if (!body) return false
    const textarea = document.createElement("textarea")
    textarea.value = value
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    return copied
  }

  const write = (value: string) =>
    Effect.gen(function* () {
      if (copyWithTextarea(value)) return true
      if (typeof navigator === "undefined") return false
      const clipboard = navigator.clipboard
      if (!clipboard?.writeText) return false
      return yield* Effect.tryPromise(() => clipboard.writeText(value)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
    })

  const copyShare = (url: string, existing: boolean) =>
    Effect.gen(function* () {
      if (!(yield* write(url))) {
        showToast({
          title: language.t("toast.session.share.copyFailed.title"),
          variant: "error",
        })
        return
      }

      showToast({
        title: existing ? language.t("session.share.copy.copied") : language.t("toast.session.share.success.title"),
        description: language.t("toast.session.share.success.description"),
        variant: "success",
      })
    })

  const share = Effect.gen(function* () {
    const sessionID = params.id
    if (!sessionID) return

    const existing = info()?.share?.url
    if (existing) {
      yield* copyShare(existing, true)
      return
    }

    const url = yield* Effect.tryPromise(() => sdk().client.session.share({ sessionID })).pipe(
      Effect.map((res) => Option.filter(Option.fromNullishOr(res.data?.share?.url), (value) => value !== "")),
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    if (Option.isNone(url)) {
      showToast({
        title: language.t("toast.session.share.failed.title"),
        description: language.t("toast.session.share.failed.description"),
        variant: "error",
      })
      return
    }

    yield* copyShare(url.value, false)
  })

  const unshare = Effect.gen(function* () {
    const sessionID = params.id
    if (!sessionID) return

    yield* Effect.tryPromise(() => sdk().client.session.unshare({ sessionID })).pipe(
      Effect.match({
        onSuccess: () =>
          showToast({
            title: language.t("toast.session.unshare.success.title"),
            description: language.t("toast.session.unshare.success.description"),
            variant: "success",
          }),
        onFailure: () =>
          showToast({
            title: language.t("toast.session.unshare.failed.title"),
            description: language.t("toast.session.unshare.failed.description"),
            variant: "error",
          }),
      }),
    )
  })

  const exportSession = Effect.gen(function* () {
    const sessionID = params.id
    if (!sessionID) return
    const data = yield* fetchSessionExport({
      sessionID,
      client: sdk().client,
    }).pipe(Effect.mapError((error) => new SessionExportError({ cause: sessionExportFailureCause(error) })))
    yield* Effect.try({
      try: () => {
        const filename = sessionExportFilename(data.info)
        downloadSessionExport(filename, data)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("toast.session.export.success.title"),
          description: language.t("toast.session.export.success.description", { filename }),
        })
      },
      catch: (cause) => new SessionExportError({ cause }),
    })
  }).pipe(
    Effect.catchTag("SessionExportError", (error) =>
      Effect.sync(() =>
        showToast({
          variant: "error",
          title: language.t("toast.session.export.failed.title"),
          description:
            error.cause instanceof Error ? error.cause.message : language.t("toast.session.export.failed.description"),
        }),
      ),
    ),
  )

  const openFile = () => {
    openDialog(
      () => import("@/components/dialog-select-file"),
      (x) => dialog.show(() => <x.DialogSelectFile onOpenFile={showAllFiles} />),
    )
  }

  const closeTab = () => {
    const tab = closableTab()
    if (!tab) return
    tabs().close(tab)
  }

  const addSelection = () => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (!path) return

    const range = readSelectedLineRange(file.selectedLines(path))
    if (Option.isNone(range)) {
      showToast({
        title: language.t("toast.context.noLineSelection.title"),
        description: language.t("toast.context.noLineSelection.description"),
      })
      return
    }

    addSelectionToContext(path, selectionFromLines(range.value))
  }

  const openTerminal = () => {
    if (terminal.all().length > 0) terminal.new({ focus: true })
    if (terminal.all().length === 0) terminal.requestFocus()
    view().terminal.open()
  }

  const closeTerminal = () => {
    const id = terminal.active()
    if (!id) return
    const last = terminal.all().length === 1
    void terminal.close(id)
    if (last) view().terminal.close()
  }

  const chooseMcp = () => {
    openDialog(
      () => import("@/components/dialog-select-mcp"),
      (x) => dialog.show(() => <x.DialogSelectMcp />),
    )
  }

  const toggleAutoAccept = () => {
    const sessionID = params.id
    if (sessionID) permission.toggleAutoAccept(sessionID, sdk().directory)
    else permission.toggleAutoAcceptDirectory(sdk().directory)

    const active = sessionID
      ? permission.isAutoAccepting(sessionID, sdk().directory)
      : permission.isAutoAcceptingDirectory(sdk().directory)
    showToast({
      title: active
        ? language.t("toast.permissions.autoaccept.on.title")
        : language.t("toast.permissions.autoaccept.off.title"),
      description: active
        ? language.t("toast.permissions.autoaccept.on.description")
        : language.t("toast.permissions.autoaccept.off.description"),
    })
  }

  const undo = Effect.gen(function* () {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const session = sdk().api.session
    const directory = sdk().directory
    const promptSession = prompt.capture()
    const revert = info()?.revert?.messageID
    const messages = userMessages()
    const boundary = revert ? messages.findIndex((message) => message.id === revert) : messages.length
    if (boundary < 0) return
    const message = messages[boundary - 1]
    if (!message) return
    const parts = sync().data.part[message.id]

    if (sync().data.session_working(sessionID)) {
      yield* Effect.ignore(Effect.tryPromise(() => session.interrupt({ sessionID })))
    }

    yield* runCommand({
      owner,
      prompt: promptSession,
      request: () => session.revert.stage({ sessionID, messageID: message.id }),
      updatePrompt: (promptSession) => {
        if (parts) promptSession.set(extractPromptFromParts(parts, { directory }))
      },
      updateViewport: () => setActiveMessage(messages[boundary - 2]),
    })
  })

  const redo = Effect.gen(function* () {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const session = sdk().api.session
    const messages = userMessages()
    const promptSession = prompt.capture()

    const revertMessageID = info()?.revert?.messageID
    if (!revertMessageID) return

    const boundary = messages.findIndex((message) => message.id === revertMessageID)
    if (boundary < 0) return
    const next = messages[boundary + 1]
    if (!next) {
      yield* runCommand({
        owner,
        prompt: promptSession,
        request: () => session.revert.clear({ sessionID }),
        updatePrompt: (promptSession) => promptSession.reset(),
        updateViewport: () => setActiveMessage(messages.at(-1)),
      })
      return
    }

    yield* runCommand({
      owner,
      prompt: promptSession,
      request: () => session.revert.stage({ sessionID, messageID: next.id }),
      // Redo keeps the prompt that the user has now.
      updatePrompt: () => {},
      updateViewport: () => setActiveMessage(messages[boundary]),
    })
  })

  const compact = Effect.gen(function* () {
    const sessionID = params.id
    if (!sessionID) return

    const model = local.model.current()
    if (!model) {
      showToast({
        title: language.t("toast.model.none.title"),
        description: language.t("toast.model.none.description"),
      })
      return
    }

    yield* Effect.tryPromise({
      try: () =>
        sdk().api.session.compact({
          sessionID,
          model: { providerID: model.provider.id, modelID: model.id },
        }),
      catch: (cause) => new SessionCommandError({ cause }),
    })
  })

  const fork = () => {
    openDialog(
      () => import("@/components/dialog-fork"),
      (x) => dialog.show(() => <x.DialogFork />),
    )
  }

  const shareCmds = () => {
    if (sync().data.config.share === "disabled") return []
    return [
      sessionCommand({
        id: "session.share",
        title: info()?.share?.url ? language.t("session.share.copy.copyLink") : language.t("command.session.share"),
        description: info()?.share?.url
          ? language.t("toast.session.share.success.description")
          : language.t("command.session.share.description"),
        slash: "share",
        disabled: !params.id,
        onSelect: () => runDetached(share),
      }),
      sessionCommand({
        id: "session.unshare",
        title: language.t("command.session.unshare"),
        description: language.t("command.session.unshare.description"),
        slash: "unshare",
        disabled: !params.id || !info()?.share?.url,
        onSelect: () => runDetached(unshare),
      }),
    ]
  }

  const sessionCmds = () => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: (source) => {
        if (settings.general.newLayoutDesigns()) {
          command.trigger("tab.new", source)
          return
        }
        navigate(`/${params.dir}/session`)
      },
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: () => runDetached(undo),
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      disabled: !params.id || !info()?.revert?.messageID,
      onSelect: () => runDetached(redo),
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: () => runDetached(compact),
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: fork,
    }),
    sessionCommand({
      id: "session.export",
      title: language.t("command.session.export"),
      description: language.t("command.session.export.description"),
      slash: "export",
      disabled: !params.id,
      onSelect: () => runDetached(exportSession),
    }),
    sessionCommand({
      id: "session.archive",
      title: language.t("command.session.archive"),
      keybind: "mod+shift+backspace",
      disabled: !params.id,
      onSelect: () => {
        const id = params.id
        if (id) runDetached(sessionArchive.archive(id))
      },
    }),
  ]

  const fileCmds = () => {
    const tab = closableTab()
    return [
      fileCommand({
        id: "file.open",
        title: language.t("command.file.open"),
        description: language.t("palette.search.placeholder"),
        keybind: "mod+p",
        slash: "open",
        onSelect: openFile,
      }),
      tab &&
        fileCommand({
          id: "tab.close",
          title: language.t("command.tab.close"),
          keybind: "mod+w",
          onSelect: closeTab,
        }),
    ].filter((v) => !!v)
  }

  const contextCmds = () => [
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      keybind: "mod+shift+l",
      disabled: !canAddSelectionContext(),
      onSelect: addSelection,
    }),
  ]

  const viewCmds = () => [
    viewCommand({
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      keybind: "ctrl+`",
      slash: "terminal",
      onSelect: () => {
        if (view().terminal.opened()) {
          terminal.cancelFocus()
          view().terminal.close()
          return
        }
        terminal.requestFocus(terminal.active())
        view().terminal.open()
      },
    }),
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      keybind: "mod+shift+r",
      onSelect: () => view().reviewPanel.toggle(),
    }),
    ...(shown()
      ? [
          viewCommand({
            id: "fileTree.toggle",
            title: language.t("command.fileTree.toggle"),
            keybind: "mod+\\",
            onSelect: () => layout.fileTree.toggle(),
          }),
        ]
      : []),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: focusInput,
    }),
  ]

  const terminalCmds = () => [
    terminalCommand({
      id: "terminal.close",
      title: language.t("terminal.close"),
      keybind: "mod+w",
      hidden: true,
      when: (event) => event.target instanceof Element && !!event.target.closest('[data-component="terminal"]'),
      onSelect: closeTerminal,
    }),
    terminalCommand({
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      keybind: "ctrl+alt+t",
      onSelect: openTerminal,
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(1),
    }),
  ]

  const mcpCmds = () => [
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: chooseMcp,
    }),
  ]

  const permissionsCmds = () => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: isAutoAcceptActive()
        ? language.t("command.permissions.autoaccept.disable")
        : language.t("command.permissions.autoaccept.enable"),
      keybind: "mod+shift+a",
      disabled: false,
      onSelect: toggleAutoAccept,
    }),
  ]

  command.register("session", () => [
    ...sessionCmds(),
    ...shareCmds(),
    ...fileCmds(),
    ...contextCmds(),
    ...viewCmds(),
    ...terminalCmds(),
    ...messageCmds(),
    ...mcpCmds(),
    ...permissionsCmds(),
  ])
}
