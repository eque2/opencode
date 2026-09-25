import { TextField } from "@opencode-ai/ui/text-field"
import * as Sentry from "@sentry/solid"
import { Logo } from "@opencode-ai/ui/logo"
import { Button } from "@opencode-ai/ui/button"
import { Component, createSignal, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { Icon } from "@opencode-ai/ui/icon"
import { errorDescriptionKey } from "./error-description"
import { Data, Effect, Fiber, Option, Predicate, Schema } from "effect"

export type InitError = {
  name: string
  data: Record<string, unknown>
}

type Translator = ReturnType<typeof useLanguage>["t"]
const CHAIN_SEPARATOR = "\n" + "─".repeat(40) + "\n"

function isIssue(value: unknown): value is { message: string; path: string[] } {
  if (!value || typeof value !== "object") return false
  if (!("message" in value) || !("path" in value)) return false
  const message = (value as { message: unknown }).message
  const path = (value as { path: unknown }).path
  if (typeof message !== "string") return false
  if (!Array.isArray(path)) return false
  return path.every((part) => typeof part === "string")
}

function isInitError(error: unknown): error is InitError {
  return Predicate.isObjectOrArray(error) && "name" in error && "data" in error && typeof error.data === "object"
}

/**
 * Encodes a value as indented JSON text. A bigint becomes its digits, and an object seen before becomes
 * `circular`. A value with no JSON form (undefined, a function or a symbol) falls back to String(value).
 */
function safeJson(value: unknown, circular: string): string {
  const seen = new WeakSet<object>()
  const encode = Schema.encodeOption(
    Schema.fromJsonString(Schema.Unknown, {
      space: 2,
      replacer: (_key: string, val: unknown) => {
        if (typeof val === "bigint") return val.toString()
        if (typeof val === "object" && val) {
          if (seen.has(val)) return circular
          seen.add(val)
        }
        return val
      },
    }),
  )
  return Option.getOrElse(encode(value), () => String(value))
}

function formatInitError(error: InitError, t: Translator): string {
  const data = error.data
  const json = (value: unknown) => safeJson(value, t("error.page.circular"))
  switch (error.name) {
    case "MCPFailed": {
      const name = typeof data.name === "string" ? data.name : ""
      return t("error.chain.mcpFailed", { name })
    }
    case "ProviderAuthError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : t("common.unknown")
      const message = typeof data.message === "string" ? data.message : json(data.message)
      return t("error.chain.providerAuthFailed", { provider: providerID, message })
    }
    case "APIError": {
      const message = typeof data.message === "string" ? data.message : t("error.chain.apiError")
      return [
        message,
        ...(typeof data.statusCode === "number" ? [t("error.chain.status", { status: data.statusCode })] : []),
        ...(typeof data.isRetryable === "boolean" ? [t("error.chain.retryable", { retryable: data.isRetryable })] : []),
        ...(typeof data.responseBody === "string" && data.responseBody
          ? [t("error.chain.responseBody", { body: data.responseBody })]
          : []),
      ].join("\n")
    }
    case "ProviderModelNotFoundError": {
      const suggestionsLine =
        Array.isArray(data.suggestions) && data.suggestions.length
          ? [t("error.chain.didYouMean", { suggestions: data.suggestions.join(", ") })]
          : []

      // The template shows a field of another type as its String form, as it did before these reads were typed.
      return [
        t("error.chain.modelNotFound", { provider: String(data.providerID), model: String(data.modelID) }),
        ...suggestionsLine,
        t("error.chain.checkConfig"),
      ].join("\n")
    }
    case "ProviderInitError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : t("common.unknown")
      return t("error.chain.providerInitFailed", { provider: providerID })
    }
    case "ConfigJsonError": {
      const path = typeof data.path === "string" ? data.path : json(data.path)
      const message = typeof data.message === "string" ? data.message : ""
      if (message) return t("error.chain.configJsonInvalidWithMessage", { path, message })
      return t("error.chain.configJsonInvalid", { path })
    }
    case "ConfigDirectoryTypoError": {
      const path = typeof data.path === "string" ? data.path : json(data.path)
      const dir = typeof data.dir === "string" ? data.dir : json(data.dir)
      const suggestion = typeof data.suggestion === "string" ? data.suggestion : json(data.suggestion)
      return t("error.chain.configDirectoryTypo", { dir, path, suggestion })
    }
    case "ConfigFrontmatterError": {
      const path = typeof data.path === "string" ? data.path : json(data.path)
      const message = typeof data.message === "string" ? data.message : json(data.message)
      return t("error.chain.configFrontmatterError", { path, message })
    }
    case "ConfigInvalidError": {
      const issues = Array.isArray(data.issues)
        ? data.issues.filter(isIssue).map((issue) => "↳ " + issue.message + " " + issue.path.join("."))
        : []
      const message = typeof data.message === "string" ? data.message : ""
      const path = typeof data.path === "string" ? data.path : json(data.path)

      const line = message
        ? t("error.chain.configInvalidWithMessage", { path, message })
        : t("error.chain.configInvalid", { path })

      return [line, ...issues].join("\n")
    }
    case "UnknownError":
      return typeof data.message === "string" ? data.message : json(data)
    default:
      if (typeof data.message === "string") return data.message
      return json(data)
  }
}

