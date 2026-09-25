import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { Data, Effect } from "effect"
import { isTimelineReady, loadOlderTimeline, selectUserMessages, selectVisibleUserMessages } from "./model"

/** The rejection of a history page load in the failure test. */
class HistoryLoadError extends Data.TaggedError("HistoryLoadError")<{ readonly message: string }> {}

const user = (id: string) => ({ id, role: "user" }) as UserMessage
const assistant = (id: string) => ({ id, role: "assistant" }) as AssistantMessage

describe("timeline model", () => {
  test("selects users and applies the revert boundary", () => {
    const messages: Message[] = [user("msg_z"), assistant("msg_a"), user("msg_b"), user("msg_c")]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_c"])
    expect(selectVisibleUserMessages(users, "msg_b").map((message) => message.id)).toEqual(["msg_z"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })

  test("waits for an assistant-only load to hydrate its user root", () => {
    expect(isTimelineReady([assistant("msg_2")], true)).toBe(false)
    expect(isTimelineReady([user("msg_1"), assistant("msg_2")], true)).toBe(true)
    expect(isTimelineReady([], false)).toBe(true)
  })

  test("loads exactly one opaque cursor page", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0
        let anchors: Array<string | boolean> = []

        yield* loadOlderTimeline({
          sessionID: () => "ses_test",
          more: () => true,
          loading: () => false,
          loadMore: () =>
            Effect.runPromise(
              Effect.sync(() => {
                calls += 1
              }),
            ),
          before: () => {
            anchors = [...anchors, "before"]
          },
          after: (done) => {
            anchors = [...anchors, "after", done]
          },
        })

        expect(calls).toBe(1)
        expect(anchors).toEqual(["before", "after", true])
      }),
    ))

  test("stops when a page adds no raw messages", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0
        yield* loadOlderTimeline({
          sessionID: () => "ses_test",
          more: () => true,
          loading: () => false,
          loadMore: () =>
            Effect.runPromise(
              Effect.sync(() => {
                calls += 1
              }),
            ),
        })

        expect(calls).toBe(1)
      }),
    ))

  test("does not restore an anchor after the session changes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let sessionID = "ses_old"
        let restore = 0

        yield* loadOlderTimeline({
          sessionID: () => sessionID,
          more: () => true,
          loading: () => false,
          loadMore: () =>
            Effect.runPromise(
              Effect.sync(() => {
                sessionID = "ses_new"
              }),
            ),
          after: () => {
            restore += 1
          },
        })

        expect(restore).toBe(0)
      }),
    ))

  test("releases the anchor when loading history fails", () => {
    let restore = 0

    // The rejects matcher of bun:test waits for the promise before it returns.
    expect(
      Effect.runPromise(
        loadOlderTimeline({
          sessionID: () => "ses_test",
          more: () => true,
          loading: () => false,
          loadMore: () => Effect.runPromise(Effect.fail(new HistoryLoadError({ message: "history failed" }))),
          after: () => {
            restore += 1
          },
        }),
      ),
    ).rejects.toThrow("history failed")

    expect(restore).toBe(1)
  })
})
