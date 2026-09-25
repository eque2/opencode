// @refresh reload

import * as Sentry from "@sentry/solid"
import { Data, Effect, Option, Result, String as Str } from "effect"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { loadInitialLocale } from "@/context/language"
import { type Platform, PlatformProvider } from "@/context/platform"
import { createBrowserDraftStore } from "@/utils/draft-store"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { authFromToken } from "@/utils/server"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

/** The page has no #root element to mount the app into. */
class RootNotFoundError extends Data.TaggedError("App.RootNotFoundError")<{ readonly message: string }> {}

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

/** Runs a localStorage call. None when there is no storage or the call throws (quota, blocked storage). */
const tryStorage = <A,>(run: () => A): Option.Option<A> => {
  if (typeof localStorage === "undefined") return Option.none()
  return Result.getSuccess(Result.try(run))
}

const getStorage = (key: string): Option.Option<string> =>
  Option.flatMap(
    tryStorage(() => localStorage.getItem(key)),
    (value) => Option.fromNullishOr(value),
  )

/** Stores the value, or removes the key for None. A storage failure is ignored. */
const setStorage = (key: string, value: Option.Option<string>) => {
  tryStorage(() =>
    Option.match(value, {
      onNone: () => localStorage.removeItem(key),
      onSome: (text) => localStorage.setItem(key, text),
    }),
  )
}

/** The stored default server URL. An empty string counts as no URL. */
const readDefaultServerUrl = () => Option.filter(getStorage(DEFAULT_SERVER_URL_KEY), Str.isNonEmpty)
const writeDefaultServerUrl = (url: Option.Option<string>) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = (title, description, onClick) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!("Notification" in window)) return

      // A failed permission request counts as a denial.
      const permission =
        Notification.permission === "default"
          ? yield* Effect.tryPromise(() => Notification.requestPermission()).pipe(Effect.orElseSucceed(() => "denied"))
          : Notification.permission

      if (permission !== "granted") return

      const inView = document.visibilityState === "visible" && document.hasFocus()
      if (inView) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })

      notification.onclick = () => {
        window.focus()
        onClick?.()
        notification.close()
      }
    }),
  )

const openExternal: Platform["openExternal"] = (value) => {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return
  window.open(url.href, "_blank", "noopener,noreferrer")
}

const restart: Platform["restart"] = () => Effect.runPromise(Effect.sync(() => window.location.reload()))

/** The #root element that index.html provides. None when it is missing or not an HTML element. */
const root = Option.liftPredicate(
  document.getElementById("root"),
  (element): element is HTMLElement => element instanceof HTMLElement,
)
// A dev build stops at module load with a readable error when #root is missing.
if (import.meta.env.DEV) Option.getOrThrowWith(root, () => new RootNotFoundError({ message: getRootNotFoundError() }))

const getCurrentUrl = () => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => Option.getOrElse(readDefaultServerUrl(), getCurrentUrl)

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

const platform: Platform = {
  platform: "web",
  draftStore: createBrowserDraftStore(),
  version: pkg.version,
  openExternal,
  restart,
  notify,
  // Platform.getDefaultServer and setDefaultServer use null for "no default server".
  getDefaultServer: () =>
    Effect.runPromise(
      Effect.sync(() => Option.getOrNull(Option.map(readDefaultServerUrl(), (url) => ServerConnection.Key.make(url)))),
    ),
  setDefaultServer: (url) => writeDefaultServerUrl(Option.fromNullishOr(url)),
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

if (Option.isSome(root)) {
  void loadInitialLocale().then((locale) => {
    const auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))
    clearAuthToken()
    const server: ServerConnection.Http = {
      type: "http",
      authToken: !!auth,
      http: {
        url: getCurrentUrl(),
        ...auth,
      },
    }
    render(
      () => (
        <PlatformProvider value={platform}>
          <AppBaseProviders locale={locale}>
            <AppInterface
              defaultServer={ServerConnection.Key.make(getDefaultUrl())}
              canonicalLocalServer={ServerConnection.key(server)}
              servers={[server]}
              disableHealthCheck
            />
          </AppBaseProviders>
        </PlatformProvider>
      ),
      root.value,
    )
  })
}
