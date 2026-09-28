import type { LocationRef } from "@opencode-ai/sdk/v2"
import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"
import { MissingProviderError } from "./errors"

const context = createContext<Accessor<LocationRef | undefined>>()

export function LocationProvider(props: ParentProps<{ location?: LocationRef }>) {
  return <context.Provider value={() => props.location}>{props.children}</context.Provider>
}

export function useLocation() {
  const value = useContext(context)
  if (!value) {
    // eslint-disable-next-line effect/no-throw-use-effect -- (a) Solid useContext hook contract is synchronous: return the value or throw outside the provider
    throw new MissingProviderError({ message: "Location context must be used within a LocationProvider" })
  }
  return value
}
