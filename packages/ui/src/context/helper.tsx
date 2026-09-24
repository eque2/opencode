import { createContext, createMemo, Show, useContext, type ParentProps, type Accessor } from "solid-js"

export function createSimpleContext<T, Props extends Record<string, any>>(
  input: {
    name: string
    init: ((input: Props) => T) | (() => T)
  } & (T extends { ready: unknown } ? { gate: boolean } : { gate?: boolean }),
) {
  const ctx = createContext<T>()

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      const gate = input.gate ?? true

      if (!gate) {
        return <ctx.Provider value={init}>{props.children}</ctx.Provider>
      }

      // Access init.ready inside the memo to make it reactive for getter properties
      const isReady = createMemo(() => {
        if (!init || (typeof init !== "object" && typeof init !== "function")) return true
        if (!("ready" in init)) return true
        const ready = init.ready
        return ready === undefined || (isAccessor(ready) ? ready() : ready)
      })
      return (
        <Show when={isReady()}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use: () => {
      const value = useContext(ctx)
      // eslint-disable-next-line effect/no-throw-use-effect -- Solid useContext hook must return synchronously and throw outside its provider
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}

// Any function accepts a call with no arguments, so typeof alone proves this narrowing.
function isAccessor(value: unknown): value is Accessor<unknown> {
  return typeof value === "function"
}
