import { describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage } from "node:http"
import type { Provider } from "@opencode-ai/sdk"
import type { Auth, Model, Provider as ProviderV2 } from "@opencode-ai/sdk/v2"
import { Option } from "effect"
import { WebSocketServer } from "ws"
import {
  CodexAuthPlugin,
  CodexOrganizationId,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  extractResidency,
  renderOAuthError,
  type CodexAuthInput,
  type IdTokenClaims,
} from "../../src/plugin/openai/codex"

const input: CodexAuthInput = { client: { auth: { set: async () => {} } } }

const loaderProvider: Provider = {
  id: "openai",
  name: "OpenAI",
  source: "custom",
  env: [],
  options: {},
  models: {},
}

const apiAuth = async (): Promise<Auth> => ({ type: "api", key: "sk-test" })
const oauthContext: { auth: Auth } = { auth: { type: "oauth", refresh: "refresh", access: "access", expires: 0 } }
const apiContext: { auth: Auth } = { auth: { type: "api", key: "sk-test" } }

const defaultLimit: Model["limit"] = { context: 128_000, output: 16_000 }

function model(
  id: string,
  options: { apiID?: string; limit?: Model["limit"]; options?: Model["options"] } = {},
): Model {
  const flags = { text: true, audio: false, image: false, video: false, pdf: false }
  return {
    id,
    providerID: "openai",
    api: { id: options.apiID ?? id, url: "", npm: "" },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: flags,
      output: flags,
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: options.limit ?? defaultLimit,
    status: "active",
    options: options.options ?? {},
    headers: {},
    release_date: "",
  }
}

