import { Option } from "effect"
import { type ContextItem, type Prompt, type usePrompt } from "@/context/prompt"

type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>

export function createPromptSubmissionState(input: {
  target: PromptTarget
  prompt: Prompt
  context: (ContextItem & { key: string })[]
}) {
  const initial = input.target
  let target = input.target
  let cleared = Option.none<Prompt>()

  return {
    prompt: input.prompt,
    context: input.context,
    target: () => target,
    clear() {
      if (initial !== target) initial.reset()
      target.reset()
      cleared = Option.some(target.current())
    },
    retarget(next: PromptTarget) {
      input.context.forEach((item) => next.context.add(item))
      target = next
    },
    current: (value: PromptTarget) => target === value,
    /** The submission to restore, or none when the prompt changed after the submission cleared it. */
    restore() {
      if (Option.exists(cleared, (prompt) => target.current() !== prompt)) return Option.none()
      return Option.some({ target, prompt: input.prompt, context: input.context })
    },
  }
}
