import { Show, type Component, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { Option } from "effect"

type InputKey = "text" | "image" | "audio" | "video" | "pdf"
type InputMap = Record<InputKey, boolean>

const inputOrder: Array<InputKey> = ["text", "image", "audio", "video", "pdf"]

type ModelInfo = {
  id: string
  name: string
  provider: {
    name: string
  }
  capabilities?: {
    reasoning: boolean
    input: InputMap
  }
  modalities?: {
    input: Array<string>
  }
  reasoning?: boolean
  limit: {
    context: number
  }
}

function ModelTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

export const ModelTooltip: Component<{ model: ModelInfo; latest?: boolean; free?: boolean; v2?: boolean }> = (
  props,
) => {
  const language = useLanguage()
  const sourceName = (model: ModelInfo) => {
    const value = `${model.id} ${model.name}`.toLowerCase()

    if (/claude|anthropic/.test(value)) return language.t("model.provider.anthropic")
    if (/gpt|o[1-4]|codex|openai/.test(value)) return language.t("model.provider.openai")
    if (/gemini|palm|bard|google/.test(value)) return language.t("model.provider.google")
    if (/grok|xai/.test(value)) return language.t("model.provider.xai")
    if (/llama|meta/.test(value)) return language.t("model.provider.meta")

    return model.provider.name
  }
  const inputLabel = (value: string) => {
    if (value === "text") return language.t("model.input.text")
    if (value === "image") return language.t("model.input.image")
    if (value === "audio") return language.t("model.input.audio")
    if (value === "video") return language.t("model.input.video")
    if (value === "pdf") return language.t("model.input.pdf")
    return value
  }
  const tagSuffix = () => {
    const tags = [
      ...(props.latest ? [language.t("model.tag.latest")] : []),
      ...(props.free ? [language.t("model.tag.free")] : []),
    ]
    return tags.length ? ` (${tags.join(", ")})` : ""
  }
  const title = () => `${sourceName(props.model)} ${props.model.name}${tagSuffix()}`
  const name = () => `${props.model.name}${tagSuffix()}`
  const inputLabels = () => {
    const capabilities = props.model.capabilities
    if (capabilities) return inputOrder.filter((key) => capabilities.input[key]).map((key) => inputLabel(key))
    return (props.model.modalities?.input ?? []).map((value) => inputLabel(value))
  }
  const inputs = () => {
    const entries = inputLabels()
    return entries.length ? Option.some(entries.join(", ")) : Option.none<string>()
  }
  const reasoning = () => {
    if (props.model.capabilities)
      return props.model.capabilities.reasoning
        ? language.t("model.tooltip.reasoning.allowed")
        : language.t("model.tooltip.reasoning.none")
    return props.model.reasoning
      ? language.t("model.tooltip.reasoning.allowed")
      : language.t("model.tooltip.reasoning.none")
  }
  const context = () => language.t("model.tooltip.context", { limit: props.model.limit.context.toLocaleString() })
  const contextLimit = () => props.model.limit.context.toLocaleString(language.intl())

  if (props.v2) {
    return (
      <div class="flex w-[180px] flex-col gap-2">
        <ModelTooltipRow name={language.t("model.tooltip.model")} value={name()} />
        <ModelTooltipRow name={language.t("model.tooltip.provider")} value={props.model.provider.name} />
        <Show when={Option.getOrUndefined(inputs())}>
          {(value) => <ModelTooltipRow name={language.t("model.tooltip.inputs")} value={value()} />}
        </Show>
        <ModelTooltipRow name={language.t("model.tooltip.reasoning")} value={reasoning()} />
        <ModelTooltipRow name={language.t("model.tooltip.context.label")} value={contextLimit()} />
      </div>
    )
  }

  return (
    <div class="flex flex-col gap-1 py-1">
      <div class="text-13-medium">{title()}</div>
      <Show when={Option.getOrUndefined(inputs())}>
        {(value) => (
          <div class="text-12-regular text-text-invert-base">
            {language.t("model.tooltip.allows", { inputs: value() })}
          </div>
        )}
      </Show>
      <div class="text-12-regular text-text-invert-base">{reasoning()}</div>
      <div class="text-12-regular text-text-invert-base">{context()}</div>
    </div>
  )
}