function modelsProvider(models: Record<string, Model>): ProviderV2 {
  return { id: "openai", name: "OpenAI", source: "custom", env: [], options: {}, models }
}

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  test("escapes provider errors in callback HTML", () => {
    const error = `</div><script>alert("xss" & 'more')</script>`
    const html = renderOAuthError(error)

    expect(html).toContain("&lt;/div&gt;&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;more&#39;)&lt;/script&gt;")
    expect(html).not.toContain(error)
  })

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(Option.some(payload))
    })

    test("returns none for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toEqual(Option.none())
      expect(parseJwtClaims("only.two")).toEqual(Option.none())
    })

    test("returns none for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toEqual(Option.none())
    })

    test("returns none for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toEqual(Option.none())
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: CodexOrganizationId.make("org-123") }, { id: CodexOrganizationId.make("org-456") }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toEqual(Option.some("from-id-token"))
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toEqual(Option.some("from-access"))
    })

    test("returns none when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toEqual(Option.none())
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toEqual(Option.some("acc-123"))
    })
  })

  describe("extractResidency", () => {
    test("extracts compute residency from the namespaced auth claims", () => {
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" },
          }),
        ),
      ).toEqual(Option.some("eu"))
    })

    test("falls back to a root compute residency claim", () => {
      expect(extractResidency(createTestJwt({ chatgpt_compute_residency: "us" }))).toEqual(Option.some("us"))
    })

    test("supports compute residency values without maintaining a region list", () => {
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "ae" },
          }),
        ),
      ).toEqual(Option.some("ae"))
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "future-region_1" },
          }),
        ),
      ).toEqual(Option.some("future-region_1"))
    })

    test("ignores unconstrained and data residency values", () => {
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "no_constraint" },
          }),
        ),
      ).toEqual(Option.none())
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_data_residency: "gb" },
          }),
        ),
      ).toEqual(Option.none())
      expect(extractResidency(createTestJwt({ chatgpt_compute_residency: "" }))).toEqual(Option.none())
      expect(extractResidency("not-a-jwt")).toEqual(Option.none())
    })

    test("prefers a namespaced unconstrained value over a root residency", () => {
      expect(
        extractResidency(
          createTestJwt({
            chatgpt_compute_residency: "eu",
            "https://api.openai.com/auth": { chatgpt_compute_residency: "no_constraint" },
          }),
        ),
      ).toEqual(Option.none())
    })
  })

  test("installs websocket transport only when experimental websockets are enabled", async () => {
    const disabled = await CodexAuthPlugin(input)
    const enabled = await CodexAuthPlugin(input, { experimentalWebSockets: true })

    const disabledOptions = await disabled.auth!.loader!(apiAuth, loaderProvider)
    const enabledOptions = await enabled.auth!.loader!(apiAuth, loaderProvider)

    expect(disabledOptions.fetch).toBeUndefined()
    expect(enabledOptions.fetch).toBeFunction()
    await enabled.dispose?.()
  })

  test("sends token residency only to the ChatGPT Codex backend", async () => {
    const requests: Array<{ path: string; residency: string | null }> = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          residency: request.headers.get("x-openai-internal-codex-residency"),
        })
        return new Response("{}")
      },
    })
    const hooks = await CodexAuthPlugin(input, {
      codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
    })
    const loaded = await hooks.auth!.loader!(
      async (): Promise<Auth> => ({
        type: "oauth",
        refresh: "refresh",
        access: createTestJwt({
          "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" },
        }),
        expires: Date.now() + 60_000,
      }),
      loaderProvider,
    )

    await loaded.fetch!("https://api.openai.com/v1/responses")
    await loaded.fetch!(new URL("/other", server.url))

    expect(requests).toEqual([
      { path: "/backend-api/codex/responses", residency: "eu" },
      { path: "/other", residency: null },
    ])
  })

  test("sends token residency through the WebSocket transport", async () => {
    await using server = await createCodexWebSocketServer()
    const hooks = await CodexAuthPlugin(input, {
      codexApiEndpoint: server.url,
      experimentalWebSockets: true,
    })
    const loaded = await hooks.auth!.loader!(
      async (): Promise<Auth> => ({
        type: "oauth",
        refresh: "refresh",
        access: createTestJwt({
          "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" },
        }),
        expires: Date.now() + 60_000,
      }),
      loaderProvider,
    )

    const response = await loaded.fetch!("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "session-id": "session-1" },
      body: JSON.stringify({ stream: true, input: "hi" }),
    })

    expect(await response.text()).toContain("data: [DONE]")
    expect(server.headers()?.["x-openai-internal-codex-residency"]).toBe("eu")
    await hooks.dispose?.()
  })

  test("filters unsupported modes and uses Codex context limits for OAuth GPT models", async () => {
    const hooks = await CodexAuthPlugin(input)
    const limit = { context: 1_050_000, input: 922_000, output: 128_000 }
    const provider = modelsProvider({
      ...Object.fromEntries(
        ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.7-pro"].map((id) => [
          id,
          model(id, { limit }),
        ]),
      ),
      "gpt-5.4-pro": model("gpt-5.4-pro", { apiID: "gpt-5.4", limit, options: { reasoningMode: "pro" } }),
      "gpt-5.6-sol-high": model("gpt-5.6-sol-high", {
        apiID: "gpt-5.6-sol",
        limit,
        options: { reasoningEffort: "high" },
      }),
    })

    const models = await hooks.provider!.models!(provider, oauthContext)

    expect(models["gpt-5.4"]?.limit).toEqual(limit)
    expect(models["gpt-5.5"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(models["gpt-5.6-sol"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(models["gpt-5.6-terra"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(models["gpt-5.6-luna"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(models["gpt-5.4-pro"]).toBeUndefined()
    expect(models["gpt-5.7-pro"]).toBeDefined()
    expect(models["gpt-5.6-sol-high"]).toBeDefined()
    expect(await hooks.provider!.models!(provider, apiContext)).toBe(provider.models)
  })

  test.each([
    ["gpt-6-astra", true],
    ["gpt-6", true],
    ["gpt-6.0-astra", true],
    ["gpt-7", true],
    ["gpt-10", true],
    ["gpt-5.5-astra", true],
    ["gpt-5.9", true],
    ["gpt-5.10", true],
    ["gpt-5.10-astra", true],
    ["gpt-5.40", true],
    ["gpt-5", false],
    ["gpt-5.4-astra", false],
    ["gpt-5.04-astra", false],
    ["gpt-4.1", false],
    ["gpt-4.99", false],
    ["gpt-5.5-pro", false],
    ["gpt-5.6", false],
    ["gpt-6garbage", true],
    ["gpt-6.", true],
    ["gpt-6.1.2", true],
    ["not-a-gpt-model", false],
  ])("filters OAuth model %s by GPT major and minor versions", async (id, allowed) => {
    const hooks = await CodexAuthPlugin(input)
    const provider = modelsProvider({ [id]: model(id) })

    const models = await hooks.provider!.models!(provider, oauthContext)

    expect(Object.keys(models)).toEqual(allowed ? [id] : [])
  })

  test("deduplicates concurrent Codex token refreshes", async () => {
    const refreshedAccess = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" },
    })
    let auth: Auth = {
      type: "oauth",
      refresh: "refresh-old",
      access: "",
      expires: 0,
    }
    const authUpdates: Array<{
      body: { refresh: string; access: string; expires: number; accountId?: string }
    }> = []
    let resolveRefresh: (() => void) | undefined
    const refreshReady = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    let refreshRequests = 0
    const apiRequests: { authorization: string | null; accountId: string | null; residency: string | null }[] = []

    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/oauth/token") {
          expect(await request.text()).toContain("refresh_token=refresh-old")
          refreshRequests += 1
          await refreshReady
          return Response.json({
            id_token: createTestJwt({ chatgpt_account_id: "acc-123" }),
            access_token: refreshedAccess,
            refresh_token: "refresh-new",
            expires_in: 3600,
          })
        }

        if (url.pathname === "/backend-api/codex/responses") {
          apiRequests.push({
            authorization: request.headers.get("authorization"),
            accountId: request.headers.get("ChatGPT-Account-Id"),
            residency: request.headers.get("x-openai-internal-codex-residency"),
          })
          return new Response("{}", { status: 200 })
        }

        return new Response("unexpected request", { status: 500 })
      },
    })

    const hooks = await CodexAuthPlugin(
      {
        client: {
          auth: {
            async set(input) {
              authUpdates.push(input)
              auth = {
                type: "oauth",
                refresh: input.body.refresh,
                access: input.body.access,
                expires: input.body.expires,
                ...(input.body.accountId && { accountId: input.body.accountId }),
              }
            },
          },
        },
      },
      {
        issuer: server.url.origin,
        codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
      },
    )
    const loaded = await hooks.auth!.loader!(async () => auth, loaderProvider)

    const first = loaded.fetch!("https://api.openai.com/v1/responses")
    const second = loaded.fetch!("https://api.openai.com/v1/responses")

    await waitFor(() => refreshRequests === 1)
    expect(apiRequests).toHaveLength(0)

    resolveRefresh!()
    await Promise.all([first, second])

    expect(refreshRequests).toBe(1)
    expect(authUpdates).toHaveLength(1)
    expect(authUpdates[0]?.body.refresh).toBe("refresh-new")
    expect(authUpdates[0]?.body.access).toBe(refreshedAccess)
    expect(authUpdates[0]?.body.accountId).toBe("acc-123")
    expect(apiRequests).toEqual([
      { authorization: `Bearer ${refreshedAccess}`, accountId: "acc-123", residency: "eu" },
      { authorization: `Bearer ${refreshedAccess}`, accountId: "acc-123", residency: "eu" },
    ])
  })
})

async function waitFor(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function createCodexWebSocketServer() {
  let headers: IncomingMessage["headers"] | undefined
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  sockets.on("connection", (socket, request) => {
    headers = request.headers
    socket.once("message", () => {
      socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_123" } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("expected a TCP address for the test server")
  return {
    url: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
    headers: () => headers,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
      server.close()
    },
  }
}
