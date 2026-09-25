import { getFilename } from "@opencode-ai/core/util/path"
import type { Project } from "@opencode-ai/sdk/v2/client"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { HashMap, MutableHashSet, Option } from "effect"
import { createMemo, onCleanup } from "solid-js"
import { commandPaletteOptions, useCommand, type CommandOption } from "@/context/command"
import { useFile } from "@/context/file"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLayout, type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useTabs } from "@/context/tabs"
import { displayName, projectForSession } from "@/pages/layout/helpers"
import { createSessionTabs } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { normalizeSessionInfo } from "@/utils/session"

export type CommandPaletteEntry = {
  id: string
  type: "command" | "file" | "session"
  title: string
  description?: string
  keybind?: string
  category: string
  option?: CommandOption
  path?: string
  directory?: string
  sessionID?: string
  server?: ServerConnection.Key
  project?: LocalProject
  archived?: number
  updated?: number
}

const ENTRY_LIMIT = 5
const COMMON_COMMAND_IDS = [
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.toggle",
  "review.toggle",
] as const
// The position of each common command in the preferred list.
const COMMON_COMMAND_ORDER = HashMap.fromIterable<string, number>(COMMON_COMMAND_IDS.map((id, index) => [id, index]))
const commonCommandRank = (id: string) => Option.getOrElse(HashMap.get(COMMON_COMMAND_ORDER, id), () => 0)

export function uniqueCommandPaletteEntries(items: CommandPaletteEntry[]) {
  const seen = MutableHashSet.empty<string>()
  return items.filter((item) => {
    if (MutableHashSet.has(seen, item.id)) return false
    MutableHashSet.add(seen, item.id)
    return true
  })
}

export function createCommandPaletteFileEntry(path: string, category: string): CommandPaletteEntry {
  return {
    id: "file:" + path,
    type: "file",
    title: path,
    category,
    path,
  }
}

export function createCommandPaletteFileOpener(onOpenFile?: (path: string) => void) {
  const file = useFile()
  const layout = useLayout()
  const { tabs, view } = useSessionLayout()

  return (path: string) => {
    const value = file.tab(path)
    void tabs().open(value)
    void file.load(path)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    onOpenFile?.(path)
    tabs().setActive(value)
  }
}

export function createCommandPaletteModel(props: { filesOnly?: () => boolean; onOpenFile?: (path: string) => void }) {
  const command = useCommand()
  const global = useGlobal()
  const language = useLanguage()
  const file = useFile()
  const dialog = useDialog()
  const serverSDK = useServerSDK()()
  const serverCtx = global.ensureServerCtx(serverSDK.server)
  const appTabs = useTabs()
  const { tabs: sessionTabs } = useSessionLayout()
  const openFile = createCommandPaletteFileOpener(props.onOpenFile)
  // The cleanup of the highlighted command preview, and whether a selection committed the preview.
  const state: { cleanup: Option.Option<() => void>; committed: boolean } = { cleanup: Option.none(), committed: false }
  const filesOnly = () => props.filesOnly?.() ?? false

  const allowedCommands = createMemo(() => {
    if (filesOnly()) return []
    return commandPaletteOptions(command.options)
  })
  const commandEntries = createMemo(() => {
    const category = language.t("palette.group.commands")
    return allowedCommands().map((option) => createCommandPaletteCommandEntry(option, category))
  })
  const preferredCommandEntries = createMemo(() => {
    const all = allowedCommands()
    const picked = all.filter((option) => HashMap.has(COMMON_COMMAND_ORDER, option.id))
    const base = picked.length ? picked : all.slice(0, ENTRY_LIMIT)
    const sorted = picked.length ? [...base].sort((a, b) => commonCommandRank(a.id) - commonCommandRank(b.id)) : base
    const category = language.t("palette.group.commands")
    return sorted.map((option) => createCommandPaletteCommandEntry(option, category))
  })

  const tabState = createSessionTabs({
    tabs: sessionTabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  })
  const recentFileEntries = createMemo(() => {
    const all = tabState.openedTabs()
    const active = tabState.activeFileTab()
    const order = active ? [active, ...all.filter((item) => item !== active)] : all
    const seen = MutableHashSet.empty<string>()
    const category = language.t("palette.group.files")
    return order
      .map((item) => file.pathFromTab(item))
      .filter((path): path is string => {
        if (!path || MutableHashSet.has(seen, path)) return false
        MutableHashSet.add(seen, path)
        return true
      })
      .slice(0, ENTRY_LIMIT)
      .map((path) => createCommandPaletteFileEntry(path, category))
  })
  const rootFileEntries = createMemo(() => {
    const category = language.t("palette.group.files")
    return file.tree
      .children("")
      .filter((node) => node.type === "file")
      .map((node) => node.path)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, ENTRY_LIMIT)
      .map((path) => createCommandPaletteFileEntry(path, category))
  })

  const sessions = createServerSessionEntries({
    server: ServerConnection.key(serverSDK.server),
    opened: serverCtx.projects.list,
    stored: () => serverCtx.sync.data.project,
    load: (search, signal) => serverSDK.api.session.list({ parentID: null, search, limit: 50 }, { signal }),
    untitled: () => language.t("command.session.new"),
    category: () => language.t("command.category.session"),
  })

  const highlight = (item: CommandPaletteEntry | undefined) => {
    if (Option.isSome(state.cleanup)) state.cleanup.value()
    state.cleanup = Option.none()
    state.cleanup = commandPreviewCleanup(item)
  }

  const select = (item: CommandPaletteEntry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = Option.none()
    dialog.close()
    if (item.type === "command") {
      item.option?.onSelect?.("palette")
      return
    }
    if (item.type === "session") {
      if (!item.sessionID || !item.server) return
      const directory = item.project?.worktree ?? item.directory
      if (directory) {
        serverCtx.projects.open(directory)
        serverCtx.projects.touch(directory)
      }
      const tab = appTabs.addSessionTab({
        server: item.server,
        sessionId: item.sessionID,
      })
      appTabs.select(tab)
      return
    }
    if (!item.path) return
    openFile(item.path)
  }

  onCleanup(() => {
    if (state.committed) return
    if (Option.isSome(state.cleanup)) state.cleanup.value()
  })

  return {
    language,
    file,
    commandEntries,
    preferredCommandEntries,
    recentFileEntries,
    rootFileEntries,
    sessions,
    highlight,
    select,
    close: () => dialog.close(),
  }
}

