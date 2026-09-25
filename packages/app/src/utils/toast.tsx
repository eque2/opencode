import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import {
  Toast,
  showToast as showLegacyToast,
  toaster as legacyToaster,
  type ToastOptions,
  type ToastVariant,
} from "@opencode-ai/ui/toast"
import { ToastV2, showToastV2, toasterV2 } from "@opencode-ai/ui/v2/toast-v2"
import { Option } from "effect"
import type { JSX } from "solid-js"

let v2 = false

export function setV2Toast(value: boolean) {
  v2 = value
}

export function ToastRegion(props: { v2: boolean }) {
  if (props.v2) return <ToastV2.Region />
  return <Toast.Region />
}

export function showToast(options: ToastOptions | string) {
  if (!v2) return showLegacyToast(options)
  if (typeof options === "string") return showToastV2(options)

  // The v1 icon is an icon name; the v2 toast takes an element, and leaves the slot out without one.
  const { icon, ...rest } = options
  return showToastV2({
    ...rest,
    ...Option.match(resolveIcon(icon, options.variant), {
      onNone: () => ({}),
      onSome: (element) => ({ icon: element }),
    }),
    actions: options.actions?.map((action) => ({
      ...action,
      variant: action.onClick === "dismiss" ? "secondary" : "primary",
    })),
  })
}

// v1 and v2 ids come from separate registries, so dismissal has to use the same
// implementation that issued the id.
export function dismissToast(toastId: number) {
  if (!v2) return legacyToaster.dismiss(toastId)
  return toasterV2.dismiss(toastId)
}

function resolveIcon(icon: IconProps["name"] | undefined, variant: ToastVariant | undefined): Option.Option<JSX.Element> {
  return Option.fromNullishOr(icon).pipe(
    Option.orElse(() => (variant === "success" ? Option.some<IconProps["name"]>("check") : Option.none())),
    Option.map((name) => <Icon name={name} />),
  )
}
