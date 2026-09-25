import { Effect } from "effect"
import { createStore } from "solid-js/store"
import { Show, type Accessor } from "solid-js"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { createFiberSlot } from "@/utils/fiber-slot"
import { nextFrame } from "@/utils/next-frame"

export function createInlineEditorController() {
  // This controller intentionally supports one active inline editor at a time.
  const [editor, setEditor] = createStore({
    active: "" as string,
    value: "",
  })

  const editorOpen = (id: string) => editor.active === id
  const editorValue = () => editor.value
  const openEditor = (id: string, value: string) => {
    if (!id) return
    setEditor({ active: id, value })
  }
  const closeEditor = () => setEditor({ active: "", value: "" })

  const saveEditor = (callback: (next: string) => void) => {
    const next = editor.value.trim()
    if (!next) {
      closeEditor()
      return
    }
    closeEditor()
    callback(next)
  }

  const editorKeyDown = (event: KeyboardEvent, callback: (next: string) => void) => {
    if (event.key === "Enter") {
      event.preventDefault()
      saveEditor(callback)
      return
    }
    if (event.key !== "Escape") return
    event.preventDefault()
    closeEditor()
  }

  const InlineEditor = (props: {
    id: string
    value: Accessor<string>
    onSave: (next: string) => void
    class?: string
    displayClass?: string
    editing?: boolean
    stopPropagation?: boolean
    openOnDblClick?: boolean
  }) => {
    // The owner's cleanup interrupts the slot, which cancels a pending focus frame.
    const focusFrame = createFiberSlot()

    const isEditing = () => props.editing ?? editorOpen(props.id)
    const stopEvents = () => props.stopPropagation ?? false
    const allowDblClick = () => props.openOnDblClick ?? true
    const stopPropagation = (event: Event) => {
      if (!stopEvents()) return
      event.stopPropagation()
    }
    const handleDblClick = (event: MouseEvent) => {
      if (!allowDblClick()) return
      stopPropagation(event)
      openEditor(props.id, props.value())
    }

    return (
      <Show
        when={isEditing()}
        fallback={
          <span
            class={props.displayClass ?? props.class}
            onDblClick={handleDblClick}
            onPointerDown={stopPropagation}
            onMouseDown={stopPropagation}
            onClick={stopPropagation}
            onTouchStart={stopPropagation}
          >
            {props.value()}
          </span>
        }
      >
        <InlineInput
          ref={(el) => {
            // run() interrupts the pending frame first, so only the newest input takes focus.
            focusFrame.run(
              nextFrame.pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (el.isConnected) el.focus()
                  }),
                ),
              ),
            )
          }}
          value={editorValue()}
          class={props.class}
          onInput={(event) => setEditor("value", event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            editorKeyDown(event, props.onSave)
          }}
          onBlur={closeEditor}
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
          onDblClick={stopPropagation}
          onMouseDown={stopPropagation}
          onMouseUp={stopPropagation}
          onTouchStart={stopPropagation}
        />
      </Show>
    )
  }

  return {
    editor,
    editorOpen,
    editorValue,
    openEditor,
    closeEditor,
    saveEditor,
    editorKeyDown,
    setEditor,
    InlineEditor,
  }
}
