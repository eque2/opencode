import { createEffect, For, Match, on, onCleanup, onMount, Show, Switch, type Accessor, type JSX } from "solid-js"
import { animate, type AnimationPlaybackControls } from "motion"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { createStore } from "solid-js/store"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import type { IconProps } from "@opencode-ai/ui/icon"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { Chunk, HashSet, Option, Predicate } from "effect"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

const isTriggerTitle = (val: unknown): val is TriggerTitle => {
  return (
    typeof val === "object" &&
    Predicate.isNotNull(val) &&
    "title" in val &&
    (typeof Node === "undefined" || !(val instanceof Node))
  )
}

// The last Match renders the trigger only when it is neither a render function nor a title object.
function triggerElement(trigger: BasicToolProps["trigger"]): JSX.Element {
  if (typeof trigger === "function" || isTriggerTitle(trigger)) return undefined
  return trigger
}

export interface BasicToolProps {
  icon: IconProps["name"]
  trigger: TriggerTitle | JSX.Element | ((open: Accessor<boolean>) => JSX.Element)
  children?: JSX.Element
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  forceOpen?: boolean
  allowOpenWhilePending?: boolean
  defer?: boolean
  locked?: boolean
  animated?: boolean
  onSubtitleClick?: () => void
  onTriggerClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>
  onTriggerKeyDown?: JSX.EventHandlerUnion<HTMLElement, KeyboardEvent>
  triggerHref?: string
  triggerAsLink?: boolean
  clickable?: boolean
}

const SPRING = { type: "spring" as const, visualDuration: 0.35, bounce: 0 }
let deferredMounts = Chunk.empty<{ active: boolean; fn: () => void }>()
let deferredFrame: Option.Option<number> = Option.none()

function flushDeferredMounts() {
  // Timeline tools are mounted top-to-bottom, but the viewport starts at the latest turn.
  // Take from the end so heavy default-open bodies near the bottom become interactive first.
  let next = Chunk.last(deferredMounts)
  while (Option.isSome(next)) {
    const item = next.value
    deferredMounts = Chunk.dropRight(deferredMounts, 1)
    if (item.active) {
      deferredFrame = Chunk.isNonEmpty(deferredMounts)
        ? Option.some(requestAnimationFrame(flushDeferredMounts))
        : Option.none()
      item.fn()
      return
    }
    next = Chunk.last(deferredMounts)
  }
  deferredFrame = Option.none()
}

function scheduleDeferredFlush() {
  if (Option.isSome(deferredFrame)) return
  deferredFrame = Option.some(
    requestAnimationFrame(() => {
      deferredFrame = Option.some(requestAnimationFrame(flushDeferredMounts))
    }),
  )
}

function scheduleDeferredMount(fn: () => void) {
  const item = { active: true, fn }
  deferredMounts = Chunk.append(deferredMounts, item)
  scheduleDeferredFlush()
  return () => {
    item.active = false
  }
}

function scheduleFrameMount(fn: () => void) {
  const frame = requestAnimationFrame(fn)
  return () => cancelAnimationFrame(frame)
}

