// The adapter's process matching: a literal substring of the command line, never a regular expression, so the
// cleanup sweep cannot SIGKILL an unrelated process. Plain unit test on a recorded `ps -axo pid=,command=` table.
import { expect, test } from "bun:test"
import { commands } from "./arms"

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
