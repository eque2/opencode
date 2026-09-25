import { Array as Arr, Data, DateTime, Effect, HashSet, MutableHashMap, Option, Predicate, Result } from "effect"
import { createEffect, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import type { ServerSDK } from "@/context/server-sdk"
import type { ServerSync } from "./server-sync"
import { useParams, useSearchParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, useTabs } from "./tabs"
import { useSettings } from "./settings"
import { requireServerKey } from "@/utils/session-route"
import type { ServerScope } from "@/utils/server-scope"
import { normalizePermissionRequest } from "./global-sync/utils"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  autoRespondsPermission,
  sessionAutoAccept,
} from "./permission-auto-respond"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (!Predicate.isObject(permission)) return false

  return Object.values(permission).some(isNonAllowRule)
}

/** No connected server has the key that the permission state asked for. */
class PermissionServerNotFoundError extends Data.TaggedError("App.PermissionServerNotFoundError")<{
  readonly message: string
}> {}

/** A permission list request that rejected. `cause` is the original rejection. */
class PermissionRequestError extends Data.TaggedError("App.PermissionRequestError")<{ readonly cause: unknown }> {}

const permissionRequest = <A,>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new PermissionRequestError({ cause }) })

/**
 * Runs permission work in the background. A failure or defect goes to the
 * Effect logger, as an unhandled rejection went to the console before.
 */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const params = useParams<{ serverKey?: string; dir?: string; id?: string }>()
    const [search] = useSearchParams<{ draftId?: string }>()
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const settings = useSettings()
    const owner = Option.fromNullishOr(getOwner())
    const states = MutableHashMap.empty<
      ServerScope,
      { key: ServerConnection.Key; dispose: () => void; state: PermissionState }
    >()

    const activeDraft = createMemo(() => {
      if (!search.draftId) return undefined
      return tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)
    })

    const activeServer = createMemo(() => {
      if (params.serverKey && settings.general.newLayoutDesigns()) return requireServerKey(params.serverKey)
      return activeDraft()?.server ?? server.key
    })

    const ensure = (key: ServerConnection.Key) => {
      const conn = Option.getOrThrowWith(
        Arr.findFirst(global.servers.list(), (item) => ServerConnection.key(item) === key),
        () => new PermissionServerNotFoundError({ message: `Permission server not found: ${key}` }),
      )
      const ctx = global.ensureServerCtx(conn)
      const existing = MutableHashMap.get(states, ctx.sdk.scope)
      if (
        Option.isSome(existing) &&
        global.servers.list().some((item) => ServerConnection.key(item) === existing.value.key)
      ) {
        return existing.value.state
      }
      if (Option.isSome(existing)) {
        existing.value.dispose()
        MutableHashMap.remove(states, ctx.sdk.scope)
      }
      const build = (dispose: () => void) => ({
        key,
        dispose,
        state: createServerPermissionState({ sdk: ctx.sdk, sync: ctx.sync }),
      })
      // With no owner at init, createRoot takes the owner that is current at this call.
      const root = Option.match(owner, {
        onSome: (value) => createRoot(build, value),
        onNone: () => createRoot(build),
      })
      MutableHashMap.set(states, ctx.sdk.scope, root)
      return root.state
    }

    createEffect(() => {
      global.servers.list().forEach((conn) => ensure(ServerConnection.key(conn)))
    })

    createEffect(() => {
      const list = global.servers.list()
      const keys = HashSet.fromIterable(list.map(ServerConnection.key))
      MutableHashMap.forEach(states, (value, scope) => {
        if (HashSet.has(keys, value.key)) return
        value.dispose()
        MutableHashMap.remove(states, scope)
        const replacement = list.find((conn) => server.scope(ServerConnection.key(conn)) === scope)
        if (replacement) ensure(ServerConnection.key(replacement))
      })
    })

    onCleanup(() => MutableHashMap.forEach(states, (value) => value.dispose()))

    let lastSelected: PermissionState | undefined
    const selected = () => {
      const key = activeServer()
      if (global.servers.list().some((conn) => ServerConnection.key(conn) === key)) {
        lastSelected = ensure(key)
      }
      if (lastSelected) return lastSelected
      return ensure(server.key)
    }
    const activeDirectory = createMemo(() => {
      const directory = decode64(params.dir)
      if (directory) return directory
      const draft = activeDraft()
      if (draft) return draft.directory
      if (!params.id) return undefined
      if (!global.servers.list().some((conn) => ServerConnection.key(conn) === activeServer())) return undefined
      // A parent cycle throws to the ErrorBoundary, as a thrown lineage read did before.
      const lineage = Result.getOrThrow(selected().sync.session.lineage.find(params.id))
      return Option.getOrUndefined(Option.map(lineage, (value) => value.session.directory))
    })

    createEffect(() => {
      const directory = activeDirectory()
      if (!directory) return
      selected().enableConfiguredDirectory(directory)
    })

    const permissionsEnabled = createMemo(() => {
      const directory = activeDirectory()
      if (!directory) return false
      return selected().permissionsEnabled(directory)
    })

    return {
      ready: () => selected().ready(),
      ensureServerState: (key: ServerConnection.Key) => ensure(key).api,
      currentServerState: () => selected().api,
      respond(input: Parameters<PermissionRespondFn>[0]) {
        selected().respond(input)
      },
      autoResponds(permission: PermissionRequest, directory?: string) {
        return selected().autoResponds(permission, directory)
      },
      isAutoAccepting(sessionID: string, directory?: string) {
        return selected().isAutoAccepting(sessionID, directory)
      },
      isAutoAcceptingDirectory(directory: string) {
        return selected().isAutoAcceptingDirectory(directory)
      },
      toggleAutoAccept(sessionID: string, directory: string) {
        selected().toggleAutoAccept(sessionID, directory)
      },
      toggleAutoAcceptDirectory(directory: string) {
        selected().toggleAutoAcceptDirectory(directory)
      },
      enableAutoAccept(sessionID: string, directory: string) {
        selected().enableAutoAccept(sessionID, directory)
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        selected().disableAutoAccept(sessionID, directory)
      },
      permissionsEnabled,
      isPermissionAllowAll(directory: string) {
        return selected().isPermissionAllowAll(directory)
      },
    }
  },
})

