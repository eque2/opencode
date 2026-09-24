import { Option } from "effect"
import { type ComponentProps, splitProps, Show } from "solid-js"

const segmenter: Option.Option<Intl.Segmenter> =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? // ECMA-402 defaults to the runtime default locale and to "grapheme" granularity.
      Option.some(new Intl.Segmenter())
    : Option.none()

function first(value: string) {
  if (!value) return ""
  if (Option.isNone(segmenter)) return Array.from(value)[0] ?? ""
  return segmenter.value.segment(value)[Symbol.iterator]().next().value?.segment ?? Array.from(value)[0] ?? ""
}

export interface AvatarProps extends ComponentProps<"div"> {
  fallback: string
  src?: string
  background?: string
  foreground?: string
  size?: "small" | "normal" | "large"
}

export function Avatar(props: AvatarProps) {
  const [split, rest] = splitProps(props, [
    "fallback",
    "src",
    "background",
    "foreground",
    "size",
    "class",
    "classList",
    "style",
  ])
  const src = split.src // did this so i can zero it out to test fallback
  return (
    <div
      {...rest}
      data-component="avatar"
      data-size={split.size || "normal"}
      bool:data-has-image={!!src}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      style={{
        ...(typeof split.style === "object" ? split.style : {}),
        ...(!src && split.background ? { "--avatar-bg": split.background } : {}),
        ...(!src && split.foreground ? { "--avatar-fg": split.foreground } : {}),
      }}
    >
      <Show when={src} fallback={first(split.fallback)}>
        {(src) => <img src={src()} draggable={false} data-slot="avatar-image" />}
      </Show>
    </div>
  )
}
