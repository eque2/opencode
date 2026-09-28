import { Effect, Fiber, Option, Schema } from "effect"
import { createContext, createSignal, onCleanup, splitProps, useContext } from "solid-js"
import type { JSX } from "solid-js/jsx-runtime"
import { makeResizeObserver } from "@solid-primitives/resize-observer"
import { IconCheckCircle, IconHashtag } from "../icons"

export type ShareMessages = { locale: string } & Record<string, string>

const shareContext = createContext<ShareMessages>()

export function ShareI18nProvider(props: { messages: ShareMessages; children: JSX.Element }) {
  return <shareContext.Provider value={props.messages}>{props.children}</shareContext.Provider>
}

export class ShareI18nMissingError extends Schema.TaggedError<ShareI18nMissingError>()("ShareI18nMissingError", {
  message: Schema.String,
}) {}

// A Solid context hook must stay synchronous, so a missing provider is a defect thrown at the call site.
export function useShareMessages() {
  return Option.getOrThrowWith(
    Option.fromNullishOr(useContext(shareContext)),
    () => new ShareI18nMissingError({ message: "ShareI18nProvider is required" }),
  )
}

export function normalizeLocale(locale: string) {
  return locale === "root" ? "en" : locale
}

export function formatNumber(value: number, locale: string) {
  return new Intl.NumberFormat(normalizeLocale(locale)).format(value)
}

export function formatCurrency(value: number, locale: string) {
  return new Intl.NumberFormat(normalizeLocale(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function formatCount(value: number, locale: string, singular: string, plural: string) {
  const unit = value === 1 ? singular : plural
  return `${formatNumber(value, locale)} ${unit}`
}

interface AnchorProps extends JSX.HTMLAttributes<HTMLDivElement> {
  id: string
}
export function AnchorIcon(props: AnchorProps) {
  const [local, rest] = splitProps(props, ["id", "children"])
  const [copied, setCopied] = createSignal(false)
  const messages = useShareMessages()
  // The pending reset fiber is interrupted on a new click and when the component unmounts.
  let reset = Option.none<Fiber.Fiber<void>>()
  const interruptReset = () => {
    if (Option.isSome(reset)) Effect.runFork(Fiber.interrupt(reset.value))
  }
  onCleanup(interruptReset)

  return (
    <div {...rest} data-element-anchor title={messages.link_to_message} data-status={copied() ? "copied" : ""}>
      <a
        href={`#${local.id}`}
        onClick={(e) => {
          e.preventDefault()

          const anchor = e.currentTarget
          const hash = anchor.getAttribute("href") || ""
          const { origin, pathname, search } = window.location

          Effect.runFork(
            Effect.tryPromise(() => navigator.clipboard.writeText(`${origin}${pathname}${search}${hash}`)).pipe(
              Effect.catch((err) => Effect.logError("Copy failed", err)),
            ),
          )

          setCopied(true)
          interruptReset()
          reset = Option.some(
            Effect.runFork(Effect.sleep("3 seconds").pipe(Effect.andThen(Effect.sync(() => setCopied(false))))),
          )
        }}
      >
        {local.children}
        <IconHashtag width={18} height={18} />
        <IconCheckCircle width={18} height={18} />
      </a>
      <span data-element-tooltip>{messages.copied}</span>
    </div>
  )
}

export function createOverflow() {
  const [overflow, setOverflow] = createSignal(false)
  return {
    get status() {
      return overflow()
    },
    ref: (el: HTMLElement) => {
      const sync = () => {
        setOverflow(el.scrollHeight > el.clientHeight + 1)
      }

      const obs = makeResizeObserver(sync)
      obs.observe(el)

      sync()
    },
  }
}

export function formatDuration(ms: number, locale: string): string {
  const normalized = normalizeLocale(locale)
  const ONE_SECOND = 1000
  const ONE_MINUTE = 60 * ONE_SECOND

  if (ms >= ONE_MINUTE) {
    return new Intl.NumberFormat(normalized, {
      style: "unit",
      unit: "minute",
      unitDisplay: "narrow",
      maximumFractionDigits: 0,
    }).format(Math.floor(ms / ONE_MINUTE))
  }

  if (ms >= ONE_SECOND) {
    return new Intl.NumberFormat(normalized, {
      style: "unit",
      unit: "second",
      unitDisplay: "narrow",
      maximumFractionDigits: 0,
    }).format(Math.floor(ms / ONE_SECOND))
  }

  return new Intl.NumberFormat(normalized, {
    style: "unit",
    unit: "millisecond",
    unitDisplay: "narrow",
    maximumFractionDigits: 0,
  }).format(ms)
}
