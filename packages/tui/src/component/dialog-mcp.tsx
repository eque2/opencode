import { Data, Effect, Option } from "effect"
import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"

/** Toggling an MCP server or refreshing the MCP status failed. */
class ToggleError extends Data.TaggedError("DialogMcp.ToggleError")<{ readonly cause: unknown }> {}

function Status(props: { enabled: boolean; loading: boolean }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
  }
  if (props.enabled) {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ Disabled</span>
}

export function DialogMcp() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<Option.Option<string>>(Option.none())

  const options = createMemo(() => {
    // Track sync data and loading state to trigger re-render when they change
    const mcpData = sync.data.mcp
    const loadingMcp = loading()

    return pipe(
      mcpData ?? {},
      entries(),
      sortBy(([name]) => name),
      map(([name, status]) => ({
        value: name,
        title: name,
        description: status.status === "failed" ? "failed" : status.status,
        footer: <Status enabled={local.mcp.isEnabled(name)} loading={Option.contains(loadingMcp, name)} />,
      })),
    )
  })

  const actions = createMemo(() => [
    {
      command: "dialog.mcp.toggle",
      title: "toggle",
      onTrigger: (option: DialogSelectOption<string>) => {
        // Prevent toggling while an operation is already in progress
        if (Option.isSome(loading())) return

        setLoading(Option.some(option.value))
        Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => local.mcp.toggle(option.value),
              catch: (cause) => new ToggleError({ cause }),
            })
            // Refresh MCP status from server
            const status = yield* Effect.tryPromise({
              try: () => sdk.client.mcp.status(),
              catch: (cause) => new ToggleError({ cause }),
            })
            if (status.data) {
              sync.set("mcp", status.data)
              return
            }
            yield* Effect.logError("Failed to refresh MCP status: no data returned")
          }).pipe(
            Effect.catch((error) => Effect.logError("Failed to toggle MCP:", error.cause)),
            Effect.ensuring(Effect.sync(() => setLoading(Option.none()))),
          ),
        )
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title="MCPs"
      options={options()}
      actions={actions()}
      onSelect={(_option) => {
        // Don't close on select, only on escape
      }}
    />
  )
}
