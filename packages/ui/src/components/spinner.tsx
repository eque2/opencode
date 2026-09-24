import { HashSet, Random } from "effect"
import { ComponentProps, For } from "solid-js"

// Module setup runs outside any fiber, so the delays come straight from the default Random service.
const random = Random.Random.defaultValue()
const outerIndices = HashSet.fromIterable([1, 2, 4, 7, 8, 11, 13, 14])
const cornerIndices = HashSet.fromIterable([0, 3, 12, 15])
const squares = Array.from({ length: 16 }, (_, i) => ({
  id: i,
  x: (i % 4) * 4,
  y: Math.floor(i / 4) * 4,
  delay: random.nextDoubleUnsafe() * 1.5,
  duration: 1 + random.nextDoubleUnsafe() * 1,
  outer: HashSet.has(outerIndices, i),
  corner: HashSet.has(cornerIndices, i),
})).map((square) => ({
  ...square,
  style: square.corner
    ? { opacity: 0 }
    : {
        animation: `${square.outer ? "pulse-opacity-dim" : "pulse-opacity"} ${square.duration}s ease-in-out infinite`,
        "animation-fill-mode": "both",
        "animation-delay": `${square.delay}s`,
      },
}))

export function Spinner(props: {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
}) {
  return (
    <svg
      {...props}
      viewBox="0 0 15 15"
      data-component="spinner"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
      fill="currentColor"
    >
      <For each={squares}>
        {(square) => (
          <rect
            x={square.x}
            y={square.y}
            width="3"
            height="3"
            rx="1"
            style={square.style}
          />
        )}
      </For>
    </svg>
  )
}
