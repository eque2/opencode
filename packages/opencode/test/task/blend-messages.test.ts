import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { BlendDocument } from "@/task/blend/document"
import { BlendSchema } from "@/task/blend/schema"

// The R3 messages of the schema shapes the golden negative cases do not pin. Each expected line is what the
// reference checker's validator (Python `jsonschema`, Draft 2020-12) writes for the same front matter against
// `task-formats/blend/schema/*.schema.json`, as `<path>: <message>`. String.raw keeps the backslashes of Python's
// repr as they print.

// The R3 problems of one front matter block, parsed and decoded the way Blend.load does it.
const problems = (schema: Schema.ConstraintDecoder<unknown>, yaml: string): ReadonlyArray<string> => {
  const doc = Effect.runSync(BlendDocument.frontMatter(`---\n${yaml}\n---\n# Title\n`))
  const decoded = Result.flatMap(doc.yaml, (value) => BlendDocument.decode(schema, value))
  return Result.isFailure(decoded) ? decoded.failure : []
}

// A valid SPEC.md front matter with `format` left for the case to write.
const specWith = (format: string) =>
  [
    `format: ${format}`,
    "policy:",
    "  redFirst: true",
    "  proofBinding: title-tag",
    "  structural: touches-plus-tests",
    "  review: parent-diff",
    "  trust: independent-verifier",
    "  acceptance: after-all-needs-trusted",
    "  evidence: [exit-code]",
    "  budgets: {taskAttempts: 3, retries: 2}",
    "  judges: {test: [runner], gate: [runner], unchanged: [engine], review: [reviewer]}",
    "gates: {}",
    "refs: {}",
  ].join("\n")

// A leaf `ensures` entry `c1` with `extra` added to its fields.
const ensuresWith = (extra: string) => `ensures:\n  c1:\n    text: a\n    category: empty\n${extra}`

const PATTERN = String.raw`'^T[1-9][0-9]*(\\.[1-9][0-9]*)*$'`

