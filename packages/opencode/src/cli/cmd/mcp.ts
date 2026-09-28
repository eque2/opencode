import { cmd } from "./cmd"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { effectCmd, fail } from "../effect-cmd"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpAuth } from "../../mcp/auth"
import { McpOAuthProvider } from "../../mcp/oauth-provider"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { InstanceRef } from "@/effect/instance-ref"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { modify, applyEdits } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { Cause, DateTime, Effect, Option, Schema } from "effect"
import * as Prompt from "../effect/prompt"
import type { InstanceContext } from "@/project/instance-context"

const authStatusIcons: Record<MCP.AuthStatus, string> = {
  authenticated: "✓",
  expired: "⚠",
  not_authenticated: "✗",
}

const authStatusTexts: Record<MCP.AuthStatus, string> = {
  authenticated: "authenticated",
  expired: "expired",
  not_authenticated: "not authenticated",
}

const getAuthStatusIcon = (status: MCP.AuthStatus) => authStatusIcons[status]

const getAuthStatusText = (status: MCP.AuthStatus) => authStatusTexts[status]

// A cancelled prompt ends the command; the CLI error formatter prints nothing for UI.CancelledError.
const answer = <Value>(value: Option.Option<Value>) =>
  Option.isNone(value) ? Effect.die(new UI.CancelledError()) : Effect.succeed(value.value)

const confirm = (opts: Parameters<typeof prompts.confirm>[0]) =>
  Effect.promise(() => prompts.confirm(opts)).pipe(
    Effect.flatMap((value) => answer(prompts.isCancel(value) ? Option.none<boolean>() : Option.some(value))),
  )

// clack reads an undefined result from validate as a valid value.
const required = (value: string | undefined) => {
  if (value && value.length > 0) return undefined
  return "Required"
}

const validUrl = (value: string | undefined) => {
  if (!value) return "Required"
  if (URL.canParse(value)) return undefined
  return "Invalid URL"
}

type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

type McpConfigured = ConfigMCPV1.Info
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return "type" in config
}

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return isMcpConfigured(config) && config.type === "remote"
}

function configuredServers(config: ConfigV1.Info) {
  return Object.entries(config.mcp ?? {}).filter((entry): entry is [string, McpConfigured] => isMcpConfigured(entry[1]))
}

function oauthServers(config: ConfigV1.Info) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

function listState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    return { config, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: "unbounded" },
    )
    return { config, auth }
  })
}

