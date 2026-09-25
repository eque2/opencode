import { describe, expect, test } from "bun:test"
import type { Session, TextPart, UserMessage } from "@opencode-ai/sdk/v2/client"
import { Data, Effect } from "effect"
import {
  fetchSessionExport,
  sessionExportFailureCause,
  sessionExportFilename,
  SessionExportMissingError,
  type SessionExportClient,
} from "./session-export"

class RequestFailure extends Data.TaggedError("RequestFailure")<{ readonly message: string }> {}

const session: Session = {
  id: "ses_1",
  slug: "test-session",
  projectID: "prj_1",
  directory: "/repo",
  title: "Test Session",
  version: "1",
  time: { created: 1, updated: 1 },
}

const msg: UserMessage = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "openai", modelID: "gpt-4.1" },
}

const part: TextPart = { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hello" }

describe("sessionExportFilename", () => {
  test("generates filename from title", () => {
    expect(sessionExportFilename({ id: "ses_123", title: "Clone PR in worktree from fork" })).toBe(
      "clone-pr-in-worktree-from-fork.json",
    )
  })

  test("generates filename from slug when title missing", () => {
    expect(sessionExportFilename({ id: "ses_123", slug: "my-session-slug" })).toBe("my-session-slug.json")
  })

  test("falls back to id when title and slug are empty", () => {
    expect(sessionExportFilename({ id: "ses_123" })).toBe("ses_123.json")
  })
})

describe("fetchSessionExport", () => {
  test("fetches full transcript from client", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const messages = [{ info: msg, parts: [part] }]

        const client: SessionExportClient = {
          session: {
            get: () => Effect.runPromise(Effect.succeed({ data: session })),
            messages: () => Effect.runPromise(Effect.succeed({ data: messages })),
          },
        }

        const result = yield* fetchSessionExport({
          sessionID: "ses_1",
          client,
        })

        expect(result).toEqual({
          info: session,
          messages,
        })
      }),
    ))

  test("fails when session not found", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const client: SessionExportClient = {
          session: {
            get: () => Effect.runPromise(Effect.succeed({})),
            messages: () => Effect.runPromise(Effect.succeed({ data: [] })),
          },
        }

        const error = yield* Effect.flip(
          fetchSessionExport({
            sessionID: "ses_missing",
            client,
          }),
        )

        expect(error).toBeInstanceOf(SessionExportMissingError)
        expect(error.message).toBe("Session not found: ses_missing")
        expect(sessionExportFailureCause(error)).toBe(error)
      }),
    ))

  test("keeps a rejected request as the failure cause", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rejection = new RequestFailure({ message: "offline" })
        const client: SessionExportClient = {
          session: {
            get: () => Effect.runPromise(Effect.fail(rejection)),
            messages: () => Effect.runPromise(Effect.succeed({ data: [] })),
          },
        }

        const error = yield* Effect.flip(
          fetchSessionExport({
            sessionID: "ses_1",
            client,
          }),
        )

        expect(sessionExportFailureCause(error)).toBe(rejection)
      }),
    ))
})
