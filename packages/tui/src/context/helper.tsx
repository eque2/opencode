import { createContext, Show, useContext, type ParentProps } from "solid-js"
import { MissingProviderError } from "./errors"

export function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  return {
    context: ctx,
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      return (
        // @ts-expect-error
        <Show when={init.ready === undefined || init.ready === true}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use: () => {
      const value = useContext(ctx)
      if (!value) {
        // eslint-disable-next-line effect/no-throw-use-effect -- (a) Solid useContext hook contract is synchronous: return the value or throw outside the provider
        throw new MissingProviderError({ message: `${input.name} context must be used within a context provider` })
      }
      return value
    },
  }
}
