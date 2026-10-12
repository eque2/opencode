// The scoring of the conformance runner (`script/task-conformance.ts`), kept importable so a unit test covers it:
// reading a run's checks from Bun's JUnit report, the score statistics, and the comparison with the baseline (D6).

export const CHECKS = [...Array.from({ length: 16 }, (_, i) => `H${i + 1}`), "L1"] as const
export type CheckStatus = "passed" | "failed" | "skipped" | "missing" | "not-runnable"

// A check's test is titled "<id> <behaviour>", e.g. "H3 happy path". `xml` is undefined when the report is missing.
export function readChecks(xml: string | undefined): Record<string, CheckStatus> {
  const out = CHECKS.reduce<Record<string, CheckStatus>>((acc, c) => ({ ...acc, [c]: "missing" }), {})
  if (xml === undefined) return out
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /name="([^"]*)"/.exec(m[1])?.[1] ?? ""
    const id = CHECKS.find((c) => c === /^(H\d+|L1)\b/.exec(name)?.[1])
    if (!id) continue
    const body = m[3] ?? ""
    out[id] = /<failure|<error/.test(body) ? "failed" : /<skipped/.test(body) ? "skipped" : "passed"
  }
  return out
}

export type Summary = ReturnType<typeof stats>

export function stats(xs: number[]) {
  const n = xs.length
  const sorted = [...xs].sort((a, b) => a - b)
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  return {
    median: round(median),
    mean: round(mean),
    sd: round(sd),
    // Undefined when the mean is zero; the noise floor then uses 2 x sd in points (D6).
    cv: mean === 0 ? null : round(sd / mean),
    se: round(n > 0 ? sd / Math.sqrt(n) : 0),
    min: sorted[0] ?? 0,
    max: sorted[n - 1] ?? 0,
  }
}

export type Baseline = { median: number; sd: number; cv: number | null; mean: number; fixture: unknown }

// D6: the noise floor is twice the baseline's coefficient of variation (of its mean), or twice its standard
// deviation in points when its mean is zero; an option counts when its median clears both 50 points and the floor.
export function compare(summary: Summary, base: Baseline, fixture: unknown) {
  const noiseFloor = base.mean === 0 ? 2 * base.sd : 2 * (base.cv ?? 0) * base.mean
  const change = round(summary.median - base.median)
  return {
    baselineMedian: base.median,
    change,
    noiseFloorPoints: round(noiseFloor),
    smallestEffect: 50,
    clearsSmallestEffect: change >= 50 && change > noiseFloor,
    sameFixture: JSON.stringify(base.fixture) === JSON.stringify(fixture),
  }
}

export function round(x: number) {
  return Math.round(x * 1000) / 1000
}
