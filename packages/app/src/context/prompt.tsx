import { base64Encode } from "@opencode-ai/core/util/encode"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useParams, useSearchParams } from "@solidjs/router"
import { Array as Arr, MutableHashMap, Option } from "effect"
import { createMemo, createResource, createRoot, getOwner, onCleanup } from "solid-js"
import { requireServerKey } from "@/utils/session-route"
import { ServerConnection } from "./server"
import { useServerSDK } from "./server-sdk"
import { useSettings } from "./settings"
import { useSDK } from "./sdk"
import { useTabs, type Tab } from "./tabs"
import {
  createPromptReady,
  createPromptSession,
  type ContextItem,
  type FileContextItem,
  type Prompt,
  type PromptModel,
  type PromptScope,
  type PromptSession,
} from "./prompt-state"

export {
  createPromptReady,
  createPromptSession,
  createPromptState,
  DEFAULT_PROMPT,
  isCommentItem,
  isPromptEqual,
} from "./prompt-state"
export type {
  AgentPart,
  ContentPart,
  ContextItem,
  FileAttachmentPart,
  FileContextItem,
  ImageAttachmentPart,
  Prompt,
  PromptModel,
  PromptStore,
  PromptScope,
  PromptSession,
  TextPart,
} from "./prompt-state"

const WORKSPACE_KEY = "__workspace__"
const MAX_PROMPT_SESSIONS = 20

export function selectPromptTab(tabs: Tab[], scope: PromptScope, server: ServerConnection.Key) {
  if ("draftID" in scope) return tabs.find((tab) => tab.type === "draft" && tab.draftID === scope.draftID)
  if (!scope.id) return undefined
  return (
    tabs.find((tab) => tab.type === "session" && tab.server === server && tab.sessionId === scope.id) ??
    ({ type: "session", server, sessionId: scope.id } satisfies Tab)
  )
}

function scopeKey(scope: PromptScope) {
  if ("draftID" in scope) return `draft:${scope.draftID}`
  return `${scope.dir}:${scope.id ?? WORKSPACE_KEY}`
}

type PromptCacheEntry = {
  value: PromptSession
  dispose: VoidFunction
}

export const createTabPromptState = (
  tabs: ReturnType<typeof useTabs>,
  tab: Tab,
  ...args: Parameters<typeof createPromptSession>
) => tabs.state(tab, "prompt", () => createPromptSession(...args))

export const { use: usePrompt, provider: PromptProvider } = createSimpleContext({
  name: "Prompt",
  gate: false,
  init: () => {
    const params = useParams<{ serverKey?: string; id?: string }>()
    const sdk = useSDK()
    const [search] = useSearchParams<{ draftId?: string }>()
    const serverSDK = useServerSDK()
    const tabs = useTabs()
    const settings = useSettings()
    // String keys keep insertion order, so the first key is the least recently used session.
    const cache = MutableHashMap.empty<string, PromptCacheEntry>()

    const disposeAll = () => {
      for (const entry of MutableHashMap.values(cache)) entry.dispose()
      MutableHashMap.clear(cache)
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (MutableHashMap.size(cache) > MAX_PROMPT_SESSIONS) {
        const first = Arr.head(Arr.fromIterable(MutableHashMap.keys(cache)))
        if (Option.isNone(first)) return
        const entry = MutableHashMap.get(cache, first.value)
        if (Option.isSome(entry)) entry.value.dispose()
        MutableHashMap.remove(cache, first.value)
      }
    }

    const owner = getOwner()
    const serverKey = () =>
      params.serverKey ? requireServerKey(params.serverKey) : ServerConnection.key(serverSDK().server)
    const scope = (): PromptScope =>
      search.draftId ? { draftID: search.draftId } : { dir: base64Encode(sdk().directory), id: params.id }
    const load = (scope: PromptScope) => {
      const current = settings.general.newLayoutDesigns() ? selectPromptTab(tabs.store, scope, serverKey()) : undefined
      if (current) return createTabPromptState(tabs, current, serverSDK().scope, scope)

      const key = scopeKey(scope)
      const existing = MutableHashMap.get(cache, key)
      if (Option.isSome(existing)) {
        MutableHashMap.remove(cache, key)
        MutableHashMap.set(cache, key, existing.value)
        return existing.value.value
      }

      const entry = createRoot(
        (dispose) => ({
          value: createPromptSession(serverSDK().scope, scope),
          dispose,
        }),
        owner,
      )

      MutableHashMap.set(cache, key, entry)
      prune()
      return entry.value
    }

    const session = createMemo(() => load(scope()))
    const pick = (scope?: PromptScope) => (scope ? load(scope) : session())
    const ready = createPromptReady(session)

    const withSuspense = <T,>(cb: () => T): (() => T) =>
      createResource(
        async () => {
          const value = cb()
          await session().ready.promise
          return value
        },
        cb,
        { initialValue: cb() },
      )[0]

    return {
      ready,
      capture: (scope?: PromptScope) => pick(scope).capture(),
      current: withSuspense(() => session().current()),
      cursor: withSuspense(() => session().cursor()),
      dirty: withSuspense(() => session().dirty()),
      model: {
        current: withSuspense(() => session().model.current()),
        set: (model: PromptModel | undefined) => session().model.set(model),
      },
      context: {
        items: withSuspense(() => session().context.items()),
        add: (item: ContextItem) => session().context.add(item),
        remove: (key: string) => session().context.remove(key),
        removeComment: (path: string, commentID: string) => session().context.removeComment(path, commentID),
        updateComment: (path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) =>
          session().context.updateComment(path, commentID, next),
        replaceComments: (items: FileContextItem[]) => session().context.replaceComments(items),
      },
      set: (prompt: Prompt, cursorPosition?: number, scope?: PromptScope) => pick(scope).set(prompt, cursorPosition),
      reset: (scope?: PromptScope) => pick(scope).reset(),
    }
  },
})
