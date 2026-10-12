import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { History } from "@/task/core/model"
import { TaskRunner } from "@/task/core/runner"

// The pure parts of the in-core harness runner: no server, no model.

const entry = (at: number, unit: string, from: string, to: string): History => ({ at, unit, from, to })

describe("the task wall clock", () => {
  const history: ReadonlyArray<History> = [
    entry(100, "T1.1", "waiting", "building"),
    entry(200, "T1.1", "building", "proving"),
    entry(300, "T1.1", "proving", "building"),
    entry(400, "T1.1", "building", "proving"),
    entry(500, "T1.1", "proving", "verifying"),
    entry(600, "T1.1", "verifying", "trusted"),
    entry(700, "T1.1", "trusted", "proving"),
    entry(150, "T1.2", "waiting", "building"),
  ]

  test("starts at the latest building entry", () => {
    expect(TaskRunner.taskClockStart(history.slice(0, 5), "T1.1", 0)).toEqual(Option.some(300))
  })

  test("a trusted task reopened without building has no clock; built again, it starts afresh", () => {
    expect(TaskRunner.taskClockStart(history, "T1.1", 0)).toEqual(Option.none())
    const rebuilt = [...history, entry(800, "T1.1", "proving", "building")]
    expect(TaskRunner.taskClockStart(rebuilt, "T1.1", 0)).toEqual(Option.some(800))
  })

  test("never starts before the latest start or resume of the run", () => {
    expect(TaskRunner.taskClockStart(history, "T1.2", 1_000)).toEqual(Option.some(1_000))
  })

  test("a task never in building has no clock", () => {
    expect(TaskRunner.taskClockStart(history, "T1.3", 0)).toEqual(Option.none())
  })
})
