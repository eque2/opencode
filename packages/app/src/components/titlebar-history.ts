import { Option } from "effect"

export const MAX_TITLEBAR_HISTORY = 100

/** The titlebar navigation that caused the next path change. None for any other navigation. */
export type TitlebarAction = Option.Option<"back" | "forward">

export type TitlebarHistory = {
  stack: string[]
  index: number
  action: TitlebarAction
}

export function applyPath(state: TitlebarHistory, current: string, max = MAX_TITLEBAR_HISTORY): TitlebarHistory {
  if (!state.stack.length) {
    const stack = current === "/" ? ["/"] : ["/", current]
    return { stack, index: stack.length - 1, action: Option.none() }
  }

  const active = state.stack[state.index]
  if (current === active) {
    if (Option.isNone(state.action)) return state
    return { ...state, action: Option.none() }
  }

  if (Option.isSome(state.action)) return { ...state, action: Option.none() }

  return pushPath(state, current, max)
}

export function pushPath(state: TitlebarHistory, path: string, max = MAX_TITLEBAR_HISTORY): TitlebarHistory {
  const stack = state.stack.slice(0, state.index + 1).concat(path)
  const next = trimHistory(stack, stack.length - 1, max)
  return { ...state, ...next, action: Option.none() }
}

export function trimHistory(stack: string[], index: number, max = MAX_TITLEBAR_HISTORY) {
  if (stack.length <= max) return { stack, index }
  const cut = stack.length - max
  return {
    stack: stack.slice(cut),
    index: Math.max(0, index - cut),
  }
}

export function backPath(state: TitlebarHistory) {
  if (state.index <= 0) return undefined
  const index = state.index - 1
  const to = state.stack[index]
  if (!to) return undefined
  return { state: { ...state, index, action: Option.some("back" as const) }, to }
}

export function forwardPath(state: TitlebarHistory) {
  if (state.index >= state.stack.length - 1) return undefined
  const index = state.index + 1
  const to = state.stack[index]
  if (!to) return undefined
  return { state: { ...state, index, action: Option.some("forward" as const) }, to }
}