type PermissionState = ReturnType<typeof createServerPermissionState>
type PermissionEvent = Parameters<Parameters<ServerSDK["event"]["listen"]>[0]>[0]

function createServerPermissionState(input: { sdk: ServerSDK; sync: ServerSync }) {
  const [store, setStore, _, ready] = persisted(
    {
      ...Persist.serverGlobal(input.sdk.scope, "permission", ["permission.v3"]),
      migrate(value) {
        if (!Predicate.isObject(value)) return value
        if (value.autoAccept) return value

        return {
          ...value,
          autoAccept: Predicate.isObject(value.autoAcceptEdits) ? value.autoAcceptEdits : {},
        }
      },
    },
    createStore({
      autoAccept: {} as Record<string, boolean>,
    }),
  )

  function enableConfiguredDirectory(directory: string) {
    if (input.sdk.protocolKind() !== "v1") return
    if (meta.disposed || !ready()) return
    const [childStore] = input.sync.child(directory)
    if (childStore.config.permission !== "allow") return
    const key = directoryAcceptKey(directory)
    if (store.autoAccept[key] !== undefined) return
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
      }),
    )
  }

  const MAX_RESPONDED = 1000
  const RESPONDED_TTL_MS = 60 * 60 * 1000
  // Insertion order holds for string keys, so the first entries are the oldest responses.
  const responded = MutableHashMap.empty<string, number>()
  const enableVersion = MutableHashMap.empty<string, number>()
  const meta = { disposed: false }

  function pruneResponded(now: number) {
    for (const [id, ts] of responded) {
      if (now - ts < RESPONDED_TTL_MS) break
      MutableHashMap.remove(responded, id)
    }

    for (const id of MutableHashMap.keys(responded)) {
      if (MutableHashMap.size(responded) <= MAX_RESPONDED) break
      MutableHashMap.remove(responded, id)
    }
  }

  const respond: PermissionRespondFn = (request) => {
    if (meta.disposed) return
    input.sdk.api.permission
      .reply({
        sessionID: request.sessionID,
        requestID: request.permissionID,
        reply: request.response,
        ...(request.directory ? { location: { directory: request.directory } } : {}),
      })
      .catch(() => {
        MutableHashMap.remove(responded, request.permissionID)
      })
  }

  const list = (directory: string) =>
    Effect.gen(function* () {
      if ((yield* Effect.promise(() => input.sdk.protocol)) === "v1") {
        const result = yield* permissionRequest(() => input.sdk.client.permission.list({ directory }))
        return result.data ?? []
      }
      const result = yield* permissionRequest(() => input.sdk.api.permission.request.list({ location: { directory } }))
      return result.data.map(normalizePermissionRequest)
    })

  function respondOnce(permission: PermissionRequest, directory?: string) {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
    const hit = MutableHashMap.has(responded, permission.id)
    MutableHashMap.remove(responded, permission.id)
    MutableHashMap.set(responded, permission.id, now)
    pruneResponded(now)
    if (hit) return
    respond({
      sessionID: permission.sessionID,
      permissionID: permission.id,
      response: "once",
      directory,
    })
  }

  function sessions(directory?: string) {
    const info = Object.values(input.sync.session.data.info).filter((session) => !!session)
    if (!directory) return info
    return [...info, ...input.sync.child(directory, { bootstrap: false })[0].session]
  }

  function isAutoAccepting(sessionID: string, directory?: string) {
    return autoRespondsPermission(store.autoAccept, sessions(directory), { sessionID }, directory)
  }

  function isAutoAcceptingDirectory(directory: string) {
    return isDirectoryAutoAccepting(store.autoAccept, directory)
  }

  function shouldAutoRespond(permission: PermissionRequest, directory?: string) {
    return autoRespondsPermission(store.autoAccept, sessions(directory), permission, directory)
  }

  function isPending(permission: PermissionRequest) {
    const pending = input.sync.session.data.permission[permission.sessionID]
    return pending === undefined || pending.some((item) => item.id === permission.id)
  }

  // A parent cycle in the cached lineage fails this check, so the permission stays for a manual reply.
  const shouldAutoRespondResolved = (permission: PermissionRequest, directory?: string) =>
    Effect.gen(function* () {
      const override = sessionAutoAccept(store.autoAccept, sessions(directory), permission, directory)
      if (override !== undefined) return override
      const cached = yield* Effect.fromResult(input.sync.session.lineage.find(permission.sessionID))
      if (Option.isSome(cached)) return shouldAutoRespond(permission, directory)
      // A lineage that does not resolve means no auto-reply.
      const resolved = yield* Effect.tryPromise(() => input.sync.session.lineage.resolve(permission.sessionID)).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      )
      if (meta.disposed || !resolved) return false
      return shouldAutoRespond(permission, directory)
    })

  const respondPending = (permission: PermissionRequest, directory?: string, current: () => boolean = () => true) =>
    Effect.gen(function* () {
      if (!current() || !isPending(permission)) return
      if (!(yield* shouldAutoRespondResolved(permission, directory))) return
      if (meta.disposed || !current() || !isPending(permission)) return
      respondOnce(permission, directory)
    })

  function bumpEnableVersion(sessionID: string, directory?: string) {
    const key = acceptKey(sessionID, directory)
    const next = Option.getOrElse(MutableHashMap.get(enableVersion, key), () => 0) + 1
    MutableHashMap.set(enableVersion, key, next)
    return next
  }

  const isEnableVersion = (key: string, version: number) =>
    Option.contains(MutableHashMap.get(enableVersion, key), version)

  const handlePermission = (e: PermissionEvent) => {
    const event = e.details
    if (event?.type !== "permission.asked") return
    runDetached(respondPending(event.properties, e.name))
  }

  const unsubscribe = input.sdk.event.listen((event) => {
    if (ready()) {
      handlePermission(event)
      return
    }
    void ready.promise?.then(() => {
      if (meta.disposed) return
      handlePermission(event)
    })
  })
  onCleanup(() => {
    meta.disposed = true
    unsubscribe()
  })

  function enableDirectory(directory: string) {
    if (meta.disposed) return
    const key = directoryAcceptKey(directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
      }),
    )

    // A failed list leaves the pending permissions for a manual reply, as before.
    runDetached(
      list(directory).pipe(
        Effect.match({
          onFailure: () => {},
          onSuccess: (permissions) => {
            if (meta.disposed) return
            if (!isAutoAcceptingDirectory(directory)) return
            for (const permission of permissions) {
              runDetached(respondPending(permission, directory, () => isAutoAcceptingDirectory(directory)))
            }
          },
        }),
      ),
    )
  }

  function disableDirectory(directory: string) {
    if (meta.disposed) return
    const key = directoryAcceptKey(directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = false
      }),
    )
  }

  function enable(sessionID: string, directory: string) {
    if (meta.disposed) return
    const key = acceptKey(sessionID, directory)
    const version = bumpEnableVersion(sessionID, directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
        delete draft.autoAccept[sessionID]
      }),
    )

    // A failed list leaves the pending permissions for a manual reply, as before.
    runDetached(
      list(directory).pipe(
        Effect.match({
          onFailure: () => {},
          onSuccess: (permissions) => {
            if (meta.disposed) return
            if (!isEnableVersion(key, version)) return
            if (!isAutoAccepting(sessionID, directory)) return
            for (const permission of permissions) {
              runDetached(
                respondPending(
                  permission,
                  directory,
                  () => isEnableVersion(key, version) && isAutoAccepting(sessionID, directory),
                ),
              )
            }
          },
        }),
      ),
    )
  }

  function disable(sessionID: string, directory?: string) {
    if (meta.disposed) return
    bumpEnableVersion(sessionID, directory)
    const key = directory ? acceptKey(sessionID, directory) : sessionID
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = false
        if (!directory) return
        delete draft.autoAccept[sessionID]
      }),
    )
  }

  const api = {
    ready: () => !meta.disposed && ready(),
    respond,
    autoResponds(permission: PermissionRequest, directory?: string) {
      if (meta.disposed) return false
      return shouldAutoRespond(permission, directory)
    },
    isAutoAccepting(sessionID: string, directory?: string) {
      if (meta.disposed) return false
      return isAutoAccepting(sessionID, directory)
    },
    isAutoAcceptingDirectory(directory: string) {
      if (meta.disposed) return false
      return isAutoAcceptingDirectory(directory)
    },
    toggleAutoAccept(sessionID: string, directory: string) {
      if (meta.disposed) return
      if (isAutoAccepting(sessionID, directory)) {
        disable(sessionID, directory)
        return
      }

      enable(sessionID, directory)
    },
    toggleAutoAcceptDirectory(directory: string) {
      if (meta.disposed) return
      if (isAutoAcceptingDirectory(directory)) {
        disableDirectory(directory)
        return
      }
      enableDirectory(directory)
    },
    enableAutoAccept(sessionID: string, directory: string) {
      if (meta.disposed) return
      if (isAutoAccepting(sessionID, directory)) return
      enable(sessionID, directory)
    },
    disableAutoAccept(sessionID: string, directory?: string) {
      if (meta.disposed) return
      disable(sessionID, directory)
    },
    isPermissionAllowAll(directory: string) {
      if (meta.disposed) return false
      const [childStore] = input.sync.child(directory)
      return childStore.config.permission === "allow"
    },
  }

  return {
    ...api,
    api,
    sync: input.sync,
    enableConfiguredDirectory,
    permissionsEnabled(directory: string) {
      if (meta.disposed) return false
      const [childStore] = input.sync.child(directory)
      return hasPermissionPromptRules(childStore.config.permission)
    },
  }
}
