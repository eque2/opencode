// The scripted model's request parsing and replies, on hand-built chat-completions bodies. Plain unit tests, no
// server: `Script.answer` is called directly.
import { describe, expect, test } from "bun:test"
import { Reply, type Hit } from "../lib/llm-server"
import { solutionTasks } from "./arms/workspace"
import { ERROR_TEXT, parse, REJECT_REASON, Script } from "./scripts"

type Msg = Record<string, unknown>

const user = (text: string): Msg => ({ role: "user", content: text })
const call = (name: string, id = "call_1"): Msg => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
})
const result = (text: string, id = "call_1"): Msg => ({ role: "tool", tool_call_id: id, content: text })
const hit = (messages: Msg[], tools: string[] = []): Hit => ({
  url: new URL("http://127.0.0.1/v1/chat/completions"),
  body: { messages, tools: tools.map((name) => ({ type: "function", function: { name } })) },
  at: Date.now(),
})
// `steps` tool calls with their results, as a turn that has gone on for that many steps.
const turn = (steps: number) => Array.from({ length: steps }, (_, i) => [call("write", `c${i}`), result("ok", `c${i}`)]).flat()

const builder = (attempt: number, steps: number, extra = "") => [
  user("task-harness role=builder task=T1.1\ntask-harness attempt=1\nBuild the task."),
  ...turn(3),
  user(`task-harness attempt=${attempt}${extra}`),
  ...turn(steps),
]

// The tool name and arguments of a scripted tool-call reply; undefined for a text reply.
function toolOf(out: unknown) {
  if (!(out instanceof Reply)) return undefined
  const item = out.item()
  if (item.type !== "sse") return undefined
  const parts = item.tail.flatMap((chunk) => {
    const delta = JSON.parse(JSON.stringify(chunk)).choices?.[0]?.delta
    return Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
  })
  const name = parts.map((p: { function?: { name?: string } }) => p.function?.name ?? "").join("")
  const args = parts.map((p: { function?: { arguments?: string } }) => p.function?.arguments ?? "").join("")
  return name ? { name, input: JSON.parse(args) } : undefined
}

describe("parse", () => {
  test("attempt 2 after N tool results gives attempt 2 and step N", () => {
    const request = parse(hit(builder(2, 4)))
    expect(request.role).toBe("builder")
    expect(request.unit).toBe("T1.1")
    expect(request.attempt).toBe(2)
    expect(request.step).toBe(4)
    expect(request.continues).toBe(true)
  })

  test("reopen lines give the id and the reason", () => {
    const request = parse(hit(builder(2, 0, `\nreopen T1.1.c3: ${REJECT_REASON}\n- reopen T1.1.c1: [T1.1.c1] timed out after 5 s`)))
    expect(request.reopen).toEqual([
      { id: "T1.1.c3", reason: REJECT_REASON },
      { id: "T1.1.c1", reason: "[T1.1.c1] timed out after 5 s" },
    ])
  })

  test("judge lines give the ids, with a bullet or trailing text tolerated", () => {
    const request = parse(
      hit([user("task-harness role=verifier task=T1.1\njudge T1.1.c1\n- judge T1.1.c2\njudge T1.1.c3: the refs footers\njudge T1.1.c4.")]),
    )
    expect(request.role).toBe("verifier")
    expect(request.attempt).toBe(0)
    expect(request.judges).toEqual(["T1.1.c1", "T1.1.c2", "T1.1.c3", "T1.1.c4"])
  })

  test("a scenario judge is a verifier of a scenario", () => {
    const request = parse(hit([user("task-harness role=verifier scenario=S1\njudge S1")]))
    expect(request.scenario).toBe(true)
    expect(request.unit).toBe("S1")
  })

  test("the tools list is read from the request", () => {
    expect(parse(hit([user("hi")], ["read", "task_ready"])).tools).toEqual(["read", "task_ready"])
  })
})

describe("ERROR_TEXT", () => {
  test.each([
    "[Tool execution was interrupted]",
    "The arguments provided to the tool are invalid: Model tried to call unavailable tool 'verdict'.",
    "Error: verdict is a verifier tool",
    "The command was aborted",
    "Permission denied",
    "verdict is not allowed for a builder",
  ])("an error result: %s", (text) => {
    expect(ERROR_TEXT.test(text)).toBe(true)
  })

  test.each(["0 failed", "no errors found", "passed", "Wrote file successfully."])("not an error: %s", (text) => {
    expect(ERROR_TEXT.test(text)).toBe(false)
  })
})

describe("Script.answer", () => {
  const writes = Object.keys(solutionTasks()["T1.1"]?.files ?? {})

  test("a request without a marker returns undefined", async () => {
    const script = new Script({ check: "H3", marker: "1" })
    expect(await script.answer(hit([user("Run the blend task tree at x")]))).toBeUndefined()
    expect(script.log.at(-1)?.action).toBe("unscripted")
  })

  test("the builder writes each file, then calls task_ready at the step after the last write, then answers text", async () => {
    const script = new Script({ check: "H3", marker: "1" })
    const at = (steps: number) => script.answer(hit([user("task-harness role=builder task=T1.1\ntask-harness attempt=1"), ...turn(steps)]))
    expect(writes.length).toBeGreaterThan(0)
    for (const [step, target] of writes.entries()) {
      const tool = toolOf(await at(step))
      expect(tool?.name).toBe("write")
      expect(tool?.input.filePath).toBe(target)
    }
    expect(toolOf(await at(writes.length))?.name).toBe("task_ready")
    expect(toolOf(await at(writes.length + 1))).toBeUndefined()
    expect(script.errors).toEqual([])
  })

  test("H11: attempt 1 writes the tampering file, attempt 2 removes it before the happy script", () => {
    const script = new Script({ check: "H11", marker: "1" })
    const first = script.plan("T1.1", 1)
    expect(first.some((a) => a.name === "write" && a.input.filePath === "test/verify-release-notes-S3.spec.ts")).toBe(true)
    const second = script.plan("T1.1", 2)
    expect(second[0]).toEqual({ name: "bash", input: { command: "rm -f test/verify-release-notes-S3.spec.ts" } })
    expect(second.slice(1)).toEqual(new Script({ check: "H3", marker: "1" }).plan("T1.1", 1))
  })

  test("H6 rejects T1.1.c3 in the first round that judges it with siblings and trusts it in every later round", async () => {
    const script = new Script({ check: "H6", marker: "1" })
    const round = async (ids: string[]) =>
      toolOf(await script.answer(hit([user(["task-harness role=verifier task=T1.1", ...ids.map((id) => `judge ${id}`)].join("\n"))])))
        ?.input.verdicts
    const all = ["T1.1.c1", "T1.1.c2", "T1.1.c3", "T1.1.c4", "T1.1.c5"]
    expect(await round(["T1.1.c3"])).toEqual([{ id: "T1.1.c3", verdict: "trusted" }])
    const first = await round(all)
    expect(first.find((v: { id: string }) => v.id === "T1.1.c3")).toEqual({ id: "T1.1.c3", verdict: "rejected", reason: REJECT_REASON })
    expect(first.filter((v: { verdict: string }) => v.verdict === "trusted")).toHaveLength(4)
    for (const ids of [["T1.1.c3"], all])
      for (const verdict of await round(ids)) expect(verdict.verdict).toBe("trusted")
  })
})
