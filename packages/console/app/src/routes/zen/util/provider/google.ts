import { z } from "zod"
import { ProviderHelper } from "./provider"

/*
{
  promptTokenCount: 11453,
  candidatesTokenCount: 71,
  totalTokenCount: 11625,
  cachedContentTokenCount: 8100,
  promptTokensDetails: [
    {modality: "TEXT",tokenCount: 11453}
  ],
  cacheTokensDetails: [
    {modality: "TEXT",tokenCount: 8100}
  ],
  thoughtsTokenCount: 101
}
*/

// Nothing reads these details. The Gemini API encodes responses as proto3 JSON, which omits zero and default
// values, so both fields stay optional: a details entry must never make the usage chunk fail to parse.
const TokensDetails = z.object({ modality: z.string().optional(), tokenCount: z.number().optional() }).array()

const Usage = z.looseObject({
  promptTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
  totalTokenCount: z.number().optional(),
  cachedContentTokenCount: z.number().optional(),
  promptTokensDetails: TokensDetails.optional(),
  cacheTokensDetails: TokensDetails.optional(),
  thoughtsTokenCount: z.number().optional(),
})
type Usage = z.infer<typeof Usage>

const StreamChunk = z.object({ usageMetadata: Usage.optional() })

export const googleHelper: ProviderHelper = ({ providerModel }) => ({
  format: "google",
  modifyUrl: (providerApi: string, isStream?: boolean) =>
    `${providerApi}/models/${providerModel}:${isStream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
  modifyHeaders: (headers: Headers, apiKey: string, _stickyId: string) => {
    headers.set("x-goog-api-key", apiKey)
  },
  modifyBody: (body: Record<string, any>) => {
    return body
  },
  createBinaryStreamDecoder: () => undefined,
  createUsageParser: () => {
    let usage: Usage

    return {
      parse: (chunk: string) => {
        if (!chunk.startsWith("data: ")) return

        let json: unknown
        try {
          json = JSON.parse(chunk.slice(6))
        } catch {
          return
        }

        const parsed = StreamChunk.safeParse(json)
        if (!parsed.success || !parsed.data.usageMetadata) return
        usage = parsed.data.usageMetadata
      },
      retrieve: () => usage,
    }
  },
  extractUsage: (response: any) => response.usageMetadata,
  normalizeUsage: (usage: Usage) => {
    const inputTokens = usage.promptTokenCount ?? 0
    const outputTokens = usage.candidatesTokenCount ?? 0
    const reasoningTokens = usage.thoughtsTokenCount ?? 0
    const cacheReadTokens = usage.cachedContentTokenCount ?? 0
    return {
      inputTokens: inputTokens - cacheReadTokens,
      outputTokens: outputTokens + reasoningTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWrite5mTokens: undefined,
      cacheWrite1hTokens: undefined,
    }
  },
})
