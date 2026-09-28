import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { Clock, Effect, Schedule } from "effect"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Card } from "@opencode-ai/ui/card"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Spinner } from "@opencode-ai/ui/spinner"
import { createFiberSlot } from "./fiber-slot"

type RetryStatus = Extract<SessionStatus, { type: "retry" }>

export function SessionRetry(props: { status: SessionStatus; show?: boolean }) {
  const i18n = useI18n()
  const retry = createMemo((): RetryStatus | undefined => {
    if (props.status.type !== "retry") return undefined
    return props.status
  })
  const [seconds, setSeconds] = createSignal(0)
  const update = Effect.gen(function* () {
    const next = retry()?.next
    if (!next) return
    const now = yield* Clock.currentTimeMillis
    setSeconds(Math.round((next - now) / 1000))
  })
  // The first update runs at once, then once each second, as update() plus setInterval did.
  const countdown = createFiberSlot()
  createEffect(
    on(retry, (current) => {
      if (!current) {
        countdown.interrupt()
        return
      }
      countdown.run(update.pipe(Effect.repeat(Schedule.spaced("1 second"))))
    }),
  )
  const message = createMemo(() => {
    const current = retry()
    if (!current) return ""
    if (current.message.includes("exceeded your current quota") && current.message.includes("gemini")) {
      return i18n.t("ui.sessionTurn.retry.geminiHot")
    }
    if (current.message.length > 80) return current.message.slice(0, 80) + "..."
    return current.message
  })
  const truncated = createMemo(() => {
    const current = retry()
    if (!current) return false
    return current.message.length > 80
  })
  const info = createMemo(() => {
    const current = retry()
    if (!current) return ""
    const count = Math.max(0, seconds())
    const delay = count > 0 ? i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: count }) : ""
    const retrying = i18n.t("ui.sessionTurn.retry.retrying")
    const line = [retrying, delay].filter(Boolean).join(" ")
    if (!line) return i18n.t("ui.sessionTurn.retry.attempt", { attempt: current.attempt })
    return i18n.t("ui.sessionTurn.retry.attemptLine", { line, attempt: current.attempt })
  })

  return (
    <Show when={retry() && (props.show ?? true)}>
      <div data-slot="session-turn-retry">
        <Card variant="error" class="error-card">
          <div class="flex items-start gap-2">
            <Spinner class="size-4 mt-0.5" />
            <div class="min-w-0">
              <Show when={truncated()} fallback={<div data-slot="session-turn-retry-message">{message()}</div>}>
                <Tooltip value={retry()?.message ?? ""} placement="top">
                  <div data-slot="session-turn-retry-message" class="cursor-help truncate">
                    {message()}
                  </div>
                </Tooltip>
              </Show>
              <Show when={info()}>{(line) => <div data-slot="session-turn-retry-info">{line()}</div>}</Show>
            </div>
          </div>
        </Card>
      </div>
    </Show>
  )
}
