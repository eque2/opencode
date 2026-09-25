import { createEffect, createMemo, createResource, createRoot, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { DraftTabItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useTabs } from "@/context/tabs"
import { createTabPromptState } from "@/context/prompt"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { showToast } from "@/utils/toast"
import { canStartTabDrag, isTabCloseTarget } from "./titlebar-tab-gesture"
import { adjacentTabKey, mergeVisibleTabOrder } from "./titlebar-tab-order"
import type { Session } from "@opencode-ai/sdk/v2"
import { Data, Effect, Equivalence, Option } from "effect"

/** A session rename request that rejected. `cause` is the original rejection. */
class TabRenameError extends Data.TaggedError("App.TabRenameError")<{ readonly cause: unknown }> {}

/** A session prefetch for a tab that threw or rejected. `cause` is the original error. */
class TabPrefetchError extends Data.TaggedError("App.TabPrefetchError")<{ readonly cause: unknown }> {}

/** A session lookup for a tab that rejected. `cause` is the original rejection. */
class TabSessionError extends Data.TaggedError("App.TabSessionError")<{ readonly cause: unknown }> {}

/** Compares two Options by the identity of their values, as a memo compares plain values. */
const sameOption = Option.makeEquivalence(Equivalence.strictEqual<unknown>())

/** Runs tab strip work in the background. A defect goes to the Effect logger. */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  session: () => Option.Option<Session>
  fallbackTitle: Option.Option<string>
  onRename: (title: string) => Promise<void>
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
    >
      <TabNavItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        server={props.tab.server}
        session={props.session}
        fallbackTitle={props.fallbackTitle}
        onRename={props.onRename}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        forceTruncate={props.forceTruncate}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

function SessionTabEntry(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  serverCtx: () => ServerCtx | undefined
  onVisibleChange: (visible: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sdk = createMemo(() => props.serverCtx()?.sdk)
  const cachedSession = createMemo(() => props.serverCtx()?.sync.session.peek(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])
  const [loadedSession] = createResource(
    () => {
      const ctx = props.serverCtx()
      if (!ctx) return undefined
      return { id: props.tab.sessionId, ctx }
    },
    // A lookup that fails reads as no session, as the `.catch` did before.
    ({ id, ctx }) =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () => ctx.sync.session.resolve(id),
          catch: (cause) => new TabSessionError({ cause }),
        }).pipe(
          Effect.map((value) => Option.fromNullishOr(value)),
          Effect.catch(() => Effect.succeed(Option.none())),
        ),
      ),
  )
  const session = createMemo(
    () => Option.orElse(Option.fromNullishOr(cachedSession()), () => loadedSession() ?? Option.none()),
    Option.none(),
    { equals: sameOption },
  )
  const missingSession = createMemo(() => !!props.serverCtx() && !loadedSession.loading && Option.isNone(session()))
  const visible = createMemo(() => Option.isSome(session()) || missingSession() || !!persisted()?.title)
  // The remembered title, else the unknown-session label once the lookup found nothing.
  const fallbackTitle = () =>
    Option.orElse(Option.fromNullishOr(persisted()?.title), () =>
      missingSession() ? Option.some(language.t("session.tab.unknown")) : Option.none(),
    )
  let prefetched = false

  // Shows the new title at once. A failed request restores the old title and shows a toast, so the Promise never rejects.
  const rename = (title: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const value = session()
        const ctx = props.serverCtx()
        if (Option.isNone(value) || !ctx) return
        const info = value.value

        ctx.sync.session.remember({ ...info, title })
        yield* Effect.tryPromise({
          try: () => ctx.sdk.api.session.rename({ sessionID: info.id, title }),
          catch: (cause) => new TabRenameError({ cause }),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              const current = session()
              const currentCtx = props.serverCtx()
              if (Option.isSome(current) && currentCtx) {
                currentCtx.sync.session.remember({ ...current.value, title: info.title })
              }
              showToast({
                title: language.t("common.requestFailed"),
                ...(error.cause instanceof Error ? { description: error.cause.message } : {}),
              })
            }),
          ),
        )
      }),
    )

  createEffect(() => props.onVisibleChange(visible()))

  createEffect(() => {
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || Option.isNone(value) || prefetched) return
    const info = value.value
    prefetched = true
    // The directory sync context is created synchronously under this root. A failed prefetch is ignored.
    createRoot((dispose) => {
      runDetached(
        Effect.try({
          try: () => ctx.sync.ensureDirSyncContext(info.directory),
          catch: (cause) => new TabPrefetchError({ cause }),
        }).pipe(
          Effect.flatMap((dir) =>
            Effect.tryPromise({
              try: () => dir.session.sync(info.id),
              catch: (cause) => new TabPrefetchError({ cause }),
            }),
          ),
          Effect.ignore,
          Effect.ensuring(Effect.sync(dispose)),
        ),
      )
    })
  })

  createEffect(() => {
    const value = session()
    if (Option.isNone(value)) return
    tabs.rememberSessionInfo(props.tab, value.value)
    const current = sdk()
    if (!current) return
    createTabPromptState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.value.directory),
      id: value.value.id,
    })
  })

  return (
    <Show when={visible()}>
      <SessionTabSlot
        tab={props.tab}
        id={props.id}
        index={props.index}
        active={props.active}
        forceTruncate={props.forceTruncate}
        session={session}
        fallbackTitle={fallbackTitle()}
        onRename={rename}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
      />
    </Show>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: () => number
  active: () => boolean
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
    >
      <DraftTabItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        title={props.title}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

export function TitlebarTabStrip(props: {
  tabs: Tab[]
  currentTab: () => Tab | undefined
  forceTruncate: boolean
  /** Selects `tab`. `el` is the tab element to scroll into view, when the strip knows it. */
  onNavigate: (tab: Tab, el: Option.Option<HTMLDivElement>) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
  onOverflowChange: (overflowing: boolean) => void
}) {
  const global = useGlobal()
  const language = useLanguage()
  const command = useCommand()
  let scrollRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  let resizeFrame = Option.none<number>()
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  const visibleTabs = createMemo(() => props.tabs.filter((tab) => tab.type === "draft" || visibility[tabKey(tab)]))
  const visibleTabIds = () => visibleTabs().map(tabKey)

  command.register("titlebar-tab-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
  ])

  function selectAdjacentTab(offset: -1 | 1) {
    const current = props.currentTab()
    const key = adjacentTabKey(visibleTabIds(), current && tabKey(current), offset)
    const next = props.tabs.find((tab) => tabKey(tab) === key)
    if (next) props.onNavigate(next, Option.none())
  }

  function refreshOverflow() {
    if (!scrollRef) return
    props.onOverflowChange(scrollRef.scrollWidth > scrollRef.clientWidth)
  }

  createResizeObserver(
    () => [scrollRef, listRef],
    () => {
      if (Option.isSome(resizeFrame)) return
      resizeFrame = Option.some(
        requestAnimationFrame(() => {
          resizeFrame = Option.none()
          refreshOverflow()
        }),
      )
    },
  )

  onMount(() => {
    refreshOverflow()
  })

  onCleanup(() => {
    if (Option.isSome(resizeFrame)) cancelAnimationFrame(resizeFrame.value)
  })

  createEffect(() => {
    props.tabs.length
    visibleTabIds()
    refreshOverflow()
  })

  return (
    <div data-slot="titlebar-tabs" class="relative min-w-0">
      <div
        data-slot="titlebar-tabs-scroll"
        class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
        ref={scrollRef}
      >
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                !canStartTabDrag(event.pointerType) ||
                isTabCloseTarget(event.target) ||
                (event.target instanceof Element && !!event.target.closest('[contenteditable="true"]')),
            }),
          ]}
          modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => listRef })]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
            // eslint-disable-next-line effect/no-null-use-option -- (a) @dnd-kit/dom FeedbackOptions.dropAnimation takes null to turn off the drop animation; undefined keeps the default animation
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragStart={(event) => {
            const source = event.operation.source
            if (!source) return
            const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())
            if (!tab) return
            props.onNavigate(
              tab,
              Option.fromNullishOr(source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")),
            )
          }}
          onDragEnd={(event) => {
            const current = visibleTabIds()
            const source = event.operation.source
            if (event.canceled || !isSortable(source)) return

            const { initialIndex, index } = source
            if (initialIndex !== index) {
              props.onReorder(
                mergeVisibleTabOrder(
                  props.tabs.map(tabKey),
                  current,
                  arrayMove(current, source.initialIndex, source.index),
                ),
              )
            }
          }}
        >
          <div data-titlebar-tab-list class="flex w-full min-w-0 flex-row items-center" ref={listRef}>
            <For each={props.tabs}>
              {(tab) => {
                const id = tabKey(tab)
                // The tab element, known once the tab has been navigated from its own element.
                let ref = Option.none<HTMLDivElement>()
                const visibleIndex = () => visibleTabs().findIndex((item) => tabKey(item) === id)
                useTabShortcut(visibleIndex, () => props.onNavigate(tab, ref))
                const serverCtx = createMemo(() => {
                  if (tab.type !== "session") return undefined
                  const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
                  if (conn) return global.ensureServerCtx(conn)
                  return undefined
                })

                if (tab.type === "session") {
                  return (
                    <SessionTabEntry
                      tab={tab}
                      id={id}
                      index={visibleIndex}
                      active={() => props.currentTab() === tab}
                      forceTruncate={props.forceTruncate}
                      serverCtx={serverCtx}
                      onVisibleChange={(visible) => setVisibility(id, visible)}
                      onNavigate={(element) => {
                        ref = Option.some(element)
                        props.onNavigate(tab, ref)
                      }}
                      onClose={() => props.onClose(tab)}
                    />
                  )
                }

                return (
                  <DraftTabSlot
                    tab={tab}
                    id={id}
                    index={visibleIndex}
                    active={() => props.currentTab() === tab}
                    title={language.t("command.session.new")}
                    onNavigate={(element) => {
                      ref = Option.some(element)
                      props.onNavigate(tab, ref)
                    }}
                    onClose={() => props.onClose(tab)}
                  />
                )
              }}
            </For>
          </div>
        </DragDropProvider>
      </div>
      <div
        data-slot="titlebar-tabs-fade-left"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
      />
      <div
        data-slot="titlebar-tabs-fade-right"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
      />
    </div>
  )
}

function useTabShortcut(index: () => number, onSelect: () => void) {
  const command = useCommand()

  command.register(() => {
    const number = index() + 1
    if (number < 1 || number > 9) return []
    return [
      {
        id: `tab.${number}`,
        category: "tab",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect,
      },
    ]
  })
}
