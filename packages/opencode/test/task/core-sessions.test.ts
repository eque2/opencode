import { describe, expect, test } from "bun:test"
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
