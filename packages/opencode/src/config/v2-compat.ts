export * as ConfigV2Compat from "./v2-compat"

import { isDeepStrictEqual } from "node:util"
import { HashSet, Option, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { ConfigAttachmentV1 } from "@opencode-ai/core/v1/config/attachment"
import { ConfigLSPV1 } from "@opencode-ai/core/v1/config/lsp"
import { InvalidError } from "@opencode-ai/core/v1/config/error"
import { isRecord } from "@/util/record"

export interface Diagnostic {
  readonly kind: "invalid" | "unsupported" | "conflict"
  readonly path: readonly string[]
  readonly message: string
}

export interface Lowered {
  readonly value: unknown
  readonly diagnostics: readonly Diagnostic[]
}

const decodeOptions = { errors: "all", onExcessProperty: "ignore" } as const
const Timeout = Schema.Struct({
  startup: Schema.optional(PositiveInt),
  catalog: Schema.optional(PositiveInt),
  execution: Schema.optional(PositiveInt),
}).annotate({ identifier: "ConfigV2CompatTimeout" })
const OAuth = Schema.Struct({
  client_id: Schema.optional(Schema.String),
  client_secret: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  callback_port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  redirect_uri: Schema.optional(Schema.String),
}).annotate({ identifier: "ConfigV2CompatOAuth" })
const Server = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("local"),
    command: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    disabled: Schema.optional(Schema.Boolean),
    codemode: Schema.optional(Schema.Boolean),
    timeout: Schema.optional(Timeout),
  }),
  Schema.Struct({
    type: Schema.Literal("remote"),
    url: Schema.String,
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])),
    disabled: Schema.optional(Schema.Boolean),
    codemode: Schema.optional(Schema.Boolean),
    timeout: Schema.optional(Timeout),
  }),
])
const Selection = Schema.Union([
  Schema.String.check(Schema.isPattern(/^[^/#]+\/[^#]+(?:#[^#]+)?$/)),
  Schema.Struct({
    providerID: Schema.String.check(Schema.isPattern(/^[^/#]+$/)),
    model: Schema.String.check(Schema.isPattern(/^[^#]+$/)),
    variant: Schema.optional(Schema.String.check(Schema.isPattern(/^[^#]+$/))),
  }),
])
const Agent = Schema.Struct({
  model: Schema.optional(Selection),
  request: Schema.optional(
    Schema.Struct({
      headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      body: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
  system: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
  hidden: Schema.optional(Schema.Boolean),
  color: Schema.optional(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))),
  steps: Schema.optional(PositiveInt),
  disabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "ConfigV2CompatAgent" })
const Command = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Selection),
  subtask: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "ConfigV2CompatCommand" })

// A plain object (not an array) is the only shape this lowering walks into.
const decodeRecord = Option.liftPredicate(isRecord)
const decodeLspEntry = Schema.decodeUnknownOption(ConfigLSPV1.Entry, decodeOptions)
const decodeBoolean = Schema.decodeUnknownOption(Schema.Boolean, decodeOptions)
const decodeAttachment = Schema.decodeUnknownOption(ConfigAttachmentV1.Info, decodeOptions)
const decodeStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String), decodeOptions)
const decodeNonNegativeInt = Schema.decodeUnknownOption(NonNegativeInt, decodeOptions)
const decodeAgent = Schema.decodeUnknownOption(Agent, decodeOptions)
const decodeCommand = Schema.decodeUnknownOption(Command, decodeOptions)
const decodeServer = Schema.decodeUnknownOption(Server, decodeOptions)
const decodeSelection = Schema.decodeUnknownOption(Selection, decodeOptions)
const decodeTimeout = Schema.decodeUnknownOption(Timeout, decodeOptions)
const builtinServers = HashSet.fromIterable<string>(ConfigLSPV1.builtinServerIds)

export function lower(input: unknown, source = "configuration"): Lowered {
  const parsed = decodeRecord(input)
  if (Option.isNone(parsed)) return { value: input, diagnostics: [] }

  const permissions = [
    ...(Object.hasOwn(parsed.value, "permissions") ? [["permissions"]] : []),
    ...["agents", "agent", "mode"].flatMap((key) => {
      const agents = decodeRecord(parsed.value[key])
      if (Option.isNone(agents)) return []
      return Object.entries(agents.value).flatMap(([name, value]) => {
        const agent = decodeRecord(value)
        return Option.isSome(agent) && Object.hasOwn(agent.value, "permissions") ? [[key, name, "permissions"]] : []
      })
    }),
  ]
  if (permissions.length)
    throw new InvalidError({
      path: source,
      issues: permissions.map((path) => ({
        path,
        message: 'V2 permissions are not supported by OpenCode V1. Use V1 "permission" rules or run opencode2.',
      })),
    })

  const result: Record<string, unknown> = { ...parsed.value }
  // Each step writes into result in order, so the spread order is also the diagnostic order.
  const diagnostics = [
    ...["plugins", "providers", "websearch", "warming"]
      .filter((key) => Object.hasOwn(parsed.value, key))
      .map((key) => unsupported([key])),
    ...normalizeSettings(parsed.value, result),
    ...normalizeModel(parsed.value, result),
    ...normalizeSkills(parsed.value, result),
    ...normalizeCompaction(parsed.value, result),
    ...normalizeExperimental(parsed.value, result),

    ...normalizeAgents(parsed.value, result),
    ...normalizeCommands(parsed.value, result),
    ...normalizeMcp(parsed.value, result),
    ...normalizeLsp(parsed.value, result),
  ]

  return { value: result, diagnostics }
}

function normalizeSettings(input: Record<string, unknown>, result: Record<string, unknown>): readonly Diagnostic[] {
  return [
    ...(Object.hasOwn(input, "snapshots")
      ? lowerLegacy(result, "snapshot", decodeBoolean, input.snapshots, ["snapshots"])
      : []),
    ...(Object.hasOwn(input, "media")
      ? lowerLegacy(result, "attachment", decodeAttachment, input.media, ["media"])
      : []),
  ]
}

function normalizeModel(input: Record<string, unknown>, result: Record<string, unknown>): readonly Diagnostic[] {
  if (!Object.hasOwn(input, "model")) return []
  const selection = decodeSelection(input.model)
  if (Option.isNone(selection)) return []
  const value = lowerSelection(selection.value)
  result.model = value.model
  return value.variant !== undefined ? [unsupported(["model", "variant"])] : []
}

function normalizeSkills(input: Record<string, unknown>, result: Record<string, unknown>): readonly Diagnostic[] {
  if (!Array.isArray(input.skills)) return []
  const skills = decodeStrings(input.skills)
  if (Option.isNone(skills)) return [invalid(["skills"])]
  result.skills = {
    paths: skills.value.filter((value) => !/^https?:\/\//i.test(value)),
    urls: skills.value.filter((value) => /^https?:\/\//i.test(value)),
  }
  return []
}

function normalizeCompaction(input: Record<string, unknown>, result: Record<string, unknown>): readonly Diagnostic[] {
  const compaction = decodeRecord(input.compaction)
  if (Option.isNone(compaction)) return []
  const value = { ...compaction.value }
  const diagnostics = [
    ...(Object.hasOwn(value, "keep") ? lowerKeep(value) : []),
    ...(Object.hasOwn(value, "buffer")
      ? lowerLegacy(value, "reserved", decodeNonNegativeInt, value.buffer, ["compaction", "buffer"])
      : []),
  ]
  result.compaction = value
  return diagnostics
}

function lowerKeep(compaction: Record<string, unknown>): readonly Diagnostic[] {
  const keep = decodeRecord(compaction.keep)
  if (Option.isNone(keep)) return [invalid(["compaction", "keep"])]
  if (!Object.hasOwn(keep.value, "tokens")) return []
  return lowerLegacy(compaction, "preserve_recent_tokens", decodeNonNegativeInt, keep.value.tokens, [
    "compaction",
    "keep",
    "tokens",
  ])
}

function normalizeExperimental(input: Record<string, unknown>, result: Record<string, unknown>): readonly Diagnostic[] {
  const experimental = decodeRecord(input.experimental)
  if (Option.isNone(experimental)) return []
  const scanner = Object.hasOwn(experimental.value, "portable_shell_scanner")
    ? [unsupported(["experimental", "portable_shell_scanner"])]
    : []
  if (!Object.hasOwn(experimental.value, "subagent_depth")) return scanner
  return [
    ...scanner,
    ...lowerLegacy(result, "subagent_depth", decodeNonNegativeInt, experimental.value.subagent_depth, [
      "experimental",
      "subagent_depth",
    ]),
  ]
}

function normalizeAgents(input: Record<string, unknown>, result: Record<string, unknown>): readonly Diagnostic[] {
  if (!Object.hasOwn(input, "agents")) return []
  const agents = decodeRecord(input.agents)
  if (Option.isNone(agents)) return [invalid(["agents"])]
  const legacy = decodeRecord(result.agent)
  const merged: Record<string, unknown> = Option.isSome(legacy) ? { ...legacy.value } : {}
  const diagnostics = Object.entries(agents.value).flatMap(([name, value]): readonly Diagnostic[] => {
    const path = ["agents", name]
    if (Object.hasOwn(merged, name)) return isDeepStrictEqual(merged[name], value) ? [] : [conflict(path)]
    const parsed = decodeAgent(value)
    if (Option.isNone(parsed)) return [invalid(path)]
    setOwn(merged, name, lowerAgent(parsed.value))
    return parsed.value.request?.headers !== undefined ? [unsupported([...path, "request", "headers"])] : []
  })
  if (Object.hasOwn(result, "agent") && Option.isNone(legacy)) return diagnostics
  if (Object.keys(merged).length > 0 || Option.isSome(legacy)) result.agent = merged
  return diagnostics
}

function normalizeCommands(input: Record<string, unknown>, result: Record<string, unknown>): readonly Diagnostic[] {
  if (!Object.hasOwn(input, "commands")) return []
  const commands = decodeRecord(input.commands)
  if (Option.isNone(commands)) return [invalid(["commands"])]
  const legacy = decodeRecord(result.command)
  if (Object.hasOwn(result, "command") && Option.isNone(legacy)) return []
  const merged: Record<string, unknown> = Option.isSome(legacy) ? { ...legacy.value } : {}
  const diagnostics = Object.entries(commands.value).flatMap(([name, value]): readonly Diagnostic[] => {
    const path = ["commands", name]
    const parsed = decodeCommand(value)
    if (Option.isNone(parsed)) return [invalid(path)]
    return preferLegacy(merged, name, lowerCommand(parsed.value), path)
  })
  if (Object.keys(merged).length > 0 || Option.isSome(legacy)) result.command = merged
  return diagnostics
}

function normalizeMcp(input: Record<string, unknown>, result: Record<string, unknown>): readonly Diagnostic[] {
  const mcp = decodeRecord(input.mcp)
  if (Option.isNone(mcp)) return []
  const servers: Record<string, unknown> = {}
  const nested = decodeRecord(mcp.value.servers)
  const envelope = Option.isSome(nested) && !isDirectServer(nested.value)
  const timeoutRecord = decodeRecord(mcp.value.timeout)
  const timeout = decodeTimeout(mcp.value.timeout)
  const globalTimeout =
    Option.isSome(timeout) &&
    Option.isSome(timeoutRecord) &&
    !isDirectServer(timeoutRecord.value) &&
    (Object.keys(timeoutRecord.value).length === 0 ||
      ["startup", "catalog", "execution"].some((key) => Object.hasOwn(timeoutRecord.value, key)))

  const flat = Object.entries(mcp.value).flatMap(([name, value]): readonly Diagnostic[] => {
    if (name === "servers" && envelope) return []
    if (name === "timeout" && globalTimeout) return []
    const path = ["mcp", name]
    const record = decodeRecord(value)
    const oauth = Option.isSome(record) ? decodeRecord(record.value.oauth) : Option.none()
    const native =
      Option.isSome(record) &&
      (Object.hasOwn(record.value, "disabled") ||
        Object.hasOwn(record.value, "codemode") ||
        typeof record.value.timeout === "object" ||
        (Option.isSome(oauth) &&
          ["client_id", "client_secret", "callback_port", "redirect_uri"].some((key) =>
            Object.hasOwn(oauth.value, key),
          )))
    if (!native) {
      setOwn(servers, name, value)
      return []
    }
    const normalized = normalizeServer(value, path)
    // Keep invalid flat entries for the final V1 decoder rather than sanitizing them.
    setOwn(
      servers,
      name,
      Option.getOrElse(normalized.server, () => value),
    )
    return normalized.diagnostics
  })

  const enveloped =
    envelope && Option.isSome(nested)
      ? Object.entries(nested.value).flatMap(([name, value]): readonly Diagnostic[] => {
          const path = ["mcp", "servers", name]
          if (Object.hasOwn(servers, name)) return isDeepStrictEqual(servers[name], value) ? [] : [conflict(path)]
          const record = decodeRecord(value)
          if (
            Option.isSome(record) &&
            typeof record.value.enabled === "boolean" &&
            !Object.hasOwn(record.value, "disabled")
          ) {
            setOwn(servers, name, value)
            return []
          }
          const normalized = normalizeServer(value, path)
          if (Option.isSome(normalized.server)) setOwn(servers, name, normalized.server.value)
          return normalized.diagnostics
        })
      : []
  result.mcp = servers
  const diagnostics = [...flat, ...enveloped]

  if (!globalTimeout || Option.isNone(timeout)) return diagnostics
  const value = lowerTimeout(timeout.value)
  if (value === undefined)
    return Object.keys(timeout.value).length ? [...diagnostics, unsupported(["mcp", "timeout"])] : diagnostics
  const existing = decodeRecord(result.experimental)
  if (Object.hasOwn(result, "experimental") && Option.isNone(existing)) return diagnostics
  const experimental = Option.isSome(existing) ? { ...existing.value } : {}
  const merged = preferLegacy(experimental, "mcp_timeout", value, ["mcp", "timeout"])
  result.experimental = experimental
  return [...diagnostics, ...merged]
}

function isDirectServer(value: Record<string, unknown>) {
  // Object-valued entries can be servers literally named "type" or "enabled".
  return ["type", "enabled"].some(
    (key) =>
      Object.hasOwn(value, key) && (value[key] === null || typeof value[key] !== "object" || Array.isArray(value[key])),
  )
}

// A server that does not decode yields None and one "invalid" diagnostic.
function normalizeServer(
  input: unknown,
  path: string[],
): { readonly server: Option.Option<Record<string, unknown>>; readonly diagnostics: readonly Diagnostic[] } {
  const decoded = decodeServer(input)
  if (Option.isNone(decoded)) return { server: Option.none(), diagnostics: [invalid(path)] }
  const server = decoded.value
  const diagnostics = [
    ...(server.codemode !== undefined ? [unsupported([...path, "codemode"])] : []),
    ...(server.timeout && lowerTimeout(server.timeout) === undefined && Object.keys(server.timeout).length
      ? [unsupported([...path, "timeout"])]
      : []),
  ]
  const raw = decodeRecord(input)
  if (Option.isNone(raw) || !Object.hasOwn(raw.value, "enabled"))
    return { server: Option.some(lowerServer(server)), diagnostics }
  return {
    server: Option.some({ ...lowerServer(server), enabled: raw.value.enabled }),
    diagnostics:
      server.disabled !== undefined && raw.value.enabled === server.disabled
        ? [...diagnostics, conflict([...path, "disabled"])]
        : diagnostics,
  }
}

function normalizeLsp(input: Record<string, unknown>, result: Record<string, unknown>): readonly Diagnostic[] {
  const lsp = decodeRecord(input.lsp)
  if (Option.isNone(lsp)) return []
  const checked = Object.entries(lsp.value).map(([name, value]) => ({ name, value, keep: keepLsp(name, value) }))
  result.lsp = Object.fromEntries(checked.filter((entry) => entry.keep).map((entry) => [entry.name, entry.value]))
  return checked.filter((entry) => !entry.keep).map((entry) => unsupported(["lsp", entry.name]))
}

function keepLsp(name: string, value: unknown) {
  if (HashSet.has(builtinServers, name)) return true
  const entry = decodeLspEntry(value)
  if (Option.isNone(entry)) return true
  if (entry.value.disabled === true) return true
  return "extensions" in entry.value && entry.value.extensions !== undefined
}

function lowerSelection(input: Schema.Schema.Type<typeof Selection>) {
  if (typeof input !== "string") {
    return {
      model: `${input.providerID}/${input.model}`,
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
    }
  }
  const index = input.indexOf("#")
  if (index === -1) return { model: input }
  return { model: input.slice(0, index), variant: input.slice(index + 1) }
}

function lowerTimeout(input: Schema.Schema.Type<typeof Timeout>) {
  if (input.startup !== undefined) return undefined
  if (input.catalog === undefined || input.execution === undefined) return undefined
  if (input.catalog !== input.execution) return undefined
  return input.catalog
}

function lowerServer(input: Schema.Schema.Type<typeof Server>) {
  const result: Record<string, unknown> = {
    ...input,
    enabled: input.disabled !== true,
  }
  delete result.disabled
  delete result.codemode
  delete result.timeout

  if (input.timeout) {
    const timeout = lowerTimeout(input.timeout)
    if (timeout !== undefined) result.timeout = timeout
  }

  if (input.type === "remote" && input.oauth && typeof input.oauth === "object") {
    const oauth: Record<string, unknown> = {}
    if (input.oauth.client_id !== undefined) oauth.clientId = input.oauth.client_id
    if (input.oauth.client_secret !== undefined) oauth.clientSecret = input.oauth.client_secret
    if (input.oauth.scope !== undefined) oauth.scope = input.oauth.scope
    if (input.oauth.callback_port !== undefined) oauth.callbackPort = input.oauth.callback_port
    if (input.oauth.redirect_uri !== undefined) oauth.redirectUri = input.oauth.redirect_uri
    result.oauth = oauth
  }

  return result
}

function lowerAgent(input: Schema.Schema.Type<typeof Agent>) {
  const result: Record<string, unknown> = {}
  for (const key of ["description", "mode", "hidden", "color", "steps"] as const) {
    if (input[key] !== undefined) result[key] = input[key]
  }
  if (input.system !== undefined) result.prompt = input.system
  if (input.disabled !== undefined) result.disable = input.disabled
  if (input.model !== undefined) Object.assign(result, lowerSelection(input.model))
  if (input.request?.body !== undefined) result.options = input.request.body

  return result
}

function lowerCommand(input: Schema.Schema.Type<typeof Command>) {
  return { ...input, ...(input.model !== undefined ? lowerSelection(input.model) : {}) }
}

// Decodes a native value and applies it unless a legacy value already holds the key.
function lowerLegacy<A>(
  target: Record<string, unknown>,
  key: string,
  decode: (value: unknown) => Option.Option<A>,
  value: unknown,
  path: string[],
): readonly Diagnostic[] {
  const decoded = decode(value)
  if (Option.isNone(decoded)) return [invalid(path)]
  return preferLegacy(target, key, decoded.value, path)
}

function preferLegacy(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  path: string[],
): readonly Diagnostic[] {
  if (Object.hasOwn(target, key)) return isDeepStrictEqual(target[key], value) ? [] : [conflict(path)]
  setOwn(target, key, value)
  return []
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

function invalid(path: string[]): Diagnostic {
  return { kind: "invalid", path, message: "Native setting could not be lowered because it is malformed" }
}

function unsupported(path: string[]): Diagnostic {
  return { kind: "unsupported", path, message: "Omitted native setting that cannot be represented in V1" }
}

function conflict(path: string[]): Diagnostic {
  return { kind: "conflict", path, message: "Retained legacy value over native value" }
}
