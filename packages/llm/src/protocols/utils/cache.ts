// Shared helpers for provider cache-marker lowering. Anthropic and Bedrock
// both enforce a 4-breakpoint cap per request and accept the same `5m`/`1h`
// TTL buckets, so the counter and TTL mapping live here.

export interface Breakpoints {
  remaining: number
  dropped: number
}

export const newBreakpoints = (cap: number): Breakpoints => ({ remaining: cap, dropped: 0 })

// Returns `"1h"` for any `ttlSeconds >= 3600`, otherwise `"5m"` (the provider
// default). Anthropic & Bedrock both treat anything shorter than an hour as
// 5m, and both omit the `ttl` field on the wire for the 5m bucket.
export const ttlBucket = (ttlSeconds: number | undefined): "5m" | "1h" =>
  ttlSeconds !== undefined && ttlSeconds >= 3600 ? "1h" : "5m"
