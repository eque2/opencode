import { TextAttributes } from "@opentui/core"
import { Data, DateTime, Effect } from "effect"
import { createMemo, createSignal, For } from "solid-js"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useRoute } from "../context/route"
import { useLocal } from "../context/local"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"
import { describeOS, describeTerminal } from "../util/system"

/** The clipboard rejected the debug info. */
class CopyError extends Data.TaggedError("DialogDebug.CopyError")<{ readonly cause: unknown }> {}

export function DialogDebug() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const route = useRoute()
  const local = useLocal()
  const clipboard = useClipboard()
  const toast = useToast()
  const [copied, setCopied] = createSignal(false)
  // The environment read finishes synchronously, so the first render already shows the terminal.
  const [terminal, setTerminal] = createSignal("unknown")
  Effect.runFork(describeTerminal.pipe(Effect.tap((value) => Effect.sync(() => setTerminal(value)))))

  dialog.setSize("large")

  const entries = createMemo(() => {
    const model = local.model.current()
    return [
      { label: "Version", value: `${InstallationVersion} (${InstallationChannel})` },
      { label: "Date", value: DateTime.formatIso(DateTime.nowUnsafe()) },
      { label: "OS", value: describeOS() },
      { label: "Terminal", value: terminal() },
      { label: "Session ID", value: route.data.type === "session" ? route.data.sessionID : "n/a" },
      { label: "Model", value: model ? `${model.providerID}/${model.modelID}` : "n/a" },
    ]
  })

  const copy = () => {
    const text = entries()
      .map((entry) => `${entry.label}: ${entry.value}`)
      .join("\n")
    const written = clipboard.write?.(text)
    if (!written) return
    Effect.runFork(
      Effect.tryPromise({ try: () => written, catch: (cause) => new CopyError({ cause }) }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            setCopied(true)
            toast.show({ message: "Debug info copied to clipboard", variant: "info" })
          }),
        ),
        Effect.catch((error) => Effect.sync(() => toast.error(error.cause))),
      ),
    )
  }

  useBindings(() => ({
    bindings: [{ key: "return", desc: "Copy debug info", group: "Dialog", cmd: copy }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Debug
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      {/* No click-to-copy here: releasing a mouse selection must trigger the
          global copy-on-select so users can copy a single value, e.g. the session id. */}
      <box>
        <For each={entries()}>
          {(entry) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme.textMuted}>
                {entry.label.padEnd(10)}
              </text>
              <text fg={theme.text} wrapMode="word">
                {entry.value}
              </text>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>Share this when reporting an issue.</text>
        <text onMouseUp={copy}>
          <span style={{ fg: copied() ? theme.success : theme.text }}>
            <b>{copied() ? "✓ copied" : "copy"}</b>{" "}
          </span>
          <span style={{ fg: theme.textMuted }}>enter</span>
        </text>
      </box>
    </box>
  )
}