function formatErrorChain(error: unknown, t: Translator, depth = 0, parentMessage?: string): string {
  const json = (value: unknown) => safeJson(value, t("error.page.circular"))
  if (!error) return t("error.chain.unknown")

  if (isInitError(error)) {
    const message = formatInitError(error, t)
    if (depth > 0 && parentMessage === message) return ""
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
    return indent + `${error.name}\n${message}`
  }

  if (error instanceof Error) {
    const isDuplicate = depth > 0 && parentMessage === error.message
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
    const header = `${error.name}${error.message ? `: ${error.message}` : ""}`
    const causeResult = error.cause ? formatErrorChain(error.cause, t, depth + 1, error.message) : ""
    return [
      ...errorParts(error.stack?.trim(), header, isDuplicate).map((part) => indent + part),
      ...(causeResult ? [causeResult] : []),
    ].join("\n\n")
  }

  if (typeof error === "string") {
    if (depth > 0 && parentMessage === error) return ""
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
    return indent + error
  }

  const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
  return indent + json(error)
}

/**
 * The text of one error in the chain. A duplicate of its parent message shows only the stack trace;
 * otherwise the header comes first, unless the stack already starts with it.
 */
function errorParts(stack: string | undefined, header: string, isDuplicate: boolean): string[] {
  if (!stack) return isDuplicate ? [] : [header]
  const startsWithHeader = stack.startsWith(header)
  if (isDuplicate && startsWithHeader) {
    const trace = stack.split("\n").slice(1).join("\n").trim()
    return trace ? [trace] : []
  }
  if (!isDuplicate && !startsWithHeader) return [`${header}\n${stack}`]
  return [stack]
}

function formatError(error: unknown, t: Translator): string {
  return formatErrorChain(error, t, 0)
}

interface ErrorPageProps {
  error: unknown
}

/** A platform action of the error page that rejected. `cause` is the original rejection. */
class ErrorPageActionError extends Data.TaggedError("App.ErrorPageActionError")<{ readonly cause: unknown }> {}

/** Runs one platform call as an Effect. A rejection fails with ErrorPageActionError. */
const platformAction = <A,>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ErrorPageActionError({ cause }) })

/** Runs an optional platform call. When the platform has no such method, it succeeds at once. */
const optionalPlatformAction = <A,>(call: () => Promise<A> | undefined) =>
  Effect.suspend(() =>
    Option.match(Option.fromNullishOr(call()), {
      onNone: () => Effect.void,
      onSome: (pending) => Effect.asVoid(platformAction(() => pending)),
    }),
  )

/**
 * Runs an error page action in the background. A failure or defect goes to the
 * Effect logger, as an unhandled rejection went to the console before.
 */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

