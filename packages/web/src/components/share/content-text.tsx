import style from "./content-text.module.css"
import { createSignal } from "solid-js"
import { createOverflow, useShareMessages } from "./common"
import { CopyButton } from "./copy-button"

interface Props {
  text: string
  expand?: boolean
  compact?: boolean
}
export function ContentText(props: Props) {
  const [expanded, setExpanded] = createSignal(false)
  const overflow = createOverflow()
  const messages = useShareMessages()

  return (
    <div
      class={style.root}
      {...(expanded() || props.expand === true ? { "data-expanded": true } : {})}
      {...(props.compact === true ? { "data-compact": true } : {})}
    >
      <pre data-slot="text" ref={overflow.ref}>
        {props.text}
      </pre>
      {((!props.expand && overflow.status) || expanded()) && (
        <button
          type="button"
          data-component="text-button"
          data-slot="expand-button"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded() ? messages.show_less : messages.show_more}
        </button>
      )}
      <CopyButton text={props.text} />
    </div>
  )
}
