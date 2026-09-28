import { expect, spyOn, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { CopilotAuthPlugin } from "@/plugin/github-copilot/copilot"
import { chatInput, chatModel } from "./chat-hook.fixture"

// A declared Promise<never> return keeps a stubbed SDK call from inferring the response type.
function rejected(reason: unknown): Promise<never> {
  return Promise.reject(reason)
}

async function hook() {
  const client = createOpencodeClient({ baseUrl: "http://localhost" })
  // Neither lookup finds a compaction part or a parent session, so the initiator stays unset.
  spyOn(client.session, "message").mockImplementation(() => rejected(new Error("no message fixture")))
  spyOn(client.session, "get").mockImplementation(() => rejected(new Error("no session fixture")))
  const hooks = await CopilotAuthPlugin({ client, directory: "" })
  return hooks["chat.headers"]!
}

function input(sessionID: string, providerID: string, npm: string) {
  return chatInput({ sessionID, model: chatModel({ providerID, npm }) })
}

test.each([
  ["github-copilot", "@ai-sdk/github-copilot"],
  ["github-copilot", "@ai-sdk/anthropic"],
  ["github-copilot-enterprise", "@ai-sdk/github-copilot"],
  ["github-copilot-enterprise", "@ai-sdk/anthropic"],
])("uses the session ID for %s interaction headers with %s", async (providerID, npm) => {
  const headers = await hook()
  for (const sessionID of ["ses_one", "ses_one", "ses_two"]) {
    const output = { headers: { "x-existing": "preserved" } }
    await headers(input(sessionID, providerID, npm), output)
    expect(output.headers).toMatchObject({
      "X-Interaction-Id": sessionID,
      "x-existing": "preserved",
    })
  }
})

test("does not add interaction headers to other providers", async () => {
  const headers = await hook()
  const output = { headers: { "x-existing": "preserved" } }
  await headers(input("ses_one", "openai", "@ai-sdk/openai"), output)
  expect(output.headers).toEqual({ "x-existing": "preserved" })
})
