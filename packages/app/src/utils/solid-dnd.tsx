import { Option, Predicate } from "effect"
import { useDragDropContext } from "@thisbeyond/solid-dnd"
import type { Transformer } from "@thisbeyond/solid-dnd"
import { createRoot, onCleanup, type JSXElement } from "solid-js"

type DragEvent = { draggable?: { id?: unknown } }

const isDragEvent = (event: unknown): event is DragEvent => Predicate.isObjectOrArray(event) && "draggable" in event

/** The string id of the dragged item, when the event carries one. */
const draggableId = (event: unknown): Option.Option<string> =>
  Option.some(event).pipe(
    Option.filter(isDragEvent),
    Option.flatMap((drag) => Option.fromNullishOr(drag.draggable)),
    Option.map((draggable) => draggable.id),
    Option.filter(Predicate.isString),
  )

export const getDraggableId = (event: unknown): string | undefined => Option.getOrUndefined(draggableId(event))

const createTransformer = (id: string, axis: "x" | "y"): Transformer => ({
  id,
  order: 100,
  callback: (transform) => (axis === "x" ? { ...transform, x: 0 } : { ...transform, y: 0 }),
})

const createAxisConstraint = (axis: "x" | "y", transformerId: string) => (): JSXElement => {
  const context = useDragDropContext()
  if (!context) return undefined
  const [, actions] = context
  const transformer = createTransformer(transformerId, axis)
  const dispose = createRoot((dispose) => {
    actions.onDragStart((event) => {
      const id = draggableId(event)
      if (Option.isSome(id) && id.value) actions.addTransformer("draggables", id.value, transformer)
    })
    actions.onDragEnd((event) => {
      const id = draggableId(event)
      if (Option.isSome(id) && id.value) actions.removeTransformer("draggables", id.value, transformer.id)
    })
    return dispose
  })
  onCleanup(dispose)
  return undefined
}

export const ConstrainDragXAxis = createAxisConstraint("x", "constrain-x-axis")

export const ConstrainDragYAxis = createAxisConstraint("y", "constrain-y-axis")
