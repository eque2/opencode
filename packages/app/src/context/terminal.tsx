import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createRoot, on, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { HashSet, Iterable, MutableHashMap, Option, Predicate } from "effect"
import { useSDK, type DirectorySDK } from "./sdk"
import type { Platform } from "./platform"
import { useServerSDK } from "./server-sdk"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { defaultTitle, titleNumber } from "./terminal-title"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"

export type LocalPTY = {
  id: string
  title: string
  titleNumber: number
  rows?: number
  cols?: number
  buffer?: string
  scrollY?: number
  cursor?: number
}

type FocusRequest = { request: number; id: Option.Option<string>; pending: boolean }

const WORKSPACE_KEY = "__workspace__"
const MAX_TERMINAL_SESSIONS = 20

function text(value: unknown) {
  return Option.liftPredicate(value, Predicate.isString)
}

function num(value: unknown) {
  return Option.filter(Option.liftPredicate(value, Predicate.isNumber), Number.isFinite)
}

function numberFromTitle(title: string) {
  return titleNumber(title, MAX_TERMINAL_SESSIONS)
}

function pty(value: unknown): Option.Option<LocalPTY> {
  if (!Predicate.isObject(value)) return Option.none()

  const id = Option.filter(text(value.id), (id) => id.length > 0)
  if (Option.isNone(id)) return Option.none()

  const title = Option.getOrElse(text(value.title), () => "")
  const number = Option.filter(num(value.titleNumber), (number) => number > 0)
  const rows = num(value.rows)
  const cols = num(value.cols)
  const buffer = text(value.buffer)
  const scrollY = num(value.scrollY)
  const cursor = num(value.cursor)

  return Option.some({
    id: id.value,
    title,
    titleNumber: Option.getOrElse(number, () => numberFromTitle(title) ?? 0),
    ...(Option.isSome(rows) ? { rows: rows.value } : {}),
    ...(Option.isSome(cols) ? { cols: cols.value } : {}),
    ...(Option.isSome(buffer) ? { buffer: buffer.value } : {}),
    ...(Option.isSome(scrollY) ? { scrollY: scrollY.value } : {}),
    ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
  })
}

export function migrateTerminalState(value: unknown) {
  if (!Predicate.isObject(value)) return value

  let seen = HashSet.empty<string>()
  const all = (Array.isArray(value.all) ? value.all : []).flatMap((item) => {
    const next = pty(item)
    if (Option.isNone(next) || HashSet.has(seen, next.value.id)) return []
    seen = HashSet.add(seen, next.value.id)
    return [next.value]
  })

  const active = Option.filter(text(value.active), (active) => HashSet.has(seen, active))

  return {
    active: Option.getOrElse(active, () => all[0]?.id),
    all,
  }
}

export function getWorkspaceTerminalCacheKey(dir: string, scope: ServerScopeValue = ServerScope.local) {
  return ScopedKey.from(scope, dir, WORKSPACE_KEY)
}

export function getLegacyTerminalStorageKeys(dir: string, legacySessionID?: string) {
  if (!legacySessionID) return [`${dir}/terminal.v1`]
  return [`${dir}/terminal/${legacySessionID}.v1`, `${dir}/terminal.v1`]
}

type TerminalSession = ReturnType<typeof createWorkspaceTerminalSession>

type TerminalCacheEntry = {
  value: TerminalSession
  dispose: VoidFunction
}

type TerminalCache = MutableHashMap.MutableHashMap<ScopedKey, TerminalCacheEntry>

// The registry compares caches by identity. A HashSet compares by structure, so it would treat two empty caches as one.
let caches: ReadonlyArray<TerminalCache> = []

const hasRestoreState = (pty: LocalPTY) => !!pty.buffer || pty.cursor !== undefined || pty.scrollY !== undefined

const trimTerminal = (pty: LocalPTY): LocalPTY => {
  if (!hasRestoreState(pty)) return pty
  const { buffer: _buffer, cursor: _cursor, scrollY: _scrollY, ...rest } = pty
  return rest
}

const dropRestoreState = produce((draft: LocalPTY) => {
  delete draft.buffer
  delete draft.cursor
  delete draft.scrollY
})

function terminalPersistTarget(scope: ServerScopeValue, dir: string, legacy?: string[]) {
  return Persist.serverWorkspace(scope, dir, "terminal", legacy)
}

