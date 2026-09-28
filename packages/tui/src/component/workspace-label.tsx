import { Show } from "solid-js"
import { useTheme } from "../context/theme"

export type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

export function WorkspaceLabel(props: { type: string; name: string; status?: WorkspaceStatus; icon?: boolean }) {
  const { theme } = useTheme()
  const color = () => {
    if (props.status === "connected") return theme.success
    if (props.status === "error") return theme.error
    return theme.textMuted
  }

  return (
    <>
      <Show when={props.icon}>
        <span style={{ fg: color() }}>● </span>
      </Show>
      <span style={{ fg: theme.text }}>{props.name}</span> <span style={{ fg: theme.textMuted }}>({props.type})</span>
    </>
  )
}