/** Runs the preview of a highlighted command and gives its cleanup, or none for any other entry. */
export function commandPreviewCleanup(item: CommandPaletteEntry | undefined): Option.Option<() => void> {
  if (item?.type !== "command") return Option.none()
  const cleanup = item.option?.onHighlight?.()
  return typeof cleanup === "function" ? Option.some(cleanup) : Option.none()
}

export function createCommandPaletteCommandEntry(option: CommandOption, category: string): CommandPaletteEntry {
  return {
    id: "command:" + option.id,
    type: "command",
    title: option.title,
    description: option.description,
    keybind: option.keybind,
    category,
    option,
  }
}

export function createServerSessionEntries(props: {
  server: ServerConnection.Key
  opened: () => LocalProject[]
  stored: () => Project[]
  load: (search: string, signal: AbortSignal) => Promise<{ data: SessionInfo[] }>
  untitled: () => string
  category: () => string
}) {
  let abort: AbortController | undefined

  onCleanup(() => abort?.abort())

  return async (text: string): Promise<CommandPaletteEntry[]> => {
    const search = text.trim()
    if (!search) {
      abort?.abort()
      return []
    }
    abort?.abort()
    const current = new AbortController()
    abort = current
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100)
      current.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    if (current.signal.aborted) return []
    const opened = props.opened()
    const openedByID = HashMap.fromIterable(
      opened.flatMap((project) => (project.id ? [[project.id, project] as const] : [])),
    )
    const stored = props.stored().map((project) => ({ ...project, expanded: false }))
    const storedByID = HashMap.fromIterable(stored.map((project) => [project.id, project] as const))
    return props
      .load(search, current.signal)
      .then((result) =>
        result.data
          .map(normalizeSessionInfo)
          .filter((session) => !session.time.archived)
          .map((session) => {
            const project =
              projectForSession(session, opened, openedByID) ?? projectForSession(session, stored, storedByID)
            return {
              id: `session:${props.server}:${session.id}`,
              type: "session" as const,
              title: session.title || props.untitled(),
              description: project ? displayName(project) : getFilename(session.directory),
              category: props.category(),
              directory: session.directory,
              sessionID: session.id,
              server: props.server,
              project,
              updated: session.time.updated,
            }
          }),
      )
      .catch(() => [] as CommandPaletteEntry[])
  }
}