export function clearWorkspaceTerminals(
  dir: string,
  sessionIDs?: string[],
  platform?: Platform,
  scope: ServerScopeValue = ServerScope.local,
) {
  const key = getWorkspaceTerminalCacheKey(dir, scope)
  for (const cache of caches) {
    const entry = MutableHashMap.get(cache, key)
    if (Option.isSome(entry)) entry.value.value.clear()
  }

  removePersisted(terminalPersistTarget(scope, dir), platform)

  if (scope !== ServerScope.local) return
  const legacy = HashSet.fromIterable([
    ...getLegacyTerminalStorageKeys(dir),
    ...(sessionIDs ?? []).flatMap((id) => getLegacyTerminalStorageKeys(dir, id)),
  ])
  for (const key of legacy) {
    removePersisted({ key }, platform)
  }
}

function createWorkspaceTerminalSession(
  sdk: DirectorySDK,
  dir: string,
  scope: ServerScopeValue,
  legacySessionID?: string,
) {
  const location = { directory: sdk.directory }
  const legacy = scope === ServerScope.local ? getLegacyTerminalStorageKeys(dir, legacySessionID) : []

  const [store, setStore, _, ready] = persisted(
    {
      ...terminalPersistTarget(scope, dir, legacy),
      migrate: migrateTerminalState,
    },
    createStore<{
      active?: string
      all: LocalPTY[]
    }>({
      all: [],
    }),
  )
  const [ui, setUi] = createStore<{ focus: Option.Option<FocusRequest> }>({
    focus: Option.none(),
  })
  const focus = { request: 0 }

  const requestFocus = (id: Option.Option<string>, pending = false) => {
    focus.request += 1
    setUi("focus", Option.some({ request: focus.request, id, pending }))
    return focus.request
  }

  const focusRequested = (id?: string) => {
    if (!id) return false
    if (Option.isNone(ui.focus) || ui.focus.value.pending) return false
    return Option.match(ui.focus.value.id, { onNone: () => true, onSome: (target) => !target || target === id })
  }

  const consumeFocus = (id: string) => {
    if (!focusRequested(id)) return
    setUi("focus", Option.none())
  }

  const cancelFocus = (request?: number) => {
    if (request !== undefined && !(Option.isSome(ui.focus) && ui.focus.value.request === request)) return
    setUi("focus", Option.none())
  }

  if (typeof document !== "undefined") {
    const cancelOnOutsideFocus = (event: FocusEvent) => {
      if (Option.isNone(ui.focus)) return
      if (!(event.target instanceof Element)) return
      if (event.target.closest("#terminal-panel")) return
      cancelFocus()
    }
    document.addEventListener("focusin", cancelOnOutsideFocus)
    onCleanup(() => document.removeEventListener("focusin", cancelOnOutsideFocus))
  }

  const pickNextTerminalNumber = () => {
    const existingTitleNumbers = HashSet.fromIterable(
      store.all.flatMap((pty) => {
        if (Number.isFinite(pty.titleNumber) && pty.titleNumber > 0) return [pty.titleNumber]
        const parsed = numberFromTitle(pty.title)
        if (parsed === undefined) return []
        return [parsed]
      }),
    )

    return (
      Array.from({ length: HashSet.size(existingTitleNumbers) + 1 }, (_, index) => index + 1).find(
        (number) => !HashSet.has(existingTitleNumbers, number),
      ) ?? 1
    )
  }

  const removeExited = (id: string) => {
    const all = store.all
    const index = all.findIndex((x) => x.id === id)
    if (index === -1) return
    const active = store.active === id ? (index === 0 ? all[1]?.id : all[0]?.id) : store.active
    batch(() => {
      setStore("active", active)
      setStore(
        "all",
        produce((draft) => {
          draft.splice(index, 1)
        }),
      )
    })
  }

  const unsub = sdk.event.on("pty.exited", (event: { properties: { id: string } }) => {
    removeExited(event.properties.id)
  })
  onCleanup(unsub)

  const update = (pty: Partial<LocalPTY> & { id: string }) => {
    const index = store.all.findIndex((x) => x.id === pty.id)
    const previous = index >= 0 ? Option.fromNullishOr(store.all[index]) : Option.none<LocalPTY>()
    if (index >= 0) {
      setStore("all", index, (item) => ({ ...item, ...pty }))
    }
    const size = pty.cols && pty.rows ? { size: { rows: pty.rows, cols: pty.cols } } : {}
    const doUpdate = async () => {
      if ((await sdk.protocol) === "v1") {
        await sdk.client.pty.update({ ptyID: pty.id, title: pty.title, ...size })
      } else {
        await sdk.api.pty.update({ ptyID: pty.id, location, title: pty.title, ...size })
      }
    }
    doUpdate().catch((error: unknown) => {
      if (Option.isSome(previous)) {
        const currentIndex = store.all.findIndex((item) => item.id === pty.id)
        if (currentIndex >= 0) setStore("all", currentIndex, previous.value)
      }
      console.error("Failed to update terminal", error)
    })
  }

  const clone = async (id: string) => {
    const index = store.all.findIndex((x) => x.id === id)
    const pty = store.all[index]
    if (!pty) return
    const data = await (async () => {
      if ((await sdk.protocol) === "v1") {
        return (await sdk.client.pty.create({ title: pty.title })).data
      }
      return (
        await sdk.api.pty.create({
          location,
          title: pty.title,
        })
      ).data
    })().catch((error: unknown) => {
      console.error("Failed to clone terminal", error)
      return undefined
    })
    if (!data?.id) return

    const active = store.active === pty.id

    batch(() => {
      setStore(
        "all",
        index,
        produce((draft) => {
          draft.id = data.id
          draft.title = data.title ?? pty.title
          draft.titleNumber = pty.titleNumber
          delete draft.buffer
          delete draft.cursor
          delete draft.scrollY
          delete draft.rows
          delete draft.cols
        }),
      )
      if (active) {
        setStore("active", data.id)
      }
    })
  }

  const trim = (id: string) => {
    const index = store.all.findIndex((x) => x.id === id)
    if (index === -1) return
    setStore("all", index, (pty) => (hasRestoreState(pty) ? dropRestoreState(pty) : pty))
  }

  return {
    ready,
    all: createMemo(() => store.all),
    active: createMemo(() => store.active),
    clear: () => {
      batch(() => {
        setStore(
          produce((draft) => {
            delete draft.active
          }),
        )
        setStore("all", [])
      })
    },
    new: (options?: { focus?: boolean }) => {
      const nextNumber = pickNextTerminalNumber()
      const focusRequest = options?.focus ? Option.some(requestFocus(Option.none(), true)) : Option.none<number>()

      const doCreate = async () => {
        if ((await sdk.protocol) === "v1") {
          return (await sdk.client.pty.create({ title: defaultTitle(nextNumber) })).data
        }
        return (await sdk.api.pty.create({ location, title: defaultTitle(nextNumber) })).data
      }
      doCreate()
        .then((data) => {
          const id = data?.id
          if (!id) {
            if (Option.isSome(focusRequest)) cancelFocus(focusRequest.value)
            return
          }
          const newTerminal = {
            id,
            title: data?.title ?? defaultTitle(nextNumber),
            titleNumber: nextNumber,
          }
          batch(() => {
            setStore("all", store.all.length, newTerminal)
            setStore("active", id)
            if (
              Option.isSome(focusRequest) &&
              Option.isSome(ui.focus) &&
              ui.focus.value.request === focusRequest.value
            ) {
              setUi("focus", Option.some({ request: focusRequest.value, id: Option.some(id), pending: false }))
            }
          })
        })
        .catch((error: unknown) => {
          if (Option.isSome(focusRequest)) cancelFocus(focusRequest.value)
          console.error("Failed to create terminal", error)
        })
    },
    update: (pty: Partial<LocalPTY> & { id: string }) => {
      update(pty)
    },
    trim,
    trimAll: () => {
      setStore("all", (all) => {
        const next = all.map(trimTerminal)
        if (next.every((pty, index) => pty === all[index])) return all
        return next
      })
    },
    clone: async (id: string) => {
      await clone(id)
    },
    bind: () => {
      return {
        trim,
        update: (pty: Partial<LocalPTY> & { id: string }) => {
          update(pty)
        },
        clone: async (id: string) => {
          await clone(id)
        },
      }
    },
    open: (id: string) => {
      setStore("active", id)
    },
    requestFocus: (id?: string) => {
      requestFocus(Option.fromNullishOr(id))
    },
    focusRequested: (id?: string) => {
      return focusRequested(id)
    },
    consumeFocus: (id: string) => {
      consumeFocus(id)
    },
    cancelFocus: () => {
      cancelFocus()
    },
    next: () => {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const nextIndex = (index + 1) % store.all.length
      setStore("active", store.all[nextIndex]?.id)
    },
    previous: () => {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const prevIndex = index === 0 ? store.all.length - 1 : index - 1
      setStore("active", store.all[prevIndex]?.id)
    },
    close: async (id: string) => {
      const index = store.all.findIndex((f) => f.id === id)
      if (index !== -1) {
        batch(() => {
          if (store.active === id) {
            const next = index > 0 ? store.all[index - 1]?.id : store.all[1]?.id
            setStore("active", next)
          }
          setStore(
            "all",
            produce((all) => {
              all.splice(index, 1)
            }),
          )
        })
      }

      const removePromise =
        (await sdk.protocol) === "v1"
          ? sdk.client.pty.remove({ ptyID: id })
          : sdk.api.pty.remove({ ptyID: id, location })
      await removePromise.catch((error: unknown) => {
        console.error("Failed to close terminal", error)
      })
    },
    move: (id: string, to: number) => {
      const index = store.all.findIndex((f) => f.id === id)
      if (index === -1) return
      setStore(
        "all",
        produce((all) => {
          all.splice(to, 0, all.splice(index, 1)[0])
        }),
      )
    },
  }
}

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const serverSDK = useServerSDK()
    const params = useParams()
    // String keys keep insertion order in a MutableHashMap, so the first key is the least recently used.
    const cache: TerminalCache = MutableHashMap.empty()
    const scope = () => serverSDK().scope
    const directory = createMemo(() => base64Encode(sdk().directory))

    caches = [...caches, cache]
    onCleanup(() => {
      caches = caches.filter((item) => item !== cache)
    })

    const disposeAll = () => {
      for (const entry of MutableHashMap.values(cache)) {
        entry.dispose()
      }
      MutableHashMap.clear(cache)
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (MutableHashMap.size(cache) > MAX_TERMINAL_SESSIONS) {
        const first = Iterable.head(MutableHashMap.keys(cache))
        if (Option.isNone(first) || !first.value) return
        const entry = MutableHashMap.get(cache, first.value)
        if (Option.isSome(entry)) entry.value.dispose()
        MutableHashMap.remove(cache, first.value)
      }
    }

    const loadWorkspace = (dir: string, legacySessionID: string | undefined, serverScope: ServerScopeValue) => {
      // Terminals are workspace-scoped so tabs persist while switching sessions in the same directory.
      const key = getWorkspaceTerminalCacheKey(dir, serverScope)
      const existing = MutableHashMap.get(cache, key)
      if (Option.isSome(existing)) {
        MutableHashMap.remove(cache, key)
        MutableHashMap.set(cache, key, existing.value)
        return existing.value.value
      }

      const entry = createRoot((dispose) => ({
        value: createWorkspaceTerminalSession(sdk(), dir, serverScope, legacySessionID),
        dispose,
      }))

      MutableHashMap.set(cache, key, entry)
      prune()
      return entry.value
    }

    const workspace = createMemo(() => loadWorkspace(directory(), params.id, scope()))

    createEffect(
      on(
        () => ({ dir: directory(), id: params.id, scope: scope() }),
        (next, prev) => {
          if (!prev?.dir) return
          if (next.dir === prev.dir && next.id === prev.id && next.scope === prev.scope) return
          if (next.dir === prev.dir && next.id && next.scope === prev.scope) return
          loadWorkspace(prev.dir, prev.id, prev.scope).trimAll()
        },
        { defer: true },
      ),
    )

    return {
      ready: () => workspace().ready(),
      all: () => workspace().all(),
      active: () => workspace().active(),
      new: (options?: { focus?: boolean }) => workspace().new(options),
      update: (pty: Partial<LocalPTY> & { id: string }) => workspace().update(pty),
      trim: (id: string) => workspace().trim(id),
      trimAll: () => workspace().trimAll(),
      clone: (id: string) => workspace().clone(id),
      bind: () => workspace(),
      open: (id: string) => workspace().open(id),
      requestFocus: (id?: string) => workspace().requestFocus(id),
      focusRequested: (id?: string) => workspace().focusRequested(id),
      consumeFocus: (id: string) => workspace().consumeFocus(id),
      cancelFocus: () => workspace().cancelFocus(),
      close: (id: string) => workspace().close(id),
      move: (id: string, to: number) => workspace().move(id, to),
      next: () => workspace().next(),
      previous: () => workspace().previous(),
    }
  },
})
