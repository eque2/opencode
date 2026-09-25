import { Context, Effect, MutableHashMap, Option, Predicate } from "effect"

const methodNotFound = (key: string) => Effect.die(new Error(`Service method not found: ${key}`))

type EffectMethod = (...args: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, unknown>

type ServiceUse<Identifier, Shape> = {
  readonly [Key in keyof Shape as Shape[Key] extends EffectMethod ? Key : never]: Shape[Key] extends (
    ...args: infer Args
  ) => infer Return
    ? Args extends ReadonlyArray<unknown>
      ? Return extends Effect.Effect<infer A, infer E, infer R>
        ? (...args: Args) => Effect.Effect<A, E, R | Identifier>
        : never
      : never
    : never
}

export const serviceUse = <Identifier, Shape>(tag: Context.Service<Identifier, Shape>) => {
  const cache = MutableHashMap.empty<string, (...args: unknown[]) => Effect.Effect<unknown, unknown, unknown>>()
  // This is the only dynamic boundary: TypeScript knows the accessor shape,
  // but Proxy property names are runtime values.
  const access = new Proxy(
    {},
    {
      get: (_, key) => {
        if (typeof key !== "string") return undefined
        const cached = MutableHashMap.get(cache, key)
        if (Option.isSome(cached)) return cached.value
        const accessor = (...args: unknown[]) =>
          tag.use((service) => {
            if (!Predicate.hasProperty(service, key)) return methodNotFound(key)
            const method = service[key]
            if (!Predicate.isFunction(method)) return methodNotFound(key)
            // The method is called without a `this` binding.
            const result: unknown = method(...args)
            if (!Effect.isEffect(result)) return Effect.die(new Error(`Service method did not return an Effect: ${key}`))
            return result
          })
        MutableHashMap.set(cache, key, accessor)
        return accessor
      },
    },
  )
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the platform Proxy constructor returns the target type {}; the get trap supplies the ServiceUse accessors lazily by key
  return access as ServiceUse<Identifier, Shape>
}
