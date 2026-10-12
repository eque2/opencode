import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderJsonSchema } from "../src"

// Each expected value is the JSON Schema that Effect 4.0.0-rc.117 emitted for the same schema,
// which is the shape providers received before the Effect 4.0.x upgrade.
const property = (schema: Schema.Top) => ProviderJsonSchema.fromSchema(Schema.Struct({ value: schema })).properties

describe("ProviderJsonSchema", () => {
  test("exports a bare integer without the safe-integer range", () => {
    expect(property(Schema.Int)).toEqual({ value: { type: "integer" } })
  })

  test("keeps a caller's bound in place instead of in allOf", () => {
    expect(property(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))).toEqual({
      value: { type: "integer", minimum: 0 },
    })
    expect(property(Schema.Int.check(Schema.isLessThanOrEqualTo(100)))).toEqual({
      value: { type: "integer", maximum: 100 },
    })
    expect(
      property(
        Schema.Int.check(Schema.isGreaterThan(0))
          .check(Schema.isLessThanOrEqualTo(65535))
          .annotate({ description: "port" }),
      ),
    ).toEqual({ value: { type: "integer", exclusiveMinimum: 0, maximum: 65535, description: "port" } })
  })

  test("removes the range when a bound comes before Schema.isInt", () => {
    expect(property(Schema.Number.check(Schema.isLessThanOrEqualTo(10)).check(Schema.isInt()))).toEqual({
      value: { maximum: 10, type: "integer" },
    })
  })

  test("keeps a second bound on the same keyword in allOf", () => {
    expect(
      property(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isGreaterThanOrEqualTo(5))),
    ).toEqual({ value: { type: "integer", minimum: 0, allOf: [{ minimum: 5 }] } })
  })

  test("restores integers inside named definitions", () => {
    const Named = Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }).annotate({
      identifier: "Named",
    })
    expect(ProviderJsonSchema.fromSchema(Schema.Struct({ a: Named, b: Schema.Array(Named) }))).toMatchObject({
      $defs: { Named: { properties: { count: { type: "integer", minimum: 0 } } } },
    })
  })

  test("leaves JSON data keywords unchanged", () => {
    const range = { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }
    expect(ProviderJsonSchema.withoutSafeIntegerRange({ type: "object", default: range, examples: [range] })).toEqual({
      type: "object",
      default: range,
      examples: [range],
    })
  })
})