export const ErrorPage: Component<ErrorPageProps> = (props) => {
  const platform = usePlatform()
  const language = useLanguage()
  const formattedError = () => formatError(props.error, language.t)
  const [store, setStore] = createStore({
    // The message of the last failed action; none after a success.
    actionError: Option.none<string>(),
  })
  const recordFatalError = optionalPlatformAction(() =>
    platform.recordFatalRendererError?.({
      error: formattedError(),
      url: location.href,
      version: platform.version,
      platform: platform.platform,
      os: platform.os,
    }),
  )
  let fatalErrorRecording = Option.none<Fiber.Fiber<void, ErrorPageActionError>>()

  /** Starts recording the fatal error on the first call. Every call returns that one recording. */
  function startFatalErrorRecording() {
    const recording = Option.getOrElse(fatalErrorRecording, () => Effect.runFork(recordFatalError))
    fatalErrorRecording = Option.some(recording)
    return recording
  }

  /** Shows the error of a failed action, or clears the shown error after a success. */
  const showActionResult = <A,>(action: Effect.Effect<A, ErrorPageActionError>) =>
    Effect.match(action, {
      onFailure: (error) => setStore("actionError", Option.some(formatError(error.cause, language.t))),
      onSuccess: () => setStore("actionError", Option.none()),
    })

  // Nothing waits for this recording here, so a failure is dropped, as before.
  onMount(() => {
    startFatalErrorRecording()
  })

  function checkForUpdates() {
    const updater = platform.updater
    runDetached(
      Effect.gen(function* () {
        const state = updater ? Option.some(yield* platformAction(() => updater.check())) : Option.none()
        setStore(
          "actionError",
          Option.flatMap(state, (next) => (next.status === "error" ? Option.some(next.message) : Option.none())),
        )
      }),
    )
  }

  function installUpdate() {
    const updater = platform.updater
    if (!updater) return
    runDetached(showActionResult(platformAction(() => updater.install())))
  }

  const updateVersion = () => {
    const state = platform.updater?.state()
    if (state?.status !== "ready") return
    return state.version
  }

  function exportDebugLogs() {
    if (!platform.exportDebugLogs) return
    // The logs must include the fatal error record, so the export waits for it.
    runDetached(
      showActionResult(
        Fiber.join(startFatalErrorRecording()).pipe(
          Effect.andThen(optionalPlatformAction(() => platform.exportDebugLogs?.())),
        ),
      ),
    )
  }

  return (
    <div
      class="relative flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center font-sans"
      data-tauri-drag-region
    >
      <div class="w-2/3 max-w-3xl flex flex-col items-center justify-center gap-8">
        <Logo class="w-58.5 opacity-12 shrink-0" />
        <div class="flex flex-col items-center gap-2 text-center">
          <h1 class="text-lg font-medium text-text-strong">{language.t("error.page.title")}</h1>
          <p class="text-sm text-text-weak">{language.t(errorDescriptionKey(props.error))}</p>
        </div>
        <TextField
          value={formattedError()}
          readOnly
          copyable
          multiline
          class="max-h-96 w-full font-mono text-xs no-scrollbar"
          label={language.t("error.page.details.label")}
          hideLabel
        />
        <div class="flex flex-row items-center justify-center gap-3 flex-wrap max-w-64">
          <Button size="large" onClick={platform.restart}>
            {language.t("error.page.action.restart")}
          </Button>
          <Show when={platform.platform === "desktop" && platform.exportDebugLogs}>
            <Button size="large" variant="ghost" onClick={exportDebugLogs}>
              {language.t("error.page.action.exportLogs")}
            </Button>
          </Show>
          <Show when={Sentry.isEnabled}>
            {(_) => {
              const [reported, setReported] = createSignal(false)
              return (
                <Button
                  size="large"
                  disabled={reported()}
                  onClick={() => {
                    Sentry.captureException(props.error)
                    setReported(true)
                  }}
                >
                  {language.t(reported() ? "error.page.action.reported" : "error.page.action.report")}
                </Button>
              )
            }}
          </Show>
          <Show when={platform.updater}>
            <Show
              when={updateVersion()}
              fallback={
                <Button
                  size="large"
                  variant="ghost"
                  onClick={checkForUpdates}
                  disabled={["checking", "downloading", "installing"].includes(platform.updater?.state().status ?? "")}
                >
                  {platform.updater?.state().status === "checking"
                    ? language.t("error.page.action.checking")
                    : language.t("error.page.action.checkUpdates")}
                </Button>
              }
            >
              {(version) => (
                <Button size="large" onClick={installUpdate}>
                  {language.t("error.page.action.updateTo", { version: version() })}
                </Button>
              )}
            </Show>
          </Show>
        </div>
        <Show when={Option.getOrUndefined(store.actionError)}>
          {(message) => <p class="text-xs text-text-danger-base text-center max-w-2xl">{message()}</p>}
        </Show>
        <div class="flex flex-col items-center gap-2">
          <div class="flex items-center justify-center gap-1">
            {language.t("error.page.report.prefix")}
            <button
              type="button"
              class="flex items-center text-text-interactive-base gap-1"
              onClick={() => platform.openExternal("https://opencode.ai/desktop-feedback")}
            >
              <div>{language.t("error.page.report.discord")}</div>
              <Icon name="discord" class="text-text-interactive-base" />
            </button>
          </div>
          <Show when={platform.version}>
            {(version) => (
              <p class="text-xs text-text-weak">{language.t("error.page.version", { version: version() })}</p>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
