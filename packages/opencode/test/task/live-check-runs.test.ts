import { describe, expect, test } from "bun:test"
import { Scripted } from "./lib/scripted"

// The two live-check folders (D15, SD-11) run end to end on this tree with the scripted model of `./lib/scripted`:
// the real command, run supervisor, workers, proofs and merges in a git repository, with no paid model.

const TIMEOUT = 300_000
const RUN_MS = 240_000

describe("scripted runs of the live-check folders", () => {
  test(
    "VF18 example-scenarios: T1.1 trusted, S1 proved by its [S1] test and trusted, T1's review trusted, run done",
    async () => {
      await using run = await Scripted.start({
        folder: "example-scenarios.spec",
        leaves: {
          "T1.1": {
            "src/slug.ts": [
              "export const slugify = (title: string): string =>",
              '  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")',
              "",
            ].join("\n"),
            "test/slug.test.ts": [
              'import { expect, test } from "bun:test"',
              'import { slugify } from "../src/slug"',
              "",
              'test("[T1.1.c1] slugify gives the slug of a title", () => {',
              '  expect(slugify("Hello, World!")).toBe("hello-world")',
              '  expect(slugify(" v1.2.0 ")).toBe("v1-2-0")',
              '  expect(slugify("!!!")).toBe("")',
              "})",
              "",
              'test("[S1] a release title becomes its slug", () => {',
              '  expect(slugify("Release 2.0: Faster Notes!")).toBe("release-2-0-faster-notes")',
              "})",
              "",
            ].join("\n"),
          },
        },
      })
      const end = await run.until("the run ends", RUN_MS, (s) =>
        s && Scripted.ENDS.includes(s.run.state) ? s : undefined,
      )

      expect(end.run.state).toBe("done")
      expect(end.tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 1 })
      expect(end.tasks["T1"]?.state).toBe("trusted")
      expect(end.obligations["T1.1.c1"]?.state).toBe("trusted")
      expect(end.obligations["T1.e1"]?.state).toBe("trusted")
      expect(end.scenarios["S1"]?.state).toBe("trusted")
      // The S1 proof passed before its judge ran, and the reviewer judged T1's review obligation.
      // (A verifying scenario shows and logs as `pending`.)
      const proved = end.history.findIndex((entry) => entry.unit === "S1" && entry.to === "pending")
      const judged = end.history.findIndex((entry) => entry.unit === "S1" && entry.to === "trusted")
      expect(proved).toBeGreaterThan(-1)
      expect(proved).toBeLessThan(judged)
      expect(run.requests.some((r) => r.role === "reviewer" && r.unit === "T1" && r.judges.includes("T1.e1"))).toBe(
        true,
      )
      expect(run.requests.some((r) => r.scenario && r.unit === "S1" && r.judges.includes("S1"))).toBe(true)
    },
    TIMEOUT,
  )

  test(
    "VF17 example-cascade: T1.1 budget exhausted, T1.2 and T1 blocked by it, T1.3 trusted, and the run ends only after T1.3",
    async () => {
      await using run = await Scripted.start({
        folder: "example-cascade.spec",
        leaves: {
          "T1.1": {
            "src/sum.ts":
              "export const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)\n",
          },
          "T1.3": {
            "src/clamp.ts":
              "export const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))\n",
            "test/clamp.test.ts": [
              'import { expect, test } from "bun:test"',
              'import { clamp } from "../src/clamp"',
              "",
              'test("[T1.3.c1] clamp keeps a number inside its range", () => {',
              "  expect(clamp(5, 0, 3)).toBe(3)",
              "  expect(clamp(-1, 0, 3)).toBe(0)",
              "  expect(clamp(2, 0, 3)).toBe(2)",
              "})",
              "",
            ].join("\n"),
          },
        },
        // T1.3's builder answers only once T1.1 is exhausted, so the run is seen with T1.1 dead and T1.3 still active.
        hold: { unit: "T1.3", until: (s) => s?.tasks["T1.1"]?.state === "budget_exhausted" },
      })
      const middle = await run.until("T1.1 budget exhausted", RUN_MS, (s) =>
        s?.tasks["T1.1"]?.state === "budget_exhausted" ? s : undefined,
      )
      // T1.3 is still in work, so the run has not settled.
      expect(["building", "proving", "verifying"]).toContain(middle.tasks["T1.3"]?.state ?? "")
      expect(middle.run.state).toBe("running")
      const end = await run.until("the run ends", RUN_MS, (s) =>
        s && Scripted.ENDS.includes(s.run.state) ? s : undefined,
      )

      expect(end.run.state).toBe("budget_exhausted")
      expect(end.tasks["T1.1"]).toMatchObject({ state: "budget_exhausted", attempts: 1 })
      expect(end.tasks["T1.2"]).toMatchObject({ state: "blocked", reason: "blocked by T1.1: budget exhausted" })
      expect(end.tasks["T1"]).toMatchObject({ state: "blocked", reason: "blocked by T1.1: budget exhausted" })
      expect(end.tasks["T1.3"]?.state).toBe("trusted")
      expect(end.run.reason?.split("\n")).toEqual([
        "T1.1 budget exhausted",
        "T1 blocked by T1.1",
        "T1.2 blocked by T1.1",
      ])
      // T1.1 and T1.3 were built in parallel: T1.3's first builder request came before T1.1 was exhausted.
      const exhausted = end.history.find((entry) => entry.unit === "T1.1" && entry.to === "budget_exhausted")?.at ?? 0
      const t13 = run.requests.find((r) => r.role === "builder" && r.unit === "T1.3")?.at ?? Infinity
      expect(t13).toBeLessThan(exhausted)
      // The run's end comes after T1.3 was trusted.
      const trusted = end.history.find((entry) => entry.unit === "T1.3" && entry.to === "trusted")?.at ?? Infinity
      const ended = end.history.findLast((entry) => entry.unit === "run")?.at ?? 0
      expect(trusted).toBeLessThanOrEqual(ended)
      // T1.2 never reached a builder.
      expect(run.requests.some((r) => r.role === "builder" && r.unit === "T1.2")).toBe(false)
    },
    TIMEOUT,
  )
})
