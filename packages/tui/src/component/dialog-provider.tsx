import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"
import { useConnected } from "./use-connected"
import { useBindings } from "../keymap"
import { useClipboard } from "../context/clipboard"
import { Data, Effect, Option, Predicate, Schema } from "effect"

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  "opencode-go": 1,
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
}

const CUSTOM_PROVIDER_OPTION_VALUE = "__opencode_custom_provider__"
// The toast shows an SDK error body as JSON text, whatever shape the server sent.
const errorJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The clipboard rejected the provider code. */
class CopyError extends Data.TaggedError("DialogProvider.CopyError")<{ readonly cause: unknown }> {}

/**
 * Runs a dialog flow in the background. DialogSelect, DialogPrompt and onMount drop the result of a
 * handler, so an SDK rejection used to go unhandled. Such a defect now goes to Effect.logError.
 */
function runFlow(flow: Effect.Effect<void>) {
  Effect.runFork(flow.pipe(Effect.tapDefect((defect) => Effect.logError(defect))))
}
const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type ProviderOptionBase = {
  title: string
  value: string
  description?: string
  category: string
}

type ProviderOption =
  | (ProviderOptionBase & {
      type: "provider"
      providerID: string
    })
  | (ProviderOptionBase & {
      type: "custom"
    })

export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  return [
    ...sortBy(
      list,
      (x) => PROVIDER_PRIORITY[x.id] ?? 99,
      (x) => x.name.toLowerCase(),
      (x) => x.id,
    ).map((provider) => ({
      type: "provider" as const,
      title: provider.name,
      value: provider.id,
      providerID: provider.id,
      description: {
        opencode: "(Recommended)",
        anthropic: "(API key)",
        openai: "(ChatGPT Plus/Pro or API key)",
        "opencode-go": "Low cost subscription for everyone",
      }[provider.id],
      category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Providers",
    })),
    {
      type: "custom",
      title: "Other",
      value: CUSTOM_PROVIDER_OPTION_VALUE,
      description: "Custom provider",
      category: "Providers",
    },
  ]
}

