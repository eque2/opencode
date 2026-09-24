import { Config, ConfigProvider, Effect, Option } from "effect"

function isTruthy(value: string) {
  const lower = value.toLowerCase()
  return lower === "true" || lower === "1"
}

export function truthy(key: string) {
  const value = process.env[key]
  return value !== undefined && isTruthy(value)
}

const copy = process.env["OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["OPENCODE_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("OPENCODE_EXPERIMENTAL") : truthy(key)
}

/** Config form of truthy(key): true only when the variable is "true" or "1", in any case. */
export function truthyConfig(key: string) {
  return Config.String(key).pipe(Config.map(isTruthy), Config.withDefault(false))
}

/** Config form of enabledByExperimental(key): the variable wins when set, else OPENCODE_EXPERIMENTAL. */
function experimentalConfig(key: string) {
  return Config.all({ umbrella: truthyConfig("OPENCODE_EXPERIMENTAL"), value: Config.option(Config.String(key)) }).pipe(
    Config.map(({ umbrella, value }) => Option.match(value, { onNone: () => umbrella, onSome: isTruthy })),
  )
}

/** A truthy flag whose default, when the variable is not set, is true on Windows only. */
function windowsDefaultConfig(key: string) {
  return Config.option(Config.String(key)).pipe(
    Config.map(Option.match({ onNone: () => process.platform === "win32", onSome: isTruthy })),
  )
}

// The ambient ConfigProvider copies the environment once. The Flag getters below exist
// because tests, the CLI and external tooling set their variables after start, so their
// Config forms parse a fresh environment provider on every run. That provider keeps empty
// strings, as the getters did.
function live<A>(config: Config.Config<A>) {
  return Effect.suspend(() => config.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })))
}

const optionalString = (key: string) => Config.option(Config.String(key))

/**
 * Config forms of the Flag entries, keyed by the same names. Yield them inside an Effect
 * instead of reading Flag. Load-time entries read the ambient ConfigProvider, so tests
 * override them with ConfigProvider.layer; an empty variable counts as not set there.
 * Entries that are getters on Flag read the live environment.
 */
export const FlagConfig = {
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString("OTEL_EXPORTER_OTLP_ENDPOINT"),
  OTEL_EXPORTER_OTLP_HEADERS: optionalString("OTEL_EXPORTER_OTLP_HEADERS"),

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthyConfig("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: optionalString("OPENCODE_GIT_BASH_PATH"),
  OPENCODE_CONFIG: optionalString("OPENCODE_CONFIG"),
  OPENCODE_CONFIG_CONTENT: optionalString("OPENCODE_CONFIG_CONTENT"),
  OPENCODE_DISABLE_AUTOUPDATE: truthyConfig("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthyConfig("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthyConfig("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthyConfig("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthyConfig("OPENCODE_SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthyConfig("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthyConfig("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthyConfig("OPENCODE_DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: optionalString("OPENCODE_FAKE_VCS"),
  OPENCODE_SERVER_PASSWORD: optionalString("OPENCODE_SERVER_PASSWORD"),
  OPENCODE_SERVER_USERNAME: optionalString("OPENCODE_SERVER_USERNAME"),
  OPENCODE_DISABLE_FFF: windowsDefaultConfig("OPENCODE_DISABLE_FFF"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: Config.Boolean("OPENCODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.Boolean("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: windowsDefaultConfig("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: optionalString("OPENCODE_MODELS_URL"),
  OPENCODE_MODELS_PATH: optionalString("OPENCODE_MODELS_PATH"),
  OPENCODE_DB: optionalString("OPENCODE_DB"),

  OPENCODE_WORKSPACE_ID: optionalString("OPENCODE_WORKSPACE_ID"),
  OPENCODE_EXPERIMENTAL_WORKSPACES: experimentalConfig("OPENCODE_EXPERIMENTAL_WORKSPACES"),

  OPENCODE_DISABLE_PROJECT_CONFIG: live(truthyConfig("OPENCODE_DISABLE_PROJECT_CONFIG")),
  OPENCODE_EXPERIMENTAL_REFERENCES: live(experimentalConfig("OPENCODE_EXPERIMENTAL_REFERENCES")),
  OPENCODE_TUI_CONFIG: live(optionalString("OPENCODE_TUI_CONFIG")),
  OPENCODE_CONFIG_DIR: live(optionalString("OPENCODE_CONFIG_DIR")),
  OPENCODE_TEST_HOME: live(optionalString("OPENCODE_TEST_HOME")),
  OPENCODE_PURE: live(truthyConfig("OPENCODE_PURE")),
  OPENCODE_PERMISSION: live(optionalString("OPENCODE_PERMISSION")),
  OPENCODE_PLUGIN_META_FILE: live(optionalString("OPENCODE_PLUGIN_META_FILE")),
  OPENCODE_CLIENT: live(Config.String("OPENCODE_CLIENT").pipe(Config.withDefault("cli"))),
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthy("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: process.env["OPENCODE_GIT_BASH_PATH"],
  OPENCODE_CONFIG: process.env["OPENCODE_CONFIG"],
  OPENCODE_CONFIG_CONTENT: process.env["OPENCODE_CONFIG_CONTENT"],
  OPENCODE_DISABLE_AUTOUPDATE: truthy("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthy("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthy("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("OPENCODE_SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthy("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthy("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthy("OPENCODE_DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: process.env["OPENCODE_FAKE_VCS"],
  OPENCODE_SERVER_PASSWORD: process.env["OPENCODE_SERVER_PASSWORD"],
  OPENCODE_SERVER_USERNAME: process.env["OPENCODE_SERVER_USERNAME"],
  OPENCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("OPENCODE_DISABLE_FFF"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: FlagConfig.OPENCODE_EXPERIMENTAL_FILEWATCHER,
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: FlagConfig.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER,
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: process.env["OPENCODE_MODELS_URL"],
  OPENCODE_MODELS_PATH: process.env["OPENCODE_MODELS_PATH"],
  OPENCODE_DB: process.env["OPENCODE_DB"],

  OPENCODE_WORKSPACE_ID: process.env["OPENCODE_WORKSPACE_ID"],
  OPENCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES")
  },
  get OPENCODE_TUI_CONFIG() {
    return process.env["OPENCODE_TUI_CONFIG"]
  },
  get OPENCODE_CONFIG_DIR() {
    return process.env["OPENCODE_CONFIG_DIR"]
  },
  get OPENCODE_PURE() {
    return truthy("OPENCODE_PURE")
  },
  get OPENCODE_PERMISSION() {
    return process.env["OPENCODE_PERMISSION"]
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return process.env["OPENCODE_PLUGIN_META_FILE"]
  },
  get OPENCODE_CLIENT() {
    return process.env["OPENCODE_CLIENT"] ?? "cli"
  },
}
