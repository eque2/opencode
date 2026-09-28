import style from "./content-error.module.css"
import { type JSX, createSignal } from "solid-js"
import { createOverflow, useShareMessages } from "./common"

interface Props extends JSX.HTMLAttributes<HTMLDivElement> {
  expand?: boolean
}
export function ContentError(props: Props) {
  const [expanded, setExpanded] = createSignal(false)
  const overflow = createOverflow()
  const messages = useShareMessages()

  return (
    <div class={style.root} {...(expanded() || props.expand === true ? { "data-expanded": true } : {})}>
      <div data-section="content" ref={overflow.ref}>
        {props.children}
      </div>
      {((!props.expand && overflow.status) || expanded()) && (
        <button type="button" data-element-button-text onClick={() => setExpanded((e) => !e)}>
          {expanded() ? messages.show_less : messages.show_more}
        </button>
      )}
    </div>
  )
}
