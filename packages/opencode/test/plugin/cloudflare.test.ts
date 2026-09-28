import { expect, test } from "bun:test"
import { CloudflareAIGatewayAuthPlugin } from "@/plugin/cloudflare"

test("registers the cloudflare-ai-gateway auth method", async () => {
  const hooks = await CloudflareAIGatewayAuthPlugin()
  expect(hooks.auth?.provider).toBe("cloudflare-ai-gateway")
  expect(hooks.auth?.methods).toHaveLength(1)
})

test("no longer drops maxOutputTokens; OpenAI models ride the Responses API passthrough", async () => {
  const hooks = await CloudflareAIGatewayAuthPlugin()
  expect(hooks["chat.params"]).toBeUndefined()
})
