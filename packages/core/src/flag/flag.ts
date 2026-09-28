import { Config, ConfigProvider, Effect, Option } from "effect"

function isTruthy(value: string) {
  const lower = value.toLowerCase()
  return lower === "true" || lower === "1"
}

/** A flag that is true only when the variable is "true" or "1", in any case. */
export function truthyConfig(key: string) {
  return Config.String(key).pipe(Config.map(isTruthy), Config.withDefault(false))
}

/** An experimental flag: the variable wins when set, else OPENCODE_EXPERIMENTAL. */
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

// The ambient ConfigProvider copies the environment once. Tests, the CLI and external
// tooling set some variables after start, so their entries parse a fresh environment
// provider on every run. That provider keeps empty strings.
function live<A>(config: Config.Config<A>) {
  return Effect.suspend(() => config.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })))
}

const optionalString = (key: string) => Config.option(Config.String(key))

/**
 * The opencode flags, one Config per variable, keyed by the variable name. Yield them inside
 * an Effect. Plain entries read the ambient ConfigProvider, so tests override them with
 * ConfigProvider.layer; an empty variable counts as not set there. The entries wrapped in
 * live() read the environment at each run and keep empty strings.
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