export function BasicTool(props: BasicToolProps) {
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    ready: !props.defer && (props.defaultOpen ?? false),
  })
  const open = () => props.open ?? state.open
  const ready = () => state.ready
  const pending = () => props.status === "pending" || props.status === "running"
  const hasChildren = () => (props.defer ? "children" in props : props.children)
  const dynamicTrigger =
    typeof props.trigger === "function" ? Option.fromUndefinedOr(props.trigger(open)) : Option.none<JSX.Element>()

  let cancelReady: Option.Option<() => void> = Option.none()

  const cancel = () => {
    if (Option.isSome(cancelReady)) cancelReady.value()
    cancelReady = Option.none()
  }

  const scheduleReady = (initial = false) => {
    cancel()
    cancelReady = Option.some(
      (initial ? scheduleDeferredMount : scheduleFrameMount)(() => {
        cancelReady = Option.none()
        if (!open()) return
        setState("ready", true)
      }),
    )
  }

  onCleanup(cancel)

  onMount(() => {
    if (props.defer && open()) scheduleReady(true)
  })

  const setOpen = (value: boolean) => {
    if (props.open === undefined) setState("open", value)
    props.onOpenChange?.(value)
  }

  createEffect(() => {
    if (!props.forceOpen) return
    if (open()) return
    setOpen(true)
  })

  createEffect(
    on(
      open,
      (value) => {
        if (!props.defer) return
        if (!value) {
          cancel()
          setState("ready", false)
          return
        }

        scheduleReady()
      },
      { defer: true },
    ),
  )

  // Animated height for collapsible open/close
  let contentRef: HTMLDivElement | undefined
  let heightAnim: AnimationPlaybackControls | undefined
  const initialOpen = open()

  createEffect(
    on(
      open,
      (isOpen) => {
        if (!props.animated || !contentRef) return
        heightAnim?.stop()
        if (isOpen) {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "auto" }, SPRING)
          void heightAnim.finished.then(() => {
            if (!contentRef || !open()) return
            contentRef.style.overflow = "visible"
            contentRef.style.height = "auto"
          })
        } else {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "0px" }, SPRING)
        }
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    heightAnim?.stop()
  })

  const handleOpenChange = (value: boolean) => {
    if (pending() && !props.allowOpenWhilePending) return
    if (props.locked && !value) return
    setOpen(value)
  }

  const trigger = () => (
    <div
      data-component="tool-trigger"
      {...(props.clickable ? { "data-clickable": "true" } : {})}
      {...(props.hideDetails ? { "data-hide-details": "true" } : {})}
    >
      <div data-slot="basic-tool-tool-trigger-content">
        <div data-slot="basic-tool-tool-info">
          <Switch>
            <Match when={Option.isSome(dynamicTrigger)}>{Option.getOrUndefined(dynamicTrigger)}</Match>
            <Match when={isTriggerTitle(props.trigger) && props.trigger}>
              {(title) => (
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span
                      data-slot="basic-tool-tool-title"
                      classList={{
                        [title().titleClass ?? ""]: !!title().titleClass,
                      }}
                    >
                      <TextShimmer text={title().title} active={pending()} />
                    </span>
                    <Show when={!pending() || title().subtitle || title().args?.length}>
                      <Show when={title().subtitle}>
                        <span
                          data-slot="basic-tool-tool-subtitle"
                          classList={{
                            [title().subtitleClass ?? ""]: !!title().subtitleClass,
                            clickable: !!props.onSubtitleClick,
                          }}
                          onClick={(e) => {
                            if (props.onSubtitleClick) {
                              e.stopPropagation()
                              props.onSubtitleClick()
                            }
                          }}
                        >
                          {title().subtitle}
                        </span>
                      </Show>
                      <Show when={title().args?.length}>
                        <For each={title().args}>
                          {(arg) => (
                            <span
                              data-slot="basic-tool-tool-arg"
                              classList={{
                                [title().argsClass ?? ""]: !!title().argsClass,
                              }}
                            >
                              {arg}
                            </span>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                  <Show when={!pending() && title().action}>
                    <span data-slot="basic-tool-tool-action">{title().action}</span>
                  </Show>
                </div>
              )}
            </Match>
            <Match when={true}>{triggerElement(props.trigger)}</Match>
          </Switch>
        </div>
      </div>
      <Show when={hasChildren() && !props.hideDetails && !props.locked && (!pending() || props.allowOpenWhilePending)}>
        <Collapsible.Arrow />
      </Show>
    </div>
  )

  return (
    <Collapsible open={open()} onOpenChange={handleOpenChange} class="tool-collapsible">
      <Show
        when={props.triggerAsLink || props.triggerHref}
        fallback={
          <Collapsible.Trigger
            {...(props.hideDetails ? { "data-hide-details": "true" } : {})}
            onClick={props.onTriggerClick}
          >
            {trigger()}
          </Collapsible.Trigger>
        }
      >
        <Collapsible.Trigger
          as="a"
          href={props.triggerHref}
          {...(!props.triggerHref && props.clickable ? { role: "button", tabIndex: 0 } : {})}
          {...(props.hideDetails ? { "data-hide-details": "true" } : {})}
          onClick={props.onTriggerClick}
          onKeyDown={props.onTriggerKeyDown}
        >
          {trigger()}
        </Collapsible.Trigger>
      </Show>
      <Show when={props.animated && hasChildren() && !props.hideDetails}>
        <div
          ref={contentRef}
          data-slot="collapsible-content"
          data-animated
          style={{
            height: initialOpen ? "auto" : "0px",
            overflow: initialOpen ? "visible" : "hidden",
          }}
        >
          <Show when={!props.defer || ready()}>{props.children}</Show>
        </div>
      </Show>
      <Show when={!props.animated && hasChildren() && !props.hideDetails}>
        <Collapsible.Content>
          <Show when={!props.defer || ready()}>{props.children}</Show>
        </Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

function label(input: Record<string, unknown> | undefined) {
  const keys = ["description", "query", "url", "filePath", "path", "pattern", "name"]
  return keys.map((key) => input?.[key]).find((value): value is string => typeof value === "string" && value.length > 0)
}

const argSkipKeys = HashSet.make("description", "query", "url", "filePath", "path", "pattern", "name")

function args(input: Record<string, unknown> | undefined) {
  if (!input) return []
  return Object.entries(input)
    .filter(([key]) => !HashSet.has(argSkipKeys, key))
    .flatMap(([key, value]) => {
      if (typeof value === "string") return [`${key}=${value}`]
      if (typeof value === "number") return [`${key}=${value}`]
      if (typeof value === "boolean") return [`${key}=${value}`]
      return []
    })
    .slice(0, 3)
}

export function GenericTool(props: {
  tool: string
  status?: string
  hideDetails?: boolean
  input?: Record<string, unknown>
}) {
  const i18n = useI18n()

  return (
    <BasicTool
      icon="mcp"
      status={props.status}
      trigger={{
        title: i18n.t("ui.basicTool.called", { tool: props.tool }),
        subtitle: label(props.input),
        args: args(props.input),
      }}
      hideDetails={props.hideDetails}
    />
  )
}
