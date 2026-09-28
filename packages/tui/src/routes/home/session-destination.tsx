import { Option } from "effect"
import { createContext, createMemo, createSignal, useContext, type Accessor, type ParentProps } from "solid-js"
import { useSync } from "../../context/sync"
import { useTuiPaths } from "../../context/runtime"

export type HomeSessionDestination = { type: "directory"; directory: string; subdirectory: boolean } | { type: "new" }

type Context = {
  destination: Accessor<HomeSessionDestination | undefined>
  setDestination: (destination: HomeSessionDestination) => void
  clear: () => void
}

const HomeSessionDestinationContext = createContext<Context>()

export function HomeSessionDestinationProvider(props: ParentProps) {
  const sync = useSync()
  const paths = useTuiPaths()
  const [selected, setSelected] = createSignal(Option.none<HomeSessionDestination>())
  const destination = createMemo(() =>
    Option.getOrElse(
      selected(),
      (): HomeSessionDestination => ({
        type: "directory",
        directory: sync.path.directory || paths.cwd,
        subdirectory: false,
      }),
    ),
  )
  return (
    <HomeSessionDestinationContext.Provider
      value={{
        destination,
        setDestination: (value) => setSelected(Option.some(value)),
        clear: () => setSelected(Option.none()),
      }}
    >
      {props.children}
    </HomeSessionDestinationContext.Provider>
  )
}

export function useHomeSessionDestination() {
  return useContext(HomeSessionDestinationContext)
}
