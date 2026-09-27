import { Result } from "effect"

export const destroyedWindowURL = "<destroyed>"

type WebContentsURLState = {
  isDestroyed(): boolean
  getURL(): string
}

type WindowURLState = {
  isDestroyed(): boolean
  readonly webContents: WebContentsURLState
}

// Electron throws when a window or its web contents is destroyed between the
// check and the read, so a failed read also reports a destroyed window.
export function safeWebContentsURL(webContents: WebContentsURLState) {
  return Result.try(() => (webContents.isDestroyed() ? destroyedWindowURL : webContents.getURL())).pipe(
    Result.getOrElse(() => destroyedWindowURL),
  )
}

export function safeWindowURL(win: WindowURLState) {
  return Result.try(() => (win.isDestroyed() ? destroyedWindowURL : safeWebContentsURL(win.webContents))).pipe(
    Result.getOrElse(() => destroyedWindowURL),
  )
}
