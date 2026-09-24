import { Effect, type Fiber, Option } from "effect"

// A sandbox promise value: a tool call running on its own fiber, or a promise settled up front
// (Promise.resolve / Promise.reject) that has no fiber.
export class SandboxPromise {
  interrupted = false
  private constructor(
    readonly fiber: Option.Option<Fiber.Fiber<unknown, unknown>>,
    // The settlement of a promise without a fiber; a fiber-backed promise settles through its fiber.
    readonly immediate: Effect.Effect<unknown, unknown>,
  ) {}

  static fromFiber(fiber: Fiber.Fiber<unknown, unknown>): SandboxPromise {
    return new SandboxPromise(Option.some(fiber), Effect.void)
  }

  static settled(settlement: Effect.Effect<unknown, unknown>): SandboxPromise {
    return new SandboxPromise(Option.none(), settlement)
  }
}

export class SandboxDate {
  constructor(readonly time: number) {}
}

export class SandboxRegExp {
  readonly regex: RegExp
  constructor(pattern: string, flags: string) {
    this.regex = new RegExp(pattern, flags)
  }
}

// The sandbox Map follows JS Map semantics: SameValueZero keys (object and array keys by identity)
// and insertion order. Effect HashMap and MutableHashMap compare plain-object and array keys
// structurally, so two distinct `{}` keys become one entry; HashMap also has no insertion order.
export class SandboxMap {
  // eslint-disable-next-line effect/no-map-use-hashmap -- (b) the sandbox Map holds program values under JS SameValueZero identity and insertion order, which Effect HashMap does not keep
  readonly map = new Map<unknown, unknown>()
}

export class SandboxSet {
  readonly set = new Set<unknown>()
}

export class SandboxURLSearchParams {
  constructor(readonly params: URLSearchParams) {}
}

export class SandboxURL {
  readonly searchParams: SandboxURLSearchParams
  constructor(readonly url: URL) {
    this.searchParams = new SandboxURLSearchParams(url.searchParams)
  }
}

export const isSandboxValue = (
  value: unknown,
): value is SandboxDate | SandboxRegExp | SandboxMap | SandboxSet | SandboxURL | SandboxURLSearchParams =>
  value instanceof SandboxDate ||
  value instanceof SandboxRegExp ||
  value instanceof SandboxMap ||
  value instanceof SandboxSet ||
  value instanceof SandboxURL ||
  value instanceof SandboxURLSearchParams
