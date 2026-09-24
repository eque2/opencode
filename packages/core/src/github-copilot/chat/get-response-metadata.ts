import { DateTime, Option } from "effect"

export function getResponseMetadata({
  id,
  model,
  created,
}: {
  id?: string | undefined | null
  created?: number | undefined | null
  model?: string | undefined | null
}) {
  return {
    id: id ?? undefined,
    modelId: model ?? undefined,
    // `created` is in Unix seconds; a value outside the Date range gives no timestamp.
    timestamp:
      created != null
        ? Option.getOrUndefined(Option.map(DateTime.make(created * 1000), DateTime.toDateUtc))
        : undefined,
  }
}