/** Trims the input and drops an "@ai-sdk/" prefix. The result is none when the id is not a valid provider id. */
export function normalizeCustomProviderID(value: string): Option.Option<string> {
  const providerID = value.trim().replace(/^@ai-sdk\//, "")
  return CUSTOM_PROVIDER_ID.test(providerID) ? Option.some(providerID) : Option.none()
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()

  // Asks until the id is valid. None means the user closed the prompt.
  const promptCustomProviderID = (): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      const value = yield* Effect.promise(() =>
        DialogPrompt.show(dialog, "Other", {
          placeholder: "Provider id",
          description: () => (
            <text fg={theme.textMuted}>
              This only stores a credential. Configure the provider in opencode.json to use it.
            </text>
          ),
        }),
      )
      if (Predicate.isNull(value)) return Option.none()

      const providerID = normalizeCustomProviderID(value)
      if (Option.isSome(providerID)) return providerID

      toast.show({
        variant: "error",
        message:
          "Provider ids must start with a lowercase letter or number and only use lowercase letters, numbers, hyphens, and underscores",
      })
      return yield* promptCustomProviderID()
    })

  const connectProvider = (providerID: string) =>
    Effect.gen(function* () {
      const methods = sync.data.provider_auth[providerID] ?? [
        {
          type: "api",
          label: "API key",
        },
      ]
      const index = methods.length > 1 ? yield* chooseAuthMethod(dialog, methods) : Option.some(0)
      if (Option.isNone(index)) return
      const method = methods[index.value]
      if (method.type === "oauth") {
        let inputs = Option.none<Record<string, string>>()
        if (method.prompts?.length) {
          const value = yield* PromptsMethod({
            dialog,
            prompts: method.prompts,
          })
          if (Option.isNone(value)) return
          inputs = value
        }

        const result = yield* Effect.promise(() =>
          sdk.client.provider.oauth.authorize({
            providerID,
            method: index.value,
            // The SDK takes an optional record. With no prompts the value is undefined, which the JSON body leaves out.
            inputs: Option.getOrUndefined(inputs),
          }),
        )
        if (result.error) {
          toast.show({
            variant: "error",
            message: errorJson(result.error),
          })
          dialog.clear()
          return
        }
        if (result.data?.method === "code") {
          dialog.replace(() => (
            <CodeMethod providerID={providerID} title={method.label} index={index.value} authorization={result.data} />
          ))
        }
        if (result.data?.method === "auto") {
          dialog.replace(() => (
            <AutoMethod providerID={providerID} title={method.label} index={index.value} authorization={result.data} />
          ))
        }
      }
      if (method.type === "api") {
        let metadata = Option.none<Record<string, string>>()
        if (method.prompts?.length) {
          const value = yield* PromptsMethod({ dialog, prompts: method.prompts })
          if (Option.isNone(value)) return
          metadata = value
        }
        dialog.replace(() => <ApiMethod providerID={providerID} title={method.label} metadata={metadata} />)
      }
    })

  const options = createMemo(() => {
    return pipe(
      providerOptions(sync.data.provider_next.all),
      map((provider) => {
        if (provider.type === "custom") {
          return {
            title: provider.title,
            value: provider.value,
            description: provider.description,
            category: provider.category,
            onSelect() {
              runFlow(
                Effect.gen(function* () {
                  const providerID = yield* promptCustomProviderID()
                  if (Option.isNone(providerID)) return
                  dialog.replace(() => (
                    <ApiMethod providerID={providerID.value} title="API key" metadata={Option.none()} custom />
                  ))
                }),
              )
            },
          }
        }

        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        const connected = sync.data.provider_next.connected.includes(providerID)

        return {
          title: provider.title,
          value: provider.value,
          description: provider.description,
          ...(consoleManaged ? { footer: sync.data.console_state.activeOrgName } : {}),
          category: provider.category,
          ...(connected && onboarded() ? { gutter: () => <text fg={theme.success}>✓</text> } : {}),
          onSelect() {
            if (consoleManaged) return
            runFlow(connectProvider(providerID))
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Connect a provider" options={options()} />
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const clipboard = useClipboard()

  useBindings(() => ({
    bindings: [
      {
        key: "c",
        desc: "Copy provider code",
        group: "Dialog",
        cmd: () => {
          const code =
            props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
          const written = clipboard.write?.(code)
          if (!written) return
          Effect.runFork(
            Effect.tryPromise({ try: () => written, catch: (cause) => new CopyError({ cause }) }).pipe(
              Effect.andThen(Effect.sync(() => toast.show({ message: "Copied to clipboard", variant: "info" }))),
              Effect.catch((error) => Effect.sync(() => toast.error(error.cause))),
            ),
          )
        },
      },
    ],
  }))

  onMount(() => {
    runFlow(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          sdk.client.provider.oauth.callback({
            providerID: props.providerID,
            method: props.index,
          }),
        )
        if (result.error) {
          toast.show({
            variant: "error",
            message:
              "name" in result.error && result.error.name === "ProviderAuthOauthCallbackFailed"
                ? "OAuth authorization failed. Try /connect again."
                : errorJson(result.error),
          })
          dialog.clear()
          return
        }
        yield* Effect.promise(() => sdk.client.instance.dispose())
        yield* Effect.promise(() => sync.bootstrap())
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }),
    )
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization…</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={(value) => {
        runFlow(
          Effect.gen(function* () {
            const { error } = yield* Effect.promise(() =>
              sdk.client.provider.oauth.callback({
                providerID: props.providerID,
                method: props.index,
                code: value,
              }),
            )
            if (!error) {
              yield* Effect.promise(() => sdk.client.instance.dispose())
              yield* Effect.promise(() => sync.bootstrap())
              dialog.replace(() => <DialogModel providerID={props.providerID} />)
              return
            }
            setError(true)
          }),
        )
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata: Option.Option<Record<string, string>>
  custom?: boolean
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={() =>
        ({
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Zen gives you access to all the best coding models at the cheapest prices with a single API
                key.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> to get a key
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Go is a $10 per month subscription that provides reliable access to popular open coding models
                with generous usage limits.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/go</span> and enable OpenCode Go
              </text>
            </box>
          ),
        })[props.providerID]
      }
      onConfirm={(value) => {
        if (!value) return
        runFlow(
          Effect.gen(function* () {
            const metadata = props.metadata
            yield* Effect.promise(() =>
              sdk.client.auth.set({
                providerID: props.providerID,
                auth: {
                  type: "api",
                  key: value,
                  ...(Option.isSome(metadata) ? { metadata: metadata.value } : {}),
                },
              }),
            )
            yield* Effect.promise(() => sdk.client.instance.dispose())
            yield* Effect.promise(() => sync.bootstrap())
            if (props.custom && !sync.data.provider_next.all.some((provider) => provider.id === props.providerID)) {
              toast.show({
                variant: "info",
                message: `Saved credential for ${props.providerID}. Configure it in opencode.json to use it.`,
              })
              dialog.clear()
              return
            }
            dialog.replace(() => <DialogModel providerID={props.providerID} />)
          }),
        )
      }}
    />
  )
}

/** Asks the user to pick an auth method. None means the dialog closed first. */
function chooseAuthMethod(dialog: ReturnType<typeof useDialog>, methods: ProviderAuthMethod[]) {
  return Effect.callback<Option.Option<number>>((resume) => {
    dialog.replace(
      () => (
        <DialogSelect
          title="Select auth method"
          options={methods.map((x, index) => ({
            title: x.label,
            value: index,
          }))}
          onSelect={(option) => resume(Effect.succeed(Option.some(option.value)))}
        />
      ),
      () => resume(Effect.succeed(Option.none())),
    )
  })
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
/** Asks each applicable prompt in turn. None means the user closed a prompt. */
function PromptsMethod(props: PromptsMethodProps): Effect.Effect<Option.Option<Record<string, string>>> {
  return Effect.gen(function* () {
    const inputs: Record<string, string> = {}
    for (const prompt of props.prompts) {
      if (prompt.when) {
        const value = inputs[prompt.when.key]
        if (value === undefined) continue
        const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
        if (!matches) continue
      }

      if (prompt.type === "select") {
        const value = yield* Effect.callback<Option.Option<string>>((resume) => {
          props.dialog.replace(
            () => (
              <DialogSelect
                title={prompt.message}
                options={prompt.options.map((x) => ({
                  title: x.label,
                  value: x.value,
                  description: x.hint,
                }))}
                onSelect={(option) => resume(Effect.succeed(Option.some(option.value)))}
              />
            ),
            () => resume(Effect.succeed(Option.none())),
          )
        })
        if (Option.isNone(value)) return Option.none()
        inputs[prompt.key] = value.value
        continue
      }

      const value = yield* Effect.callback<Option.Option<string>>((resume) => {
        props.dialog.replace(
          () => (
            <DialogPrompt
              title={prompt.message}
              placeholder={prompt.placeholder}
              onConfirm={(value) => resume(Effect.succeed(Option.some(value)))}
            />
          ),
          () => resume(Effect.succeed(Option.none())),
        )
      })
      if (Option.isNone(value)) return Option.none()
      inputs[prompt.key] = value.value
    }
    return Option.some(inputs)
  })
}
