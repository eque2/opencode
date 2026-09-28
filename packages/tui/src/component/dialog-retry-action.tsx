import { RGBA, TextAttributes } from "@opentui/core"
import open from "open"
import { createSignal, Show } from "solid-js"
import { Effect, Option } from "effect"
import { selectedForeground, useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { Link } from "../ui/link"
import { BgPulse } from "./bg-pulse"
import { useBindings } from "../keymap"

const GO_URL = "https://opencode.ai/go"
const PAD_X = 3
const PAD_TOP_OUTER = 1
const FOREGROUND_ALPHA = 186

export type DialogRetryActionProps = {
  title: string
  message: string
  label: string
  link?: string
  onClose?: (dontShowAgain?: boolean) => void
}

function runAction(props: DialogRetryActionProps, dialog: ReturnType<typeof useDialog>) {
  if (props.link) open(props.link).catch(() => {})
  props.onClose?.()
  dialog.clear()
}

function dismiss(props: DialogRetryActionProps, dialog: ReturnType<typeof useDialog>) {
  props.onClose?.(true)
  dialog.clear()
}

function panelOverlay(color: RGBA) {
  const [r, g, b] = color.toInts()
  return RGBA.fromInts(r, g, b, FOREGROUND_ALPHA)
}

export function DialogRetryAction(props: DialogRetryActionProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const showGoTreatment = () => props.link === GO_URL
  // Text over the Go pulse gets a translucent panel background; other text has none.
  const textBg = () => (showGoTreatment() ? Option.some(panelOverlay(theme.backgroundPanel)) : Option.none())
  const [selected, setSelected] = createSignal<"dismiss" | "action">("action")

  useBindings(() => ({
    bindings: [
      {
        key: "left",
        desc: "Previous retry option",
        group: "Dialog",
        cmd: () => setSelected((value) => (value === "action" ? "dismiss" : "action")),
      },
      {
        key: "right",
        desc: "Next retry option",
        group: "Dialog",
        cmd: () => setSelected((value) => (value === "action" ? "dismiss" : "action")),
      },
      {
        key: "tab",
        desc: "Next retry option",
        group: "Dialog",
        cmd: () => setSelected((value) => (value === "action" ? "dismiss" : "action")),
      },
      {
        key: "return",
        desc: "Confirm retry option",
        group: "Dialog",
        cmd: () => {
          if (selected() === "action") runAction(props, dialog)
          else dismiss(props, dialog)
        },
      },
    ],
  }))

  return (
    <box>
      <Show when={showGoTreatment()}>
        <box position="absolute" top={-PAD_TOP_OUTER} left={0} right={0} bottom={0} zIndex={0}>
          <BgPulse />
        </box>
      </Show>
      <box zIndex={1} paddingLeft={PAD_X} paddingRight={PAD_X} paddingBottom={1} gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme.text} bg={Option.getOrUndefined(textBg())}>
            {props.title}
          </text>
          <text fg={theme.textMuted} bg={Option.getOrUndefined(textBg())} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <box gap={0}>
          <text fg={theme.textMuted} bg={Option.getOrUndefined(textBg())}>
            {props.message}
          </text>
        </box>
        {props.link ? (
          showGoTreatment() ? (
            <box alignItems="center" justifyContent="flex-end" height={7} paddingBottom={1}>
              <Link href={props.link} fg={theme.primary} bg={Option.getOrUndefined(textBg())} wrapMode="none" />
            </box>
          ) : (
            <box width="100%" flexDirection="row" justifyContent="center" paddingBottom={1}>
              <Link href={props.link} fg={theme.primary} wrapMode="none" />
            </box>
          )
        ) : (
          <box paddingBottom={1} />
        )}
        <box flexDirection="row" justifyContent="space-between">
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={selected() === "dismiss" ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
            onMouseOver={() => setSelected("dismiss")}
            onMouseUp={() => dismiss(props, dialog)}
          >
            <text
              fg={selected() === "dismiss" ? fg : theme.textMuted}
              bg={Option.getOrUndefined(Option.filter(textBg(), () => selected() !== "dismiss"))}
              attributes={selected() === "dismiss" ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              don't show again
            </text>
          </box>
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={selected() === "action" ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
            onMouseOver={() => setSelected("action")}
            onMouseUp={() => runAction(props, dialog)}
          >
            <text
              fg={selected() === "action" ? fg : theme.text}
              bg={Option.getOrUndefined(Option.filter(textBg(), () => selected() !== "action"))}
              attributes={selected() === "action" ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {props.label}
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

DialogRetryAction.show = (
  dialog: DialogContext,
  props: Pick<DialogRetryActionProps, "title" | "message" | "label" | "link">,
): Promise<boolean> => {
  // The dialog settles once with "don't show again"; closing it any other way settles with false.
  return Effect.runPromise(
    Effect.callback<boolean>((resume) => {
      dialog.replace(
        () => <DialogRetryAction {...props} onClose={(dontShow) => resume(Effect.succeed(dontShow ?? false))} />,
        () => resume(Effect.succeed(false)),
      )
    }),
  )
}
