import { Option } from "effect"
import { Component, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

type PromptDragOverlayProps = {
  type: Option.Option<"image" | "@mention">
  label: string
}

const kindToIcon = {
  image: "photo",
  "@mention": "link",
} as const

export const PromptDragOverlay: Component<PromptDragOverlayProps> = (props) => {
  return (
    <Show when={Option.isSome(props.type)}>
      <div class="absolute inset-0 z-10 flex items-center justify-center bg-surface-raised-stronger-non-alpha/90 pointer-events-none">
        <div class="flex flex-col items-center gap-2 text-text-weak">
          <Icon
            name={Option.match(props.type, { onNone: () => kindToIcon.image, onSome: (type) => kindToIcon[type] })}
            class="size-8"
          />
          <span class="text-14-regular">{props.label}</span>
        </div>
      </div>
    </Show>
  )
}
