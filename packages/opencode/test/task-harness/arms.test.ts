// The adapter's process matching: a literal substring of the command line, never a regular expression, so the
// cleanup sweep cannot SIGKILL an unrelated process. Plain unit test on a recorded `ps -axo pid=,command=` table.
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { commands } from "./arms"
import * as Status from "./arms/status"

const TABLE = [
  "  101 /bin/sleep 999.00512340123451",
  "  102 /usr/bin/tool axb --run",
  "  103 bun run /runs/a.b/serve",
  "  104 sh -c sleep 999.00512340123452",
  "",
].join("\n")

test("matches the text literally: `.` is a dot, not any character", () => {
  expect(commands(TABLE, "a.b")).toEqual([103])
})

test("a marker matches every command that contains it, and nothing else", () => {
  expect(commands(TABLE, "sleep 999.0051234012345")).toEqual([101, 104])
  expect(commands(TABLE, "sleep 999.00512340123451")).toEqual([101])
  expect(commands(TABLE, "sleep 999.9")).toEqual([])
})

test("a status file is absent, malformed, or the contract's shape", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "task-harness-status-"))
  try {
    const write = (text: string) => {
      fs.mkdirSync(path.dirname(Status.file(repo)), { recursive: true })
      fs.writeFileSync(Status.file(repo), text)
    }
    const problem = () => {
      const reading = Status.inspect(repo)
      return "problem" in reading ? reading.problem : "ok"
    }
    expect(problem()).toStartWith("no status file at")
    write("{")
    expect(problem()).toEndWith("is malformed: not JSON")
    const valid = { run: { state: "running", spec: "s", path: "p" }, tasks: {}, obligations: {}, scenarios: {}, history: [] }
    write(JSON.stringify({ ...valid, run: { spec: "s", path: "p" } }))
    expect(problem()).toEndWith("is malformed: run.state is not a string")
    write(JSON.stringify({ ...valid, tasks: [] }))
    expect(problem()).toEndWith("is malformed: tasks is not an object")
    write(JSON.stringify(valid))
    expect(problem()).toBe("ok")
    expect(Status.read(repo)?.run.state).toBe("running")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