export const McpCommand = cmd({
  command: "mcp",
  describe: "manage MCP (Model Context Protocol) servers",
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .demandCommand(),
  handler() {},
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list MCP servers and their status",
  handler: Effect.fn("Cli.mcp.list")(function* () {
    UI.empty()
    prompts.intro("MCP Servers")

    const { config, statuses, stored } = yield* listState()
    const servers = configuredServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No MCP servers configured")
      prompts.outro("Add servers with: opencode mcp add")
      return
    }

    for (const [name, serverConfig] of servers) {
      const status = statuses[name]
      const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
      const hasStoredTokens = stored[name]

      let statusIcon: string
      let statusText: string
      let hint = ""

      if (!status) {
        statusIcon = "○"
        statusText = "not initialized"
      } else if (status.status === "connected") {
        statusIcon = "✓"
        statusText = "connected"
        if (hasOAuth && hasStoredTokens) {
          hint = " (OAuth)"
        }
      } else if (status.status === "disabled") {
        statusIcon = "○"
        statusText = "disabled"
      } else if (status.status === "needs_auth") {
        statusIcon = "⚠"
        statusText = "needs authentication"
      } else if (status.status === "needs_client_registration") {
        statusIcon = "✗"
        statusText = "needs client registration"
        hint = "\n    " + status.error
      } else {
        statusIcon = "✗"
        statusText = "failed"
        hint = "\n    " + status.error
      }

      const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
      prompts.log.info(
        `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
      )
    }

    prompts.outro(`${servers.length} server(s)`)
  }),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: "authenticate with an OAuth-enabled MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Authentication")

    const { config, auth } = yield* authState()
    const mcpServers = config.mcp ?? {}
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.log.info("Remote MCP servers support OAuth by default. Add a remote server in opencode.json:")
      prompts.log.info(`
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
      prompts.outro("Done")
      return
    }

    const serverName =
      args.name ||
      (yield* Prompt.select({
        message: "Select MCP server to authenticate",
        // Each option shows the auth status of the server.
        options: servers.map(([name, cfg]) => ({
          label: `${getAuthStatusIcon(auth[name])} ${name} (${getAuthStatusText(auth[name])})`,
          value: name,
          hint: cfg.url,
        })),
      }).pipe(Effect.flatMap(answer)))

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) {
      prompts.log.error(`MCP server not found: ${serverName}`)
      prompts.outro("Done")
      return
    }

    if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
      prompts.log.error(`MCP server ${serverName} is not an OAuth-capable remote server`)
      prompts.outro("Done")
      return
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    if (authStatus === "authenticated") {
      const reauthenticate = yield* Effect.promise(() =>
        prompts.confirm({
          message: `${serverName} already has valid credentials. Re-authenticate?`,
        }),
      )
      if (prompts.isCancel(reauthenticate) || !reauthenticate) {
        prompts.outro("Cancelled")
        return
      }
    } else if (authStatus === "expired") {
      prompts.log.warn(`${serverName} has expired credentials. Re-authenticating...`)
    }

    const spinner = prompts.spinner()
    spinner.start("Starting OAuth flow...")

    yield* MCP.Service.use((mcp) =>
      mcp.authenticate(serverName, (url) => {
        spinner.stop("Authorize in your browser:")
        prompts.log.info(url)
        spinner.start("Waiting for authorization...")
      }),
    ).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (status.status === "connected") {
            spinner.stop("Authentication successful!")
          } else if (status.status === "needs_client_registration") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
            prompts.log.info("Add clientId to your MCP server config:")
            prompts.log.info(`
  "mcp": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
          } else {
            spinner.stop("Unexpected status: " + status.status, 1)
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.stop("Authentication failed", 1)
          const error = Cause.squash(cause)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }),
      ),
    )

    prompts.outro("Done")
  }),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OAuth-capable MCP servers and their auth status",
  handler: Effect.fn("Cli.mcp.auth.list")(function* () {
    UI.empty()
    prompts.intro("MCP OAuth Status")

    const { config, auth } = yield* authState()
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.outro("Done")
      return
    }

    for (const [name, serverConfig] of servers) {
      const authStatus = auth[name]
      const icon = getAuthStatusIcon(authStatus)
      const statusText = getAuthStatusText(authStatus)
      const url = serverConfig.url

      prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
    }

    prompts.outro(`${servers.length} OAuth-capable server(s)`)
  }),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: "remove OAuth credentials for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Logout")

    const credentials = yield* McpAuth.Service.use((auth) => auth.all())
    const serverNames = Object.keys(credentials)

    if (serverNames.length === 0) {
      prompts.log.warn("No MCP OAuth credentials stored")
      prompts.outro("Done")
      return
    }

    const serverName =
      args.name ||
      (yield* Prompt.select({
        message: "Select MCP server to logout",
        options: serverNames.map((name) => {
          const entry = credentials[name]
          const hasTokens = !!entry.tokens
          const hasClient = !!entry.clientInfo
          let hint = ""
          if (hasTokens && hasClient) hint = "tokens + client"
          else if (hasTokens) hint = "tokens"
          else if (hasClient) hint = "client registration"
          return {
            label: name,
            value: name,
            hint,
          }
        }),
      }).pipe(Effect.flatMap(answer)))

    if (!credentials[serverName]) {
      prompts.log.error(`No credentials found for: ${serverName}`)
      prompts.outro("Done")
      return
    }

    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName))
    prompts.log.success(`Removed OAuth credentials for ${serverName}`)
    prompts.outro("Done")
  }),
})

const resolveConfigPath = Effect.fnUntraced(function* (baseDir: string, global = false) {
  // Check for existing config files (prefer .json over .jsonc, check .opencode/ subdirectory too)
  const candidates = [
    path.join(baseDir, "opencode.json"),
    path.join(baseDir, "opencode.jsonc"),
    ...(global
      ? []
      : [path.join(baseDir, ".opencode", "opencode.json"), path.join(baseDir, ".opencode", "opencode.jsonc")]),
  ]
  const existing = yield* Effect.findFirst(candidates, (candidate) =>
    Effect.promise(() => Filesystem.exists(candidate)),
  )
  // Default to opencode.json if none exist
  return Option.getOrElse(existing, () => candidates[0])
})

const addMcpToConfig = Effect.fnUntraced(function* (name: string, mcpConfig: ConfigMCPV1.Info, configPath: string) {
  const text = (yield* Effect.promise(() => Filesystem.exists(configPath)))
    ? yield* Effect.promise(() => Filesystem.readText(configPath))
    : "{}"

  // Use jsonc-parser to modify while preserving comments
  const edits = modify(text, ["mcp", name], mcpConfig, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  yield* Effect.promise(() => Filesystem.write(configPath, applyEdits(text, edits)))
  return configPath
})

// Parses repeated KEY=VALUE options. The value may contain "=".
const keyValues = (values: readonly string[], kind: string) =>
  Effect.forEach(values, (entry) => {
    const index = entry.indexOf("=")
    if (index < 1) return fail(`Invalid ${kind}: ${entry}. Expected KEY=VALUE`)
    const pair: [string, string] = [entry.slice(0, index), entry.slice(index + 1)]
    return Effect.succeed(pair)
  }).pipe(Effect.map((entries) => Object.fromEntries(entries)))

type McpAddOptions = {
  url?: string
  env?: readonly string[]
  header?: readonly string[]
}

const addFromOptions = Effect.fnUntraced(function* (name: string, options: McpAddOptions, command: string[]) {
  if (!!options.url === !!command.length) return yield* fail("Provide either --url <url> or a command after --")
  if (options.url && !URL.canParse(options.url)) return yield* fail(`Invalid URL: ${options.url}`)
  if (options.url && options.env?.length) return yield* fail("--env is only valid for local MCP servers")
  if (command.length && options.header?.length) return yield* fail("--header is only valid for remote MCP servers")

  const environment = yield* keyValues(options.env ?? [], "environment variable")
  const headers = yield* keyValues(options.header ?? [], "HTTP header")
  const mcpConfig: ConfigMCPV1.Info = options.url
    ? {
        type: "remote",
        url: options.url,
        ...(Object.keys(headers).length ? { headers } : {}),
      }
    : {
        type: "local",
        command,
        ...(Object.keys(environment).length ? { environment } : {}),
      }

  const configPath = yield* resolveConfigPath(Global.Path.config, true)
  yield* addMcpToConfig(name, mcpConfig, configPath)
  return yield* Prompt.log.success(`MCP server "${name}" added to ${configPath}`)
})

const promptOAuth = Effect.fnUntraced(function* () {
  const hasClientId = yield* confirm({
    message: "Do you have a pre-registered client ID?",
    initialValue: false,
  })
  if (!hasClientId) return {}

  const clientId = yield* Prompt.text({
    message: "Enter client ID",
    validate: required,
  }).pipe(Effect.flatMap(answer))

  const hasSecret = yield* confirm({
    message: "Do you have a client secret?",
    initialValue: false,
  })
  if (!hasSecret) return { clientId }

  const clientSecret = yield* Prompt.password({
    message: "Enter client secret",
  }).pipe(Effect.flatMap(answer))
  return { clientId, ...(clientSecret && { clientSecret }) }
})

const addInteractive = Effect.fnUntraced(function* (ctx: InstanceContext) {
  UI.empty()
  yield* Prompt.intro("Add MCP server")

  // Resolve config paths eagerly for hints
  const [projectConfigPath, globalConfigPath] = yield* Effect.all(
    [resolveConfigPath(ctx.worktree), resolveConfigPath(Global.Path.config, true)],
    { concurrency: "unbounded" },
  )

  // Determine scope
  const configPath =
    ctx.project.vcs === "git"
      ? yield* Prompt.select({
          message: "Location",
          options: [
            {
              label: "Current project",
              value: projectConfigPath,
              hint: projectConfigPath,
            },
            {
              label: "Global",
              value: globalConfigPath,
              hint: globalConfigPath,
            },
          ],
        }).pipe(Effect.flatMap(answer))
      : globalConfigPath

  const name = yield* Prompt.text({
    message: "Enter MCP server name",
    validate: required,
  }).pipe(Effect.flatMap(answer))

  const type = yield* Prompt.select({
    message: "Select MCP server type",
    options: [
      {
        label: "Local",
        value: "local",
        hint: "Run a local command",
      },
      {
        label: "Remote",
        value: "remote",
        hint: "Connect to a remote URL",
      },
    ],
  }).pipe(Effect.flatMap(answer))

  if (type === "local") {
    const command = yield* Prompt.text({
      message: "Enter command to run",
      placeholder: "e.g., opencode x @modelcontextprotocol/server-filesystem",
      validate: required,
    }).pipe(Effect.flatMap(answer))

    yield* addMcpToConfig(name, { type: "local", command: command.split(" ") }, configPath)
    yield* Prompt.log.success(`MCP server "${name}" added to ${configPath}`)
    return yield* Prompt.outro("MCP server added successfully")
  }

  const url = yield* Prompt.text({
    message: "Enter MCP server URL",
    placeholder: "e.g., https://example.com/mcp",
    validate: validUrl,
  }).pipe(Effect.flatMap(answer))

  const useOAuth = yield* confirm({
    message: "Does this server require OAuth authentication?",
    initialValue: false,
  })

  const mcpConfig: ConfigMCPV1.Info = {
    type: "remote",
    url,
    ...(useOAuth ? { oauth: yield* promptOAuth() } : {}),
  }

  yield* addMcpToConfig(name, mcpConfig, configPath)
  yield* Prompt.log.success(`MCP server "${name}" added to ${configPath}`)
  return yield* Prompt.outro("MCP server added successfully")
})

export const McpAddCommand = effectCmd({
  command: "add [name]",
  describe: "add an MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .option("url", {
        describe: "URL for a remote MCP server",
        type: "string",
      })
      .option("env", {
        describe: "environment variable for a local MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "HTTP header for a remote MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      }),
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    const command = args["--"] ?? []
    if (!args.name && (args.url || args.env?.length || args.header?.length || command.length)) {
      return yield* fail("A server name is required for non-interactive MCP configuration")
    }
    if (args.name) return yield* addFromOptions(args.name, args, command)
    return yield* addInteractive(ctx)
  }),
})

// A failed request or SDK call in `mcp debug`. The command prints the cause and goes on.
class McpDebugError extends Schema.TaggedError<McpDebugError>()("McpDebugError", {
  cause: Schema.Defect(),
}) {}

const debugTry = <A>(fn: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: fn, catch: (cause) => new McpDebugError({ cause }) })

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

// The part of a JSON-RPC initialize response that `mcp debug` prints.
const InitializeResponse = Schema.Struct({
  result: Schema.optional(Schema.Struct({ serverInfo: Schema.optional(Schema.Json) })),
}).annotate({ identifier: "McpDebugInitializeResponse", description: "The serverInfo of an MCP initialize response." })

const decodeInitializeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(InitializeResponse))

// OAuth token times are epoch seconds.
const formatEpochSeconds = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000))

type Spinner = ReturnType<typeof prompts.spinner>

const reportConnectError = Effect.fnUntraced(function* (error: unknown, authProvider: McpOAuthProvider) {
  if (!(error instanceof UnauthorizedError)) {
    return yield* Prompt.log.error(`Connection error: ${errorText(error)}`)
  }
  prompts.log.info(`OAuth flow triggered: ${error.message}`)

  // Check if dynamic registration would be attempted
  const clientInfo = yield* debugTry(() => authProvider.clientInformation())
  if (clientInfo) return yield* Prompt.log.info(`Client ID available: ${clientInfo.client_id}`)
  return yield* Prompt.log.info("No client ID - dynamic registration will be attempted")
})

const probeOAuth = Effect.fnUntraced(function* (serverName: string, serverConfig: McpRemote, auth: McpAuth.Interface) {
  prompts.log.info("Initial unauthenticated check returned 401, so this server requires OAuth")

  // Try to discover OAuth metadata
  const oauthConfig: ConfigMCPV1.OAuth = typeof serverConfig.oauth === "object" ? serverConfig.oauth : {}
  const authProvider = new McpOAuthProvider(
    serverName,
    serverConfig.url,
    {
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      scope: oauthConfig.scope,
      redirectUri: oauthConfig.redirectUri,
    },
    {
      onRedirect: () => {},
    },
    auth,
  )

  prompts.log.info("Testing OAuth flow (without completing authorization)...")

  // Try creating transport with auth provider to trigger discovery
  const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    authProvider,
    ...(serverConfig.headers ? { requestInit: { headers: serverConfig.headers } } : {}),
  })

  return yield* Effect.gen(function* () {
    const client = yield* Effect.try({
      try: () =>
        new Client({
          name: "opencode-debug",
          version: InstallationVersion,
        }),
      catch: (cause) => new McpDebugError({ cause }),
    })
    yield* debugTry(() => client.connect(transport))
    prompts.log.success("Connection successful (already authenticated)")
    yield* debugTry(() => client.close())
  }).pipe(Effect.catch((error) => reportConnectError(error.cause, authProvider)))
})

const printServerInfo = Effect.fnUntraced(function* (response: Response) {
  prompts.log.success("Server responded successfully (no auth required or already authenticated)")
  const body = yield* debugTry(() => response.text())
  // A body that is not JSON (for example an event stream) has no server info to print.
  const serverInfo = decodeInitializeResponse(body).pipe(
    Option.flatMap((json) => (json.result?.serverInfo ? Option.some(json.result.serverInfo) : Option.none())),
  )
  if (Option.isNone(serverInfo)) return yield* Effect.void
  return yield* Prompt.log.info(`Server info: ${yield* encodeJson(serverInfo.value).pipe(Effect.orDie)}`)
})

const printUnexpectedStatus = Effect.fnUntraced(function* (response: Response) {
  prompts.log.warn(`Unexpected status: ${response.status}`)
  const body = yield* debugTry(() => response.text()).pipe(Effect.orElseSucceed(() => ""))
  if (!body) return yield* Effect.void
  return yield* Prompt.log.info(`Response body: ${body.substring(0, 500)}`)
})

const probeServer = Effect.fnUntraced(function* (
  serverName: string,
  serverConfig: McpRemote,
  auth: McpAuth.Interface,
  spinner: Spinner,
) {
  // Test basic HTTP connectivity first
  const body = yield* encodeJson({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "opencode-debug", version: InstallationVersion },
    },
    id: 1,
  }).pipe(Effect.orDie)
  const response = yield* debugTry(() =>
    fetch(serverConfig.url, {
      method: "POST",
      headers: {
        ...serverConfig.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body,
    }),
  )

  spinner.stop(`HTTP response: ${response.status} ${response.statusText}`)

  // Check for WWW-Authenticate header
  const wwwAuth = response.headers.get("www-authenticate")
  if (wwwAuth) {
    prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)
  }

  if (response.status === 401) return yield* probeOAuth(serverName, serverConfig, auth)
  if (response.status >= 200 && response.status < 300) return yield* printServerInfo(response)
  return yield* printUnexpectedStatus(response)
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: "debug OAuth connection for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.debug")(function* (args) {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const serverName = args.name
    const serverConfig = config.mcp?.[serverName]

    UI.empty()
    prompts.intro("MCP OAuth Debug")

    if (!serverConfig) {
      prompts.log.error(`MCP server not found: ${serverName}`)
      return yield* Prompt.outro("Done")
    }

    if (!isMcpRemote(serverConfig)) {
      prompts.log.error(`MCP server ${serverName} is not a remote server`)
      return yield* Prompt.outro("Done")
    }

    if (serverConfig.oauth === false) {
      prompts.log.warn(`MCP server ${serverName} has OAuth explicitly disabled`)
      return yield* Prompt.outro("Done")
    }

    prompts.log.info(`Server: ${serverName}`)
    prompts.log.info(`URL: ${serverConfig.url}`)

    const { authStatus, entry } = yield* Effect.all({
      authStatus: mcp.getAuthStatus(serverName),
      entry: auth.get(serverName),
    })
    prompts.log.info(`Auth status: ${getAuthStatusIcon(authStatus)} ${getAuthStatusText(authStatus)}`)

    if (entry?.tokens) {
      prompts.log.info(
        `  Access token: ${entry.tokens.accessToken.length > 8 ? `${entry.tokens.accessToken.slice(0, 4)}***${entry.tokens.accessToken.slice(-4)}` : "***"}`,
      )
      if (entry.tokens.expiresAt) {
        const isExpired = entry.tokens.expiresAt * 1000 < DateTime.toEpochMillis(yield* DateTime.now)
        prompts.log.info(`  Expires: ${formatEpochSeconds(entry.tokens.expiresAt)} ${isExpired ? "(EXPIRED)" : ""}`)
      }
      if (entry.tokens.refreshToken) {
        prompts.log.info(`  Refresh token: present`)
      }
    }
    if (entry?.clientInfo) {
      prompts.log.info(`  Client ID: ${entry.clientInfo.clientId}`)
      if (entry.clientInfo.clientSecretExpiresAt) {
        prompts.log.info(`  Client secret expires: ${formatEpochSeconds(entry.clientInfo.clientSecretExpiresAt)}`)
      }
    }

    const spinner = prompts.spinner()
    spinner.start("Testing connection...")

    yield* probeServer(serverName, serverConfig, auth, spinner).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          spinner.stop("Connection failed", 1)
          prompts.log.error(`Error: ${errorText(error.cause)}`)
        }),
      ),
    )

    return yield* Prompt.outro("Debug complete")
  }),
})
