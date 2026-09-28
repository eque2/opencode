import { Effect, Fiber, Option } from "effect"
import { createSignal, onCleanup } from "solid-js"
import { IconClipboard, IconCheckCircle } from "../icons"
import { useShareMessages } from "./common"
import styles from "./copy-button.module.css"

interface CopyButtonProps {
  text: string
}

export function CopyButton(props: CopyButtonProps) {
  const [copied, setCopied] = createSignal(false)
  const messages = useShareMessages()
  // The pending reset fiber is interrupted on a new click and when the component unmounts.
  let reset = Option.none<Fiber.Fiber<void>>()
  const interruptReset = () => {
    if (Option.isSome(reset)) Effect.runFork(Fiber.interrupt(reset.value))
  }
  onCleanup(interruptReset)

  function handleCopyClick() {
    if (props.text) {
      const text = props.text
      Effect.runFork(
        Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
          Effect.catch((err) => Effect.logError("Copy failed", err)),
        ),
      )

      setCopied(true)
      interruptReset()
      reset = Option.some(
        Effect.runFork(Effect.sleep("2 seconds").pipe(Effect.andThen(Effect.sync(() => setCopied(false))))),
      )
    }
  }

  return (
    <div data-component="copy-button" class={styles.root}>
      <button
        type="button"
        onClick={handleCopyClick}
        {...(copied() ? { "data-copied": true } : {})}
        aria-label={copied() ? messages.copied : messages.copy}
        title={copied() ? messages.copied : messages.copy}
      >
        {copied() ? <IconCheckCircle width={16} height={16} /> : <IconClipboard width={16} height={16} />}
      </button>
    </div>
  )
}
