import { Effect } from "effect"

/** Completes on the next animation frame. Interrupting it cancels the frame request. */
export const nextFrame = Effect.callback<void>((resume) => {
  const handle = requestAnimationFrame(() => resume(Effect.void))
  return Effect.sync(() => cancelAnimationFrame(handle))
})
