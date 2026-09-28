import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import { Event } from "../src/event"

describe("public event schemas", () => {
  test("definition is pure", () => {
    const definitions = Event.inventory()
    Event.define({ type: "test.pure", schema: { value: Schema.String } })
    expect(definitions).toEqual([])
  })

  test("latest selection is independent of declaration order", () => {
    const historical = Event.define({
      type: "test.versioned",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })
    const current = Event.define({
      type: "test.versioned",
      durable: { aggregate: "id", version: 2 },
      schema: { id: Schema.String, value: Schema.String },
    })

    expect(Result.getOrThrow(Event.latest([historical, current])).get(current.type)).toBe(current)
    expect(Result.getOrThrow(Event.latest([current, historical])).get(current.type)).toBe(current)
  })

  test("latest selection rejects a second definition for one type and version", () => {
    const first = Event.define({ type: "test.duplicate", schema: { id: Schema.String } })
    const second = Event.define({ type: "test.duplicate", schema: { id: Schema.String } })
    const result = Event.latest([first, second])

    expect(Option.getOrUndefined(Result.getFailure(result))).toMatchObject({
      _tag: "Event.DuplicateDefinition",
      key: "test.duplicate",
    })
    expect(() => Result.getOrThrow(result)).toThrow("Duplicate latest event definition for test.duplicate")
    expect(Result.getOrThrow(Event.latest([first, first])).get(first.type)).toBe(first)
  })

  test("durable definitions are indexed by type and version", () => {
    const definition = Event.define({
      type: "test.durable",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })

    expect(Result.getOrThrow(Event.durable([definition])).get("test.durable.1")).toBe(definition)
  })

  test("durable definitions reject a second definition for one type and version", () => {
    const first = Event.define({
      type: "test.durable-duplicate",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })
    const second = Event.define({
      type: "test.durable-duplicate",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })
    const result = Event.durable([first, second])

    expect(Option.getOrUndefined(Result.getFailure(result))).toBeInstanceOf(Event.DuplicateDefinitionError)
    expect(() => Result.getOrThrow(result)).toThrow("Duplicate durable event definition for test.durable-duplicate.1")
  })
})
