import { Option } from "effect"

// The streamed text for a part wins over the stored part text while the stream still has an entry for it.
export function readPartText(accum: Option.Option<Record<string, string>>, part: { id: string; text?: string }): string {
  return Option.flatMap(accum, (texts) => Option.fromNullishOr(texts[part.id]))
    .pipe(Option.getOrElse(() => part.text ?? ""))
    .trim()
}