const cases: ReadonlyArray<{
  readonly name: string
  readonly schema: Schema.ConstraintDecoder<unknown>
  readonly yaml: string
  readonly expected: ReadonlyArray<string>
}> = [
  {
    name: "a missing key at the top is reported on (root)",
    schema: BlendSchema.ScenarioFrontMatter,
    yaml: "category: x",
    expected: ["(root): 'needs' is a required property"],
  },
  {
    name: "a missing nested key is reported on its object",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "ensures:\n  c1:\n    category: empty",
    expected: ["ensures/c1: 'text' is a required property"],
  },
  {
    name: "excess keys at the top are one message, sorted",
    schema: BlendSchema.TaskFrontMatter,
    yaml: "status: x\nzeta: 1\nalpha: 2",
    expected: ["(root): Additional properties are not allowed ('alpha', 'status', 'zeta' were unexpected)"],
  },
  {
    name: "excess keys of a nested object are one message, sorted",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: ensuresWith("    extra: 1\n    another: 2"),
    expected: ["ensures/c1: Additional properties are not allowed ('another', 'extra' were unexpected)"],
  },
  {
    name: "a record key that fails its key pattern ($ref propertyNames)",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "ensures:\n  x1:\n    text: a\n    category: empty",
    expected: ["ensures: 'x1' does not match '^[ce][1-9][0-9]*$'"],
  },
  {
    name: "a record key that fails its key pattern (inline propertyNames)",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "ensures:\n  c1:\n    text: a\n    category: empty\npreserves:\n  q1:\n    text: a\n    proof: review",
    expected: ["preserves: 'q1' does not match '^p[1-9][0-9]*$'"],
  },
  {
    name: "a string that matches neither pattern of a scenario-or-ref id",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: ensuresWith("    covers: [bogus]"),
    expected: ["ensures/c1/covers/0: 'bogus' is not valid under any of the given schemas"],
  },
  {
    name: "a number where a scenario-or-ref id goes fails the type, not the patterns",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: ensuresWith("    covers: [12]"),
    expected: ["ensures/c1/covers/0: 12 is not of type 'string'"],
  },
  {
    name: "a boolean where a scenario-or-ref id goes fails the type",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: ensuresWith("    covers: [true]"),
    expected: ["ensures/c1/covers/0: True is not of type 'string'"],
  },
  {
    name: "a null where a scenario-or-ref id goes fails the type",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: ensuresWith("    covers: [null]"),
    expected: ["ensures/c1/covers/0: None is not of type 'string'"],
  },
  {
    name: "a proof string outside the oneOf",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: ensuresWith("    proof: bogus"),
    expected: ["ensures/c1/proof: 'bogus' is not valid under any of the given schemas"],
  },
  {
    name: "a proof object outside the oneOf",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: ensuresWith("    proof: {test: x1}"),
    expected: ["ensures/c1/proof: {'test': 'x1'} is not valid under any of the given schemas"],
  },
  {
    name: "an empty string (minLength 1)",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: 'ensures:\n  c1:\n    text: a\n    category: empty\nhint: ""',
    expected: ["hint: '' should be non-empty"],
  },
  {
    name: "an empty list (minItems 1)",
    schema: BlendSchema.TaskFrontMatter,
    yaml: "touches: []",
    expected: ["touches: [] should be non-empty"],
  },
  {
    name: "VF3 a VERIFY.md with no ensures is reported on (root)",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "gates: [BUILD-1]",
    expected: ["(root): 'ensures' is a required property"],
  },
  {
    name: "an empty mapping (minProperties 1)",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "ensures: {}",
    expected: ["ensures: {} should be non-empty"],
  },
  {
    name: "a repeated list item (uniqueItems)",
    schema: BlendSchema.TaskFrontMatter,
    yaml: "after: [T1, T1]",
    expected: ["after: ['T1', 'T1'] has non-unique elements"],
  },
  {
    name: "a number under its minimum of 1",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "ensures:\n  c1:\n    text: a\n    category: empty\npolicy:\n  budgets:\n    taskAttempts: 0",
    expected: ["policy/budgets/taskAttempts: 0 is less than the minimum of 1"],
  },
  {
    name: "a number under its minimum of 0",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "ensures:\n  c1:\n    text: a\n    category: empty\npolicy:\n  budgets:\n    retries: -1",
    expected: ["policy/budgets/retries: -1 is less than the minimum of 0"],
  },
  {
    name: "a fraction where an integer goes",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "ensures:\n  c1:\n    text: a\n    category: empty\npolicy:\n  budgets:\n    taskAttempts: 1.5",
    expected: ["policy/budgets/taskAttempts: 1.5 is not of type 'integer'"],
  },
  {
    name: "a string where an integer goes",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "ensures:\n  c1:\n    text: a\n    category: empty\npolicy:\n  budgets:\n    taskAttempts: x",
    expected: ["policy/budgets/taskAttempts: 'x' is not of type 'integer'"],
  },
  {
    name: "a boolean where an integer goes",
    schema: BlendSchema.VerifyFrontMatter,
    yaml: "ensures:\n  c1:\n    text: a\n    category: empty\npolicy:\n  budgets:\n    taskAttempts: true",
    expected: ["policy/budgets/taskAttempts: True is not of type 'integer'"],
  },
  {
    name: "a value other than the const",
    schema: BlendSchema.SpecFrontMatter,
    yaml: specWith("task-spec/2"),
    expected: ["format: 'task-spec/1' was expected"],
  },
  {
    name: "repr of a string with a single quote uses double quotes",
    schema: BlendSchema.TaskFrontMatter,
    yaml: `after: ["it's"]`,
    expected: [`after/0: "it's" does not match ${PATTERN}`],
  },
  {
    name: "repr of a string with both quotes escapes the single quote",
    schema: BlendSchema.TaskFrontMatter,
    yaml: `after: ['say "it''s"']`,
    expected: [String.raw`after/0: 'say "it\'s"' does not match ` + PATTERN],
  },
  {
    name: "repr of a string with a backslash doubles it",
    schema: BlendSchema.TaskFrontMatter,
    yaml: String.raw`after: ['a\b']`,
    expected: [String.raw`after/0: 'a\\b' does not match ` + PATTERN],
  },
  {
    name: "repr of a string with a newline escapes it",
    schema: BlendSchema.TaskFrontMatter,
    yaml: String.raw`after: ["a\nb"]`,
    expected: [String.raw`after/0: 'a\nb' does not match ` + PATTERN],
  },
  {
    name: "repr of a string with a tab escapes it",
    schema: BlendSchema.TaskFrontMatter,
    yaml: String.raw`after: ["tab\there"]`,
    expected: [String.raw`after/0: 'tab\there' does not match ` + PATTERN],
  },
]

describe("BlendDocument.decode messages", () => {
  for (const item of cases) {
    test(item.name, () => {
      expect(problems(item.schema, item.yaml)).toEqual(item.expected)
    })
  }
})
