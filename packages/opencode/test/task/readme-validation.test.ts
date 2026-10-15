import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "path"

// The Validation section of the blend README (AC 1; D10-D15): what runs before any work starts, where each rule is
// enforced, how a refusal reads, how the run machine holds the order, and which graph faults are refused.

const readme = readFileSync(path.resolve(import.meta.dir, "../../../../task-formats/blend/README.md"), "utf8")

// The text of a `## ` section, up to the next `## ` heading.
const section = (heading: string) => {
  const start = readme.indexOf(`\n## ${heading}\n`)
  if (start < 0) return ""
  const next = readme.indexOf("\n## ", start + 1)
  return readme.slice(start, next < 0 ? readme.length : next)
}

const validation = section("Validation")
const RULES = Array.from({ length: 13 }, (_, index) => `R${index + 1}`)
const FAULTS = [
  "example-format-faults.spec",
  "example-cycle.spec",
  "example-self-after.spec",
  "example-unknown-after.spec",
  "example-no-ensures.spec",
  "example-outside-run.spec",
]
const LIVE = ["example-scenarios.spec", "example-cascade.spec"]

// The table row of a rule in the Validation section: `| R<n> | ... |`.
const rowOf = (rule: string) => validation.split("\n").find((line) => line.startsWith(`| ${rule} |`)) ?? ""

describe("the blend README's Validation section", () => {
  test("replaces Validating and says what runs before any work starts", () => {
    expect(readme).not.toContain("\n## Validating\n")
    expect(validation).not.toBe("")
    for (const text of [
      "Blend.load",
      "TaskCommand.run",
      "before the git check",
      "the plan",
      "the job",
      "No work started",
    ]) {
      expect(validation).toContain(text)
    }
  })

  test("lists R1-R13, each with the file that enforces it, and says R12 is a runtime check", () => {
    for (const rule of RULES) {
      const row = rowOf(rule)
      expect({ rule, row }).toEqual({ rule, row: expect.stringMatching(/`[a-z/]+\.ts`/) })
    }
    for (const rule of ["R1", "R2", "R3", "R4", "R11"]) expect(rowOf(rule)).toContain("`blend/index.ts`")
    expect(rowOf("R3")).toContain("`blend/schema.ts`")
    for (const rule of ["R5", "R6", "R7", "R8", "R9", "R10", "R13"]) expect(rowOf(rule)).toContain("`blend/rules.ts`")
    expect(rowOf("R12")).toContain("`core/command.ts`")
    expect(rowOf("R12")).toContain("runtime")
  })

  test("states the two rule stages and the refusal of a spec with no task (VF22, VF23)", () => {
    expect(validation).toContain("R1–R4")
    expect(validation).toContain("R5–R13")
    expect(validation).toContain("only once every file passes")
    expect(validation).toContain("the spec holds no task")
  })

  test("says how a refusal reads: header, one line per failure, hint, run.reason", () => {
    for (const text of [
      "Refused <path>: N failures. No work started.",
      "Fix each line, then type /task <path> again.",
      "Refused <path>. No work started.",
      "one line for each failure",
      "`R<n> <path>: <message>`",
      "`run.reason`",
    ]) {
      expect(validation).toContain(text)
    }
  })

  test("says how the run machine holds the order and which graph faults are refused", () => {
    for (const text of [
      "ready",
      "blocked by",
      "cycle",
      "T1.1 → T1.1",
      "unknown",
      "ancestor",
      "descendant",
      "outside this run",
    ]) {
      expect(validation).toContain(text)
    }
  })

  test("names the six fault folders and the two live-check folders, each row with its expected response", () => {
    // Each folder's table row, and what the real /task command answers for it.
    const RESPONSE: Record<string, ReadonlyArray<string>> = {
      "example-format-faults.spec": ["Refused, 3 failures", "R1", "`notes.txt`", "R3", "R4"],
      "example-cycle.spec": ["Refused, 1 failure", "R7", "T1.1 → T1.2 → T1.1"],
      "example-self-after.spec": ["Refused, 1 failure", "R7", "T1.1 → T1.1"],
      "example-unknown-after.spec": ["Refused, 1 failure", "R6", "unknown task T7"],
      "example-no-ensures.spec": ["Refused, 1 failure", "R3", "'ensures' is a required property"],
      "example-outside-run.spec": ["no failure", "whole spec", "T1.2 subtree", "R12"],
      "example-scenarios.spec": ["T1.1", "S1 trusted", "run `done`"],
      "example-cascade.spec": [
        "T1.1 `budget_exhausted`",
        "T1.2 and T1 `blocked`",
        "T1.3 trusted",
        "run `budget_exhausted`",
      ],
    }
    expect(Object.keys(RESPONSE).toSorted()).toEqual([...FAULTS, ...LIVE].toSorted())
    for (const [name, words] of Object.entries(RESPONSE)) {
      const row = validation.split("\n").find((line) => line.startsWith(`| \`${name}\` |`)) ?? ""
      for (const word of words) expect({ name, row }).toEqual({ name, row: expect.stringContaining(word) })
    }
  })

  test("documents ensures as required, and the Layout tree lists the example folders", () => {
    const verify = readme.slice(readme.indexOf("### `VERIFY.md`"), readme.indexOf("### `acceptance/S<n>.md`"))
    expect(verify.split("\n").find((line) => line.startsWith("| `ensures` |"))).toContain("| yes |")
    const layout = section("Layout")
    for (const name of [...FAULTS, ...LIVE]) expect(layout).toContain(name)
  })
})
