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
    timestamp: Option.fromNullishOr(created).pipe(
      Option.flatMap((seconds) => DateTime.make(seconds * 1000)),
      Option.map(DateTime.toDateUtc),
      Option.getOrUndefined,
    ),
  }
}
