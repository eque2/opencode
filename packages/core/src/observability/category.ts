// Span-name namespaces mapped to the category taxonomy in specs/observability/logging-sites.md. The first
// matching rule wins, so the narrow rules come first.
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/HttpApi$/, "http"],
  [/^(ServerAuth|Server|MDNS)$/, "http"],
  [/^(Question|QuestionV2)$/, "question"],
  [/^(Pty|PtyTicket|PtyHandler|PtyEnvironment)$/, "pty"],
  [/^(Permission|PermissionSaved)$/, "permission"],
  [/^(MCP|Mcp[A-Z]\w*)$/, "mcp"],
  [/^LSP/, "lsp"],
  [/Auth$|^(Credential|Integration|Auth|Account|AccountRepo)$/, "auth"],
  [
    /^(LLM|LLMClient|LLMRequestPrep|AISDK|AnthropicMessages|OpenAIChat|OpenAIResponses|OpenAIWebSocketPool|Gemini|BedrockConverse|BedrockMedia|CopilotResponses|GithubCopilot|OpenRouter)$/,
    "llm",
  ],
  [
    /^(Provider|ProviderShared|ModelsDev|CatalogV2|CopilotModels|DynamicProvider|ModalModels|SessionRunnerModel)$/,
    "provider",
  ],
  [
    /Tool$|^(ToolRegistry|Tool|Truncate|ToolOutputStore|CodeMode|ApplicationTools|FileMutation|SessionTools|WebSearch|McpWebSearch)$/,
    "tool",
  ],
  [/^(Share|ShareNext|SessionShare|Slack)$/, "share"],
  [/^(Plugin|Plugin[A-Z]\w*|OpencodePlugin|ModalPlugin|TuiPluginRuntime)$/, "plugin"],
  [
    /^(Session|Session[A-Z]\w*|V2Session|MessageV2|PromptSubmit|MoveSession|Todo|Snapshot|Patch|SystemPrompt|Instruction|InstructionContext|SystemContextRegistry|Agent|AgentV2|BackgroundJob)$/,
    "session",
  ],
  [/^(Config|Config[A-Z]\w*|TuiConfig|Env)$/, "config"],
  [/^(Storage|SQLiteDrizzle|State|RepositoryCache|Database)$/, "storage"],
  [/^(Workspace|Workspace[A-Z]\w*|Worktree|WorktreeAdapter|ProjectCopy|DebugWorkspace)$/, "workspace"],
  [/^(Git|Vcs)$/, "git"],
  [/^(AppProcess|Shell|FileSystem|Flock|EffectFlock|Npm|Format|Image|Archive|Bom)$/, "process"],
  [/^(Cli|cli|Run[A-Z]\w*|Tui\w*|UI|Heap|Installation|Ide)$/, "cli"],
  [/^(ACP\w*)$/, "acp"],
  [/^(Skill|SkillV2|SkillDiscovery|SkillGuidance|Discovery|Command|CommandV2)$/, "skill"],
  [/^(Project|ProjectDirectories|InstanceStore|InstanceRegistry|InstanceBootstrap)$/, "project"],
  [/^EventV2$/, "bus"],
]

// Per-message lowering and per-chunk stream handlers in the protocol modules run many times for each request.
const CHUNK = /^(lower[A-Z]\w*|on\w*(Delta|Stop|Done))$/

/** The taxonomy domain of a span name such as `MCP.create`: `mcp`. An unknown namespace is its lowercase form. */
export function domain(spanName: string) {
  const namespace = spanName.split(".")[0] ?? spanName
  return RULES.find(([pattern]) => pattern.test(namespace))?.[1] ?? namespace.toLowerCase()
}

/** The category of a span record: the domain and the span name, or `llm.chunk` for a per-chunk protocol span. */
export function spanCategory(spanName: string) {
  const [namespace, ...rest] = spanName.split(".")
  const d = domain(spanName)
  if (d === "llm" && CHUNK.test(rest.join("."))) return "llm.chunk"
  return namespace === undefined ? d : `${d}.${spanName}`
}

/** The category of a bus event record. Per-token deltas share `bus.delta`, which is off by default. */
export function eventCategory(type: string) {
  return /(^|\.)delta$/.test(type) ? `bus.delta.${type}` : `bus.${type}`
}
