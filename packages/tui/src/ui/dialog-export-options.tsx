import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { onCleanup, onMount, Show } from "solid-js"
import { Effect, Fiber, Option } from "effect"
import { useTuiConfig } from "../config"
import { useBindings } from "../keymap"

export type ExportOptions = {
  filename: string
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  openWithoutSaving: boolean
}

export type DialogExportOptionsProps = {
  defaultFilename: string
  defaultThinking: boolean
  defaultToolDetails: boolean
  defaultAssistantMetadata: boolean
  defaultOpenWithoutSaving: boolean
  onConfirm?: (options: ExportOptions) => void
  onCancel?: () => void
}

export function DialogExportOptions(props: DialogExportOptionsProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  let textarea: TextareaRenderable
  const [store, setStore] = createStore({
    thinking: props.defaultThinking,
    toolDetails: props.defaultToolDetails,
    assistantMetadata: props.defaultAssistantMetadata,
    openWithoutSaving: props.defaultOpenWithoutSaving,
    active: "filename" as "filename" | "thinking" | "toolDetails" | "assistantMetadata" | "openWithoutSaving",
  })

  // The active option row is highlighted. The box prop reads undefined as "no background".
  const rowBackground = (row: typeof store.active) =>
    store.active === row ? Option.some(theme.backgroundElement) : Option.none()

  useBindings(() => ({
    bindings: [
      {
        key: "tab",
        desc: "Next export option",
        group: "Dialog",
        cmd: () => {
          const order: Array<"filename" | "thinking" | "toolDetails" | "assistantMetadata" | "openWithoutSaving"> = [
            "filename",
            "thinking",
            "toolDetails",
            "assistantMetadata",
            "openWithoutSaving",
          ]
          const currentIndex = order.indexOf(store.active)
          const nextIndex = (currentIndex + 1) % order.length
          setStore("active", order[nextIndex])
        },
      },
    ],
  }))

  useBindings(() => ({
    enabled: store.active !== "filename",
    bindings: [
      {
        key: "space",
        desc: "Toggle export option",
        group: "Dialog",
        cmd: () => {
          if (store.active === "thinking") setStore("thinking", !store.thinking)
          if (store.active === "toolDetails") setStore("toolDetails", !store.toolDetails)
          if (store.active === "assistantMetadata") setStore("assistantMetadata", !store.assistantMetadata)
          if (store.active === "openWithoutSaving") setStore("openWithoutSaving", !store.openWithoutSaving)
        },
      },
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    // Focus after the dialog finishes mounting; the pending focus stops if the dialog closes first.
    const focus = Effect.runFork(
      Effect.sleep("1 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!textarea || textarea.isDestroyed) return
            textarea.focus()
          }),
        ),
      ),
    )
    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(focus))
    })
    textarea.gotoLineEnd()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Export Options
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <box>
          <text fg={theme.text}>Filename:</text>
        </box>
        <textarea
          onSubmit={() => {
            props.onConfirm?.({
              filename: textarea.plainText,
              thinking: store.thinking,
              toolDetails: store.toolDetails,
              assistantMetadata: store.assistantMetadata,
              openWithoutSaving: store.openWithoutSaving,
            })
          }}
          height={3}
          ref={(val: TextareaRenderable) => {
            textarea = val
            val.traits = { status: "FILENAME" }
          }}
          initialValue={props.defaultFilename}
          placeholder="Enter filename"
          placeholderColor={theme.textMuted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
          cursorStyle={tuiConfig.cursor}
        />
      </box>
      <box flexDirection="column">
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={Option.getOrUndefined(rowBackground("thinking"))}
          onMouseUp={() => setStore("active", "thinking")}
        >
          <text fg={store.active === "thinking" ? theme.primary : theme.textMuted}>
            {store.thinking ? "[x]" : "[ ]"}
          </text>
          <text fg={store.active === "thinking" ? theme.primary : theme.text}>Include thinking</text>
        </box>
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={Option.getOrUndefined(rowBackground("toolDetails"))}
          onMouseUp={() => setStore("active", "toolDetails")}
        >
          <text fg={store.active === "toolDetails" ? theme.primary : theme.textMuted}>
            {store.toolDetails ? "[x]" : "[ ]"}
          </text>
          <text fg={store.active === "toolDetails" ? theme.primary : theme.text}>Include tool details</text>
        </box>
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={Option.getOrUndefined(rowBackground("assistantMetadata"))}
          onMouseUp={() => setStore("active", "assistantMetadata")}
        >
          <text fg={store.active === "assistantMetadata" ? theme.primary : theme.textMuted}>
            {store.assistantMetadata ? "[x]" : "[ ]"}
          </text>
          <text fg={store.active === "assistantMetadata" ? theme.primary : theme.text}>Include assistant metadata</text>
        </box>
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={Option.getOrUndefined(rowBackground("openWithoutSaving"))}
          onMouseUp={() => setStore("active", "openWithoutSaving")}
        >
          <text fg={store.active === "openWithoutSaving" ? theme.primary : theme.textMuted}>
            {store.openWithoutSaving ? "[x]" : "[ ]"}
          </text>
          <text fg={store.active === "openWithoutSaving" ? theme.primary : theme.text}>Open without saving</text>
        </box>
      </box>
      <Show when={store.active !== "filename"}>
        <text fg={theme.textMuted} paddingBottom={1}>
          Press <span style={{ fg: theme.text }}>space</span> to toggle, <span style={{ fg: theme.text }}>return</span>{" "}
          to confirm
        </text>
      </Show>
      <Show when={store.active === "filename"}>
        <text fg={theme.textMuted} paddingBottom={1}>
          Press <span style={{ fg: theme.text }}>return</span> to confirm, <span style={{ fg: theme.text }}>tab</span>{" "}
          for options
        </text>
      </Show>
    </box>
  )
}

DialogExportOptions.show = (
  dialog: DialogContext,
  defaultFilename: string,
  defaultThinking: boolean,
  defaultToolDetails: boolean,
  defaultAssistantMetadata: boolean,
  defaultOpenWithoutSaving: boolean,
): Promise<Option.Option<ExportOptions>> => {
  // The dialog settles once: with the confirmed options, or with none when it is cancelled or closed.
  return Effect.runPromise(
    Effect.callback<Option.Option<ExportOptions>>((resume) => {
      dialog.replace(
        () => (
          <DialogExportOptions
            defaultFilename={defaultFilename}
            defaultThinking={defaultThinking}
            defaultToolDetails={defaultToolDetails}
            defaultAssistantMetadata={defaultAssistantMetadata}
            defaultOpenWithoutSaving={defaultOpenWithoutSaving}
            onConfirm={(options) => resume(Effect.succeed(Option.some(options)))}
            onCancel={() => resume(Effect.succeed(Option.none()))}
          />
        ),
        () => resume(Effect.succeed(Option.none())),
      )
    }),
  )
}
