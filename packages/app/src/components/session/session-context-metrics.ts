import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"
import { Array as Arr, Option } from "effect"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  total: number
  usage: Option.Option<number>
}

const tokenTotal = (msg: AssistantMessage) => {
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const lastAssistantWithTokens = (messages: Message[]) =>
  Arr.findLast(messages, (msg): msg is AssistantMessage => msg.role === "assistant" && tokenTotal(msg) > 0)

const build = (messages: Message[] = [], providers: Provider[] = []): Context | undefined => {
  const found = lastAssistantWithTokens(messages)
  if (Option.isNone(found)) return undefined
  const message = found.value

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.providerID,
    modelLabel: model?.name ?? message.modelID,
    limit,
    input: message.tokens.input,
    total,
    usage: limit ? Option.some(Math.round((total / limit) * 100)) : Option.none(),
  }
}

export function getSessionContext(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
