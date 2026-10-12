import { describe, expect, test } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import path from "node:path"
import { Blend } from "@/task/blend"
import { TaskSessions } from "@/task/core/sessions"

// The protocol messages of the harness's child sessions (harness contract, section 4). The scripted model reads
// them line by line, so each protocol line must stand on its own line.

const MARKER = /task-harness role=(builder|verifier|reviewer) (task|scenario)=/
const JUDGE = /^[ \t]*(?:[-*][ \t]+)?judge[ \t]+([A-Za-z0-9._-]+)/gm

const judged = (text: string) => [...text.matchAll(JUDGE)].map((match) => (match[1] ?? "").replace(/\.+$/, ""))

describe("the judge messages", () => {
  test("a round carries the marker and one judge line per id, each text on one line", () => {
    const text = TaskSessions.judgeMessage({
      role: "verifier",
      kind: "task",
      unit: "T1.1",
      judge: [
        { id: "T1.1.c1", text: "first\nsecond" },
        { id: "T1.1.c3", text: "third" },
      ],
      about: ["You verify task T1.1."],
    })
    expect(text.split("\n")[0]).toBe("task-harness role=verifier task=T1.1")
    expect(judged(text)).toEqual(["T1.1.c1", "T1.1.c3"])
    expect(text).toContain("judge T1.1.c1: first | second")
  })

  test("the follow-up for skipped ids judges exactly those, without a marker", () => {
    const text = TaskSessions.judgeMissingMessage([{ id: "T1.1.c3", text: "third" }])
    expect(MARKER.test(text)).toBe(false)
    expect(judged(text)).toEqual(["T1.1.c3"])
  })
})

describe("the builder message", () => {
  // The release-notes fixture: each builder writes the [S<n>] tests of the scenarios it completes.
  const fixture = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")
  const scenariosOf = (text: string) => [...text.matchAll(/^- (S\d+): /gm)].map((match) => match[1])

  test("names the scenarios the task completes, and only those", async () => {
    const { spec } = await Effect.runPromise(Blend.load(fixture).pipe(Effect.provide(NodeServices.layer)))
    if (!spec) throw new Error("the fixture does not load")
    const message = (id: string, trusted: string[]) => {
      const task = spec.tasks.find((each) => each.id === id)
      if (!task) throw new Error(`no task ${id}`)
      return TaskSessions.builderMessage({ first: true, attempt: 1, reopen: [], task, spec, trusted: (unit) => trusted.includes(unit) })
    }
    expect(scenariosOf(message("T1.1", []))).toEqual(["S2", "S7"])
    // T1.4 completes every scenario that needs it once T1.1-T1.3 are trusted; S13 also needs T8.
    expect(scenariosOf(message("T1.4", ["T1.1", "T1.2", "T1.3"])).toSorted()).toEqual(
      ["S1", "S10", "S11", "S6", "S8", "S9"].toSorted(),
    )
    expect(scenariosOf(message("T1.4", ["T1.1", "T1.2", "T1.3", "T8"]))).toContain("S13")
  })
})
