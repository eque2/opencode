import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Option } from "effect"
import { which } from "@opencode-ai/core/util/which"
import { tmpdir } from "../fixture/tmpdir"

async function cmd(dir: string, name: string, exec = true) {
  const ext = process.platform === "win32" ? ".cmd" : ""
  const file = path.join(dir, name + ext)
  const body = process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n"
  await fs.writeFile(file, body)
  if (process.platform !== "win32") {
    await fs.chmod(file, exec ? 0o755 : 0o644)
  }
  return file
}

function env(PATH: string): NodeJS.ProcessEnv {
  return {
    PATH,
    PATHEXT: process.env["PATHEXT"],
  }
}

function envPath(Path: string): NodeJS.ProcessEnv {
  return {
    Path,
    PathExt: process.env["PathExt"] ?? process.env["PATHEXT"],
  }
}

const find = (command: string, environment?: NodeJS.ProcessEnv) => Effect.runPromise(which(command, environment))

function same(a: Option.Option<string>, b: string) {
  if (process.platform === "win32") {
    expect(Option.getOrUndefined(Option.map(a, (found) => found.toLowerCase()))).toBe(b.toLowerCase())
    return
  }

  expect(a).toEqual(Option.some(b))
}

describe("util.which", () => {
  test("returns None when command is missing", async () => {
    expect(await find("opencode-missing-command-for-test")).toEqual(Option.none())
  })

  test("finds a command from PATH override", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    const file = await cmd(bin, "tool")

    same(await find("tool", env(bin)), file)
  })

  test("reads a PATH that changes at run time when no env is given", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    const file = await cmd(bin, "runtime-tool")
    const previous = process.env.PATH
    process.env.PATH = [bin, previous].filter(Boolean).join(path.delimiter)
    try {
      same(await find("runtime-tool"), file)
    } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    }
  })

  test("uses first PATH match", async () => {
    await using tmp = await tmpdir()
    const a = path.join(tmp.path, "a")
    const b = path.join(tmp.path, "b")
    await fs.mkdir(a)
    await fs.mkdir(b)
    const first = await cmd(a, "dupe")
    await cmd(b, "dupe")

    same(await find("dupe", env([a, b].join(path.delimiter))), first)
  })

  test("returns None for non-executable file on unix", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    await cmd(bin, "noexec", false)

    expect(await find("noexec", env(bin))).toEqual(Option.none())
  })

  test("uses PATHEXT on windows", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    const file = path.join(bin, "pathext.CMD")
    await fs.writeFile(file, "@echo off\r\n")

    expect(await find("pathext", { PATH: bin, PATHEXT: ".CMD" })).toEqual(Option.some(file))
  })

  test("uses Windows Path casing fallback", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    const file = await cmd(bin, "mixed")

    same(await find("mixed", envPath(bin)), file)
  })
})
