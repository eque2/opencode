import { expect, test } from "bun:test"
import { mockOpenCodeServer, type MockPage, type MockRoute } from "../../utils/mock-server"

test("applies message latency after a list response gate is released", async () => {
  const events: string[] = []
  const gate = Promise.withResolvers<void>()
  let handler: ((route: MockRoute) => Promise<void>) | undefined
  const page: MockPage = {
    route: (_url, callback) => {
      handler = callback
      return Promise.resolve()
    },
  }
  await mockOpenCodeServer(page, {
    provider: {},
    directory: "C:/OpenCode",
    project: {},
    sessions: [{ id: "session" }],
    messageDelay: 25,
    beforeMessagesResponse: () => {
      events.push("before")
      return gate.promise
    },
    onMessages: (request) => events.push(request.phase),
    pageMessages: () => {
      events.push("page")
      return { items: [] }
    },
  })

  const response = handler!({
    request: () => ({
      url: () => "http://127.0.0.1:4096/session/session/message",
      method: () => "GET",
      postDataJSON: () => undefined,
    }),
    fulfill: () => {
      events.push("fulfill")
      return Promise.resolve()
    },
    fallback: () => Promise.resolve(),
  })
  expect(events).toEqual(["start", "before"])

  const released = performance.now()
  gate.resolve()
  await response
  expect(performance.now() - released).toBeGreaterThanOrEqual(20)
  expect(events).toEqual(["start", "before", "page", "end", "fulfill"])
})
