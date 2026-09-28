import { AsyncLocalStorage } from "async_hooks"
import { Option, Schema } from "effect"

export class NotFound extends Schema.TaggedError<NotFound>()("LocalContextNotFound", {
  context: Schema.String,
  message: Schema.String,
}) {}

export function create<T>(name: string) {
  const storage = new AsyncLocalStorage<T>()
  // A falsy stored value counts as missing, as the former `if (!result)` check did.
  const find = (): Option.Option<T> => Option.fromNullishOr(storage.getStore()).pipe(Option.filter(Boolean))
  return {
    /** The stored value, or None outside {@link provide}. */
    find,
    /** The stored value. Outside {@link provide} it throws NotFound, because the caller is synchronous. */
    use() {
      return Option.getOrThrowWith(
        find(),
        () => new NotFound({ context: name, message: `No context found for ${name}` }),
      )
    },
    provide<R>(value: T, fn: () => R) {
      return storage.run(value, fn)
    },
  }
}

export * as LocalContext from "./local-context"
