import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ServerConnection } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { Option } from "effect"
import { lazy } from "solid-js"
import { DialogSelectDirectory } from "./dialog-select-directory"
import { directoryPickerKind } from "./directory-picker-policy"

const DialogSelectDirectoryV2 = lazy(() =>
  import("./dialog-select-directory-v2").then((module) => ({ default: module.DialogSelectDirectoryV2 })),
)

type DirectoryPickerInput = {
  server: ServerConnection.Any
  title?: string
  multiple?: boolean
  /** Receives the chosen path or paths, or Option.none() when the user cancels. */
  onSelect: (result: Option.Option<string | string[]>) => void
}

export function useDirectoryPicker() {
  const platform = usePlatform()
  const settings = useSettings()
  const dialog = useDialog()

  return (input: DirectoryPickerInput) => {
    if (directoryPickerKind(platform.platform, input.server) === "native" && platform.platform === "desktop") {
      // The platform resolves null on cancel; decode it into the Option domain here.
      void platform
        .openDirectoryPickerDialog({ title: input.title, multiple: input.multiple })
        .then((result) => input.onSelect(Option.fromNullishOr(result)))
      return
    }

    let selected = false
    const onSelect = (result: string | string[]) => {
      selected = true
      input.onSelect(Option.some(result))
    }
    const cancel = () => {
      if (!selected) input.onSelect(Option.none())
    }
    if (platform.platform === "desktop" && settings.general.newLayoutDesigns()) {
      void dialog.show(() => <DialogSelectDirectoryV2 {...input} onSelect={onSelect} />, cancel)
      return
    }
    void dialog.show(() => <DialogSelectDirectory {...input} onSelect={onSelect} />, cancel)
  }
}
