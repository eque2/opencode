/** @jsxImportSource @opentui/solid */
import {
  TuiFlagsProvider,
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  type TuiPaths,
} from "../../src/context/runtime"
import type { ParentProps } from "solid-js"

export function TestTuiContexts(
  props: ParentProps<{
    cwd?: string
    directory?: string
    paths?: Partial<TuiPaths>
  }>,
) {
  return (
    <TuiPathsProvider
      value={{
        cwd: props.cwd ?? props.directory ?? "/tmp/opencode/packages/tui",
        home: "/tmp/opencode/home",
        state: "/tmp/opencode/state",
        worktree: "/tmp/opencode",
        ...props.paths,
      }}
    >
      <TuiTerminalEnvironmentProvider value={{ platform: "linux" }}>
        <TuiStartupProvider value={{ skipInitialLoading: false }}>
          <TuiFlagsProvider
            value={{
              OPENCODE_DISABLE_MOUSE: false,
              OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: process.platform === "win32",
              OPENCODE_DISABLE_TERMINAL_TITLE: false,
              OPENCODE_EXPERIMENTAL_WORKSPACES: false,
              OPENCODE_SHOW_TTFD: false,
            }}
          >
            {props.children}
          </TuiFlagsProvider>
        </TuiStartupProvider>
      </TuiTerminalEnvironmentProvider>
    </TuiPathsProvider>
  )
}
