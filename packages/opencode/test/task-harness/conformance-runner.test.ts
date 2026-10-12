// The conformance runner's scoring: the checks read from Bun's JUnit report, the statistics and the comparison
// with the baseline (D6). Plain unit tests, no server.
import { describe, expect, test } from "bun:test"
import { compare, readChecks, stats } from "./stats"

// Recorded from `bun test --reporter=junit` (Bun 1.3.14) on tests titled like the conformance checks.
const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="3" failures="1" skipped="2" time="0.010456">
  <testsuite name="record.test.ts" file="record.test.ts" tests="5" assertions="3" failures="1" skipped="2" time="0" hostname="mac-studio-m1">
    <testcase name="H1 refuse before the model" classname="" time="0.000039" file="record.test.ts" line="3" assertions="1" />
    <testcase name="H2 parse T2" classname="" time="0.000127" file="record.test.ts" line="6" assertions="1">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="H3 happy path" classname="" time="0" file="record.test.ts" line="9" assertions="0">
      <skipped />
    </testcase>
    <testcase name="H10 builder cannot judge" classname="" time="0.000009" file="record.test.ts" line="10" assertions="1" />
    <testcase name="L1 live" classname="" time="0" file="record.test.ts" line="13" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`

const base = { median: 0, sd: 0, cv: null, mean: 0, fixture: { spec: "a" } }
const summary = (median: number) => ({ ...stats([median]), median })

describe("readChecks", () => {
  test("maps passed, failed and skipped cases and leaves the rest missing", () => {
    const checks = readChecks(JUNIT)
    expect(checks.H1).toBe("passed")
    expect(checks.H2).toBe("failed")
    expect(checks.H3).toBe("skipped")
    expect(checks.H10).toBe("passed")
    expect(checks.L1).toBe("skipped")
    expect(checks.H4).toBe("missing")
    expect(Object.keys(checks)).toHaveLength(17)
  })

  test("a missing report leaves every check missing", () => {
    expect(new Set(Object.values(readChecks(undefined)))).toEqual(new Set(["missing"]))
  })
})

describe("stats", () => {
  test("5 scores: the odd median and the sample standard deviation (n - 1)", () => {
    expect(stats([100, 10, 40, 20, 30])).toEqual({
      median: 30,
      mean: 40,
      sd: 35.355,
      cv: 0.884,
      se: 15.811,
      min: 10,
      max: 100,
    })
  })

  test("4 scores: the even median is the mean of the middle two", () => {
    expect(stats([40, 0, 30, 10]).median).toBe(20)
  })

  test("all zeros: the coefficient of variation is null", () => {
    expect(stats([0, 0, 0, 0, 0])).toEqual({ median: 0, mean: 0, sd: 0, cv: null, se: 0, min: 0, max: 0 })
  })
})

describe("compare", () => {
  test("a zero-mean baseline: the noise floor is 2 x sd", () => {
    expect(compare(summary(60), { ...base, sd: 5.882 }, base.fixture).noiseFloorPoints).toBe(11.764)
  })

  test("otherwise the noise floor is 2 x cv x mean", () => {
    expect(compare(summary(60), { ...base, mean: 40, cv: 0.1, median: 40 }, base.fixture).noiseFloorPoints).toBe(8)
  })

  test("clearsSmallestEffect only when the change is at least 50 and above the floor", () => {
    const zero = { ...base, sd: 4 } // floor 8
    expect(compare(summary(50), zero, base.fixture).clearsSmallestEffect).toBe(true)
    expect(compare(summary(49), zero, base.fixture).clearsSmallestEffect).toBe(false)
    expect(compare(summary(60), { ...base, sd: 35 }, base.fixture).clearsSmallestEffect).toBe(false) // floor 70
    expect(compare(summary(50), { ...base, sd: 25 }, base.fixture).clearsSmallestEffect).toBe(false) // floor 50
  })

  test("sameFixture compares the fixture fingerprints", () => {
    expect(compare(summary(0), base, { spec: "a" }).sameFixture).toBe(true)
    expect(compare(summary(0), base, { spec: "b" }).sameFixture).toBe(false)
  })
})
