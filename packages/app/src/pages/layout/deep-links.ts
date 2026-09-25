import { Option } from "effect"

export const deepLinkEvent = "opencode:deep-link"

type NewSessionDeepLink = { directory: string; prompt?: string }

/** The URL constructor throws on a malformed input; that input becomes None. */
const toURL = Option.liftThrowable((input: string) => new URL(input))

const parseUrl = (input: string): Option.Option<URL> => {
  if (!input.startsWith("opencode://")) return Option.none()
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return Option.none()
  return toURL(input)
}

/** A search parameter of the link. An absent or empty value is None. */
const param = (url: URL, name: string) =>
  Option.fromNullishOr(url.searchParams.get(name)).pipe(Option.filter((value) => value.length > 0))

const openProjectDirectory = (input: string) =>
  parseUrl(input).pipe(
    Option.filter((url) => url.hostname === "open-project"),
    Option.flatMap((url) => param(url, "directory")),
  )

const newSessionLink = (input: string): Option.Option<NewSessionDeepLink> =>
  parseUrl(input).pipe(
    Option.filter((url) => url.hostname === "new-session"),
    Option.flatMap((url) =>
      param(url, "directory").pipe(
        Option.map((directory) =>
          Option.match(param(url, "prompt"), {
            onNone: () => ({ directory }),
            onSome: (prompt) => ({ directory, prompt }),
          }),
        ),
      ),
    ),
  )

export const parseDeepLink = (input: string) => Option.getOrUndefined(openProjectDirectory(input))

export const parseNewSessionDeepLink = (input: string) => Option.getOrUndefined(newSessionLink(input))

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.flatMap((url) => Option.toArray(openProjectDirectory(url)))

export const collectNewSessionDeepLinks = (urls: string[]) => urls.flatMap((url) => Option.toArray(newSessionLink(url)))

/** The part of the window that the desktop shell fills with deep links received before the app loaded. */
type DeepLinkQueue = Pick<Window, "__OPENCODE__">

export const drainPendingDeepLinks = (target: DeepLinkQueue) => {
  const pending = target.__OPENCODE__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__OPENCODE__) target.__OPENCODE__.deepLinks = []
  return pending
}
