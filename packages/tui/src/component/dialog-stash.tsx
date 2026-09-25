import { DateTime, Option } from "effect"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { createMemo, createSignal } from "solid-js"
import { Locale } from "../util/locale"
import { useTheme } from "../context/theme"
import { usePromptStash, type StashEntry } from "./prompt/stash"
import { useCommandShortcut } from "../keymap"

function getRelativeTime(timestamp: number): string {
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return Locale.datetime(timestamp)
}

function getStashPreview(input: string, maxLength: number = 50): string {
  const firstLine = input.split("\n")[0].trim()
  return Locale.truncate(firstLine, maxLength)
}

export function DialogStash(props: { onSelect: (entry: StashEntry) => void }) {
  const dialog = useDialog()
  const stash = usePromptStash()
  const { theme } = useTheme()

  const [toDelete, setToDelete] = createSignal(Option.none<number>())
  const deleteHint = useCommandShortcut("stash.delete")

  const options = createMemo(() => {
    const entries = stash.list()
    // Show most recent first
    return entries
      .map((entry, index) => {
        const isDeleting = Option.contains(toDelete(), index)
        const lineCount = (entry.input.match(/\n/g)?.length ?? 0) + 1
        return {
          title: isDeleting ? `Press ${deleteHint()} again to confirm` : getStashPreview(entry.input),
          ...(isDeleting ? { bg: theme.error } : {}),
          value: index,
          description: getRelativeTime(entry.timestamp),
          ...(lineCount > 1 ? { footer: `~${lineCount} lines` } : {}),
        }
      })
      .toReversed()
  })

  return (
    <DialogSelect
      title="Stash"
      options={options()}
      onMove={() => {
        setToDelete(Option.none())
      }}
      onSelect={(option) => {
        const entries = stash.list()
        const entry = entries[option.value]
        if (entry) {
          stash.remove(option.value)
          props.onSelect(entry)
        }
        dialog.clear()
      }}
      actions={[
        {
          command: "stash.delete",
          title: "delete",
          onTrigger: (option) => {
            if (Option.contains(toDelete(), option.value)) {
              stash.remove(option.value)
              setToDelete(Option.none())
              return
            }
            setToDelete(Option.some(option.value))
          },
        },
      ]}
    />
  )
}
