import { Data, Effect, Option } from "effect"
import type { DesktopTheme, ResolvedTheme, ResolvedV2Theme } from "./types"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { resolveThemeVariantV2, themeV2ToCss } from "./v2/resolve"
import { isDesktopTheme } from "./validate"

/** Raised by loadThemeFromUrl. The `message` text is what Promise consumers see. */
class ThemeLoadError extends Data.TaggedError("ThemeLoadError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

let activeTheme: Option.Option<DesktopTheme> = Option.none()
const THEME_STYLE_ID = "opencode-theme"

function ensureLoaderStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID)
  if (existing instanceof HTMLStyleElement) {
    return existing
  }
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

export function applyTheme(theme: DesktopTheme, themeId?: string): void {
  activeTheme = Option.some(theme)
  const lightTokens = resolveThemeVariant(theme.light, false)
  const darkTokens = resolveThemeVariant(theme.dark, true)
  const lightV2Tokens = resolveThemeVariantV2(theme.light, false)
  const darkV2Tokens = resolveThemeVariantV2(theme.dark, true)
  const targetThemeId = themeId ?? theme.id
  const css = buildThemeCss(lightTokens, darkTokens, lightV2Tokens, darkV2Tokens, targetThemeId)
  const themeStyleElement = ensureLoaderStyleElement()
  themeStyleElement.textContent = css
  document.documentElement.setAttribute("data-theme", targetThemeId)
}

function buildThemeCss(
  light: ResolvedTheme,
  dark: ResolvedTheme,
  lightV2: ResolvedV2Theme,
  darkV2: ResolvedV2Theme,
  themeId: string,
): string {
  const isDefaultTheme = themeId === "oc-2"
  const lightCss = `${themeToCss(light)}\n  ${themeV2ToCss(lightV2)}`
  const darkCss = `${themeToCss(dark)}\n  ${themeV2ToCss(darkV2)}`

  if (isDefaultTheme) {
    return `
:root {
  color-scheme: light;
  --text-mix-blend-mode: multiply;

  ${lightCss}

  @media (prefers-color-scheme: dark) {
    color-scheme: dark;
    --text-mix-blend-mode: plus-lighter;

    ${darkCss}
  }
}
`
  }

  return `
html[data-theme="${themeId}"] {
  color-scheme: light;
  --text-mix-blend-mode: multiply;

  ${lightCss}

  @media (prefers-color-scheme: dark) {
    color-scheme: dark;
    --text-mix-blend-mode: plus-lighter;

    ${darkCss}
  }
}
`
}

/** Rejects with ThemeLoadError when the request fails, the response is not ok, or the JSON is not a DesktopTheme. */
export function loadThemeFromUrl(url: string): Promise<DesktopTheme> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => fetch(url),
        catch: (cause) => new ThemeLoadError({ message: `Failed to load theme from ${url}`, cause }),
      })
      if (!response.ok) {
        return yield* new ThemeLoadError({ message: `Failed to load theme from ${url}: ${response.statusText}` })
      }
      const json: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => new ThemeLoadError({ message: `Failed to read theme JSON from ${url}`, cause }),
      })
      if (isDesktopTheme(json)) return json
      return yield* new ThemeLoadError({ message: `Theme from ${url} does not match the DesktopTheme type` })
    }),
  )
}

/** Returns the theme that applyTheme set, while the document still shows its id; otherwise null. */
export function getActiveTheme(): DesktopTheme | null {
  const activeId = document.documentElement.getAttribute("data-theme")
  return Option.getOrNull(Option.filter(activeTheme, (theme) => Boolean(activeId) && theme.id === activeId))
}

export function removeTheme(): void {
  activeTheme = Option.none()
  const existingElement = document.getElementById(THEME_STYLE_ID)
  if (existingElement) {
    existingElement.remove()
  }
  document.documentElement.removeAttribute("data-theme")
}

export function setColorScheme(scheme: "light" | "dark" | "auto"): void {
  if (scheme === "auto") {
    document.documentElement.style.removeProperty("color-scheme")
  } else {
    document.documentElement.style.setProperty("color-scheme", scheme)
  }
}
