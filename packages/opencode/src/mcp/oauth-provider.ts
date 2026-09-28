import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { NodeCrypto } from "@effect/platform-node"
import { Clock, Crypto, Effect, Encoding, Option, Predicate, Schema } from "effect"
import { McpAuth } from "./auth"

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export class McpOAuthProviderError extends Schema.TaggedError<McpOAuthProviderError>()("McpOAuthProviderError", {
  message: Schema.String,
}) {}

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

const nowSeconds = Clock.currentTimeMillis.pipe(Effect.map((millis) => millis / 1000))

// The OAuth state guards against CSRF, so it needs cryptographically secure bytes.
const randomState = Effect.gen(function* () {
  const cryptoService = yield* Crypto.Crypto
  return Encoding.encodeHex(yield* cryptoService.randomBytes(32).pipe(Effect.orDie))
}).pipe(Effect.provide(NodeCrypto.layer))

// OAuthClientProvider from @modelcontextprotocol/sdk is a Promise-based interface. Each method
// runs its Effect once at this boundary with Effect.runPromise.
export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    protected mcpName: string,
    protected serverUrl: string,
    protected config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    protected auth: McpAuth.Interface,
  ) {}

  get redirectUrl(): string {
    if (this.config.redirectUri) {
      return this.config.redirectUri
    }
    const port = this.config.callbackPort ?? OAUTH_CALLBACK_PORT
    return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "OpenCode",
      client_uri: "https://opencode.ai",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    }
  }

  clientInformation(): Promise<OAuthClientInformation | undefined> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        if (this.config.clientId) {
          return {
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
          }
        }

        // Check stored client info (from dynamic registration)
        // Use getForUrl to validate credentials are for the current server URL
        const entry = yield* this.auth.getForUrl(this.mcpName, this.serverUrl)
        if (entry?.clientInfo) {
          // Check if client secret has expired
          if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < (yield* nowSeconds)) {
            return undefined
          }
          return {
            client_id: entry.clientInfo.clientId,
            client_secret: entry.clientInfo.clientSecret,
          }
        }

        // No client info or URL changed - will trigger dynamic registration
        return undefined
      }),
    )
  }

  saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    return Effect.runPromise(
      this.auth.updateClientInfo(
        this.mcpName,
        {
          clientId: info.client_id,
          clientSecret: info.client_secret,
          clientIdIssuedAt: info.client_id_issued_at,
          clientSecretExpiresAt: info.client_secret_expires_at,
        },
        this.serverUrl,
      ),
    )
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        // Use getForUrl to validate tokens are for the current server URL
        const entry = yield* this.auth.getForUrl(this.mcpName, this.serverUrl)
        if (!entry?.tokens) return undefined

        const expiresAt = entry.tokens.expiresAt
        const now = yield* nowSeconds
        return {
          access_token: entry.tokens.accessToken,
          token_type: "Bearer",
          refresh_token: entry.tokens.refreshToken,
          ...(expiresAt ? { expires_in: Math.max(0, Math.floor(expiresAt - now)) } : {}),
          scope: entry.tokens.scope,
        }
      }),
    )
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const expiresIn = tokens.expires_in
        const now = yield* nowSeconds
        yield* this.auth.updateTokens(
          this.mcpName,
          {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            ...(expiresIn ? { expiresAt: now + expiresIn } : {}),
            scope: tokens.scope,
          },
          this.serverUrl,
        )
      }),
    )
  }

  redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    return Effect.runPromise(
      Effect.suspend(() => {
        const redirected = this.callbacks.onRedirect(authorizationUrl)
        // Effect.promise keeps a rejection as a defect, so the SDK receives the callback's own error.
        return Predicate.isPromise(redirected) ? Effect.promise(() => redirected) : Effect.void
      }),
    )
  }

  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return Effect.runPromise(this.auth.updateCodeVerifier(this.mcpName, codeVerifier))
  }

  codeVerifier(): Promise<string> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const entry = yield* this.auth.get(this.mcpName)
        if (!entry?.codeVerifier) {
          return yield* new McpOAuthProviderError({ message: `No code verifier saved for MCP server: ${this.mcpName}` })
        }
        return entry.codeVerifier
      }),
    )
  }

  saveState(state: string): Promise<void> {
    return Effect.runPromise(this.auth.updateOAuthState(this.mcpName, state))
  }

  state(): Promise<string> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const entry = yield* this.auth.get(this.mcpName)
        if (entry?.oauthState) {
          return entry.oauthState
        }

        // Generate a new state if none exists — the SDK calls state() as a
        // generator, not just a reader, so we need to produce a value even when
        // startAuth() hasn't pre-saved one (e.g. during automatic auth on first
        // connect).
        const newState = yield* randomState
        yield* this.auth.updateOAuthState(this.mcpName, newState)
        return newState
      }),
    )
  }

  invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const entry = yield* this.auth.get(this.mcpName)
        if (!entry) return
        switch (type) {
          case "all":
            yield* this.auth.remove(this.mcpName)
            break
          case "client":
            delete entry.clientInfo
            yield* this.auth.set(this.mcpName, entry)
            break
          case "tokens":
            delete entry.tokens
            yield* this.auth.set(this.mcpName, entry)
            break
        }
      }),
    )
  }
}

