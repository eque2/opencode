import { Component, createMemo } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { showToast } from "@/utils/toast"
import { extractPromptFromParts } from "@/utils/prompt"
import type { TextPart as SDKTextPart } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useLanguage } from "@/context/language"
import { Data, DateTime, Effect } from "effect"

interface ForkableMessage {
  id: string
  text: string
  time: string
}

/** A fork request, or the navigation after it, that failed. `message` is shown in the error toast. */
class ForkSessionError extends Data.TaggedError("App.ForkSessionError")<{
  readonly message: string
  readonly cause: unknown
}> {}

const toForkSessionError = (cause: unknown) =>
  new ForkSessionError({ message: cause instanceof Error ? cause.message : String(cause), cause })

/** Runs the fork in the background. A defect goes to the Effect logger. */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

/** Formats epoch millis as a short time in the user's locale and time zone, as toLocaleTimeString did. */
function formatTime(epochMillis: number): string {
  return DateTime.formatLocal(DateTime.makeUnsafe(epochMillis), { timeStyle: "short" })
}

export const DialogFork: Component = () => {
  const params = useParams()
  const navigate = useNavigate()
  const sync = useSync()
  const sdk = useSDK()
  const prompt = usePrompt()
  const dialog = useDialog()
  const language = useLanguage()

  const messages = createMemo((): ForkableMessage[] => {
    const sessionID = params.id
    if (!sessionID) return []

    const msgs = sync().data.message[sessionID] ?? []
    const result: ForkableMessage[] = []

    for (const message of msgs) {
      if (message.role !== "user") continue

      const parts = sync().data.part[message.id] ?? []
      const textPart = parts.find((x): x is SDKTextPart => x.type === "text" && !x.synthetic && !x.ignored)
      if (!textPart) continue

      result.push({
        id: message.id,
        text: textPart.text.replace(/\n/g, " ").slice(0, 200),
        time: formatTime(message.time.created),
      })
    }

    return result.reverse()
  })

  const handleSelect = (item: ForkableMessage | undefined) => {
    if (!item) return

    const sessionID = params.id
    if (!sessionID) return

    const parts = sync().data.part[item.id] ?? []
    const restored = extractPromptFromParts(parts, {
      directory: sdk().directory,
      attachmentName: language.t("common.attachment"),
    })
    const dir = base64Encode(sdk().directory)

    runDetached(
      Effect.tryPromise({
        try: () => sdk().api.session.fork({ sessionID, messageID: item.id }),
        catch: toForkSessionError,
      }).pipe(
        // The old .catch also covered a throw from these steps, so they fail with the same error.
        Effect.flatMap((forked) =>
          Effect.try({
            try: () => {
              dialog.close()
              prompt.set(restored, undefined, { dir, id: forked.id })
              navigate(`/${dir}/session/${forked.id}`)
            },
            catch: toForkSessionError,
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => showToast({ title: language.t("common.requestFailed"), description: error.message })),
        ),
      ),
    )
  }

  return (
    <Dialog title={language.t("command.session.fork")}>
      <List
        class="flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.fork.empty")}
        key={(x) => x.id}
        items={messages}
        filterKeys={["text"]}
        onSelect={handleSelect}
      >
        {(item) => (
          <div class="w-full flex items-center gap-2">
            <span class="truncate flex-1 min-w-0 text-left font-normal">{item.text}</span>
            <span class="text-text-weak shrink-0 font-normal">{item.time}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