export class McpOAuthPendingProvider extends McpOAuthProvider {
  private pendingClientInfo = Option.none<OAuthClientInformationFull>()
  private pendingTokens = Option.none<OAuthTokens>()

  override clientInformation(): Promise<OAuthClientInformation | undefined> {
    return Effect.runPromise(
      Effect.sync(() => {
        if (!this.config.clientId) return Option.getOrUndefined(this.pendingClientInfo)
        return {
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }
      }),
    )
  }

  override saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    return Effect.runPromise(
      Effect.sync(() => {
        this.pendingClientInfo = Option.some(info)
      }),
    )
  }

  override tokens(): Promise<OAuthTokens | undefined> {
    return Effect.runPromise(Effect.sync(() => Option.getOrUndefined(this.pendingTokens)))
  }

  override saveTokens(tokens: OAuthTokens): Promise<void> {
    return Effect.runPromise(
      Effect.sync(() => {
        this.pendingTokens = Option.some(tokens)
      }),
    )
  }

  override invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
    return Effect.runPromise(
      Effect.sync(() => {
        if (type === "all" || type === "client") this.pendingClientInfo = Option.none()
        if (type === "all" || type === "tokens") this.pendingTokens = Option.none()
      }),
    )
  }

  commit(): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        if (Option.isNone(this.pendingTokens)) return
        const tokens = this.pendingTokens.value
        const clientInfo = this.config.clientId ? Option.none() : this.pendingClientInfo
        const expiresIn = tokens.expires_in
        const now = yield* nowSeconds
        yield* this.auth.set(
          this.mcpName,
          {
            tokens: {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              ...(expiresIn ? { expiresAt: now + expiresIn } : {}),
              scope: tokens.scope,
            },
            ...(Option.isSome(clientInfo)
              ? {
                  clientInfo: {
                    clientId: clientInfo.value.client_id,
                    clientSecret: clientInfo.value.client_secret,
                    clientIdIssuedAt: clientInfo.value.client_id_issued_at,
                    clientSecretExpiresAt: clientInfo.value.client_secret_expires_at,
                  },
                }
              : {}),
          },
          this.serverUrl,
        )
      }),
    )
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }

/**
 * Parse a redirect URI to extract port and path for the callback server.
 * Returns defaults if the URI can't be parsed.
 */
export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }

  if (!URL.canParse(redirectUri)) {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }

  const url = new URL(redirectUri)
  const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80
  const path = url.pathname || OAUTH_CALLBACK_PATH
  return { port, path }
}
