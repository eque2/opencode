import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { makeLinkify, parseLinkConfig, plainLinkify, type LinkConfig } from "../src/links"

// Every path comes from this file's folder, never from the working directory.
const CLI = path.join(import.meta.dir, "..", "src", "cli.ts")
const CONFIG_FILE = "release-notes.config.json"
const AGREED = { issueUrl: "https://issues.eque2.test/browse/{key}", keyPattern: "^[A-Z][A-Z0-9]+-\\d+$" }
const TIMEOUT = 30_000

type Run = { code: number; stdout: string; stderr: string }

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

function newFolder(): string {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "release-notes-links-")))
  folders.push(folder)
  return folder
}

/** RN-D4: no global or system config, fixed identities and dates, and git never looks above the temp folder. */
function isolatedEnv(folder: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: folder,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: path.dirname(folder),
    GIT_AUTHOR_NAME: "Release Notes",
    GIT_AUTHOR_EMAIL: "release-notes@eque2.test",
    GIT_COMMITTER_NAME: "Release Notes",
    GIT_COMMITTER_EMAIL: "release-notes@eque2.test",
    GIT_AUTHOR_DATE: "1767225600 +0000",
    GIT_COMMITTER_DATE: "1767225600 +0000",
  }
}

function run(cmd: string[], cwd: string, env: Record<string, string>): Run {
  const result = Bun.spawnSync(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

/** A repository whose one commit refers to `PAY-12` and `nonsense`; returns it and the commit's short hash. */
function refsRepo(): { dir: string; env: Record<string, string>; hash: string } {
  const dir = newFolder()
  const env = isolatedEnv(dir)
  const git = (...args: string[]) => {
    const result = run(["git", ...args], dir, env)
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  git("init", "-q")
  git("commit", "-q", "--allow-empty", "-m", "fix(pay): round totals\n\nRefs: PAY-12, nonsense")
  return { dir, env, hash: git("log", "-1", "--format=%h") }
}

function linkConfig(text: string): LinkConfig {
  const config = parseLinkConfig(text)
  if ("error" in config) throw new Error(`expected a valid config, got: ${config.error}`)
  return config
}

describe("T1.5 link issue references", () => {
  test("[T1.5.c1] a matching key becomes a link from the template; other keys stay plain", () => {
    const agreed = makeLinkify(linkConfig(JSON.stringify(AGREED)))
    expect(agreed("PAY-12")).toBe("[PAY-12](https://issues.eque2.test/browse/PAY-12)")

    const twice = makeLinkify(
      linkConfig(JSON.stringify({ issueUrl: "https://issues.eque2.test/{key}/view?key={key}" })),
    )
    expect(twice("PAY-12")).toBe("[PAY-12](https://issues.eque2.test/PAY-12/view?key=PAY-12)")

    const byDefault = makeLinkify(linkConfig(JSON.stringify({ issueUrl: AGREED.issueUrl })))
    expect(byDefault("AB2-7")).toBe("[AB2-7](https://issues.eque2.test/browse/AB2-7)")
    for (const key of ["nonsense", "pay-12", "PAY-", "P-12", "PAY-12x"]) {
      expect(byDefault(key)).toBe(key)
    }
  })

  test("[T1.5.c2] parseLinkConfig returns an error for every bad config and never throws", () => {
    const bad = [
      "{",
      "",
      "null",
      "[]",
      "42",
      '"https://issues.eque2.test/{key}"',
      "{}",
      '{"issueUrl": 5}',
      '{"issueUrl": null}',
      '{"issueUrl": "https://issues.eque2.test/browse/"}',
      '{"issueUrl": "ftp://issues.eque2.test/{key}"}',
      '{"issueUrl": "javascript:alert({key})"}',
      '{"issueUrl": "issues.eque2.test/{key}"}',
      '{"issueUrl": "https://issues.eque2.test/{key}", "keyPattern": 5}',
      '{"issueUrl": "https://issues.eque2.test/{key}", "keyPattern": null}',
      '{"issueUrl": "https://issues.eque2.test/{key}", "keyPattern": ["A"]}',
      '{"issueUrl": "https://issues.eque2.test/{key}", "keyPattern": "(["}',
    ]
    for (const text of bad) {
      let result: ReturnType<typeof parseLinkConfig> | undefined
      expect(() => {
        result = parseLinkConfig(text)
      }).not.toThrow()
      expect({ text, isError: result !== undefined && "error" in result }).toEqual({ text, isError: true })
    }

    const defaulted = linkConfig('{"issueUrl": "http://issues.eque2.test/{key}"}')
    expect(defaulted.issueUrl).toBe("http://issues.eque2.test/{key}")
    expect(defaulted.keyPattern.test("PAY-12")).toBe(true)
    expect(defaulted.keyPattern.test("pay-12")).toBe(false)
    expect(defaulted.keyPattern.test("xPAY-12")).toBe(false)
  })

  test("[T1.5.c3] a key cannot break the link, and the same key gives the same result every time", () => {
    const permissive = makeLinkify(linkConfig(JSON.stringify({ issueUrl: "https://x.test/{key}", keyPattern: ".+" })))
    expect(permissive("A)B")).toBe("[A\\)B](https://x.test/A%29B)")
    expect(permissive("[x](y)")).toBe("[\\[x\\]\\(y\\)](https://x.test/%5Bx%5D%28y%29)")
    expect(permissive("a b/c")).toBe("[a b/c](https://x.test/a%20b%2Fc)")

    const agreed = linkConfig(JSON.stringify(AGREED))
    expect(agreed.keyPattern.flags).not.toContain("g")
    const linkify = makeLinkify(agreed)
    const first = linkify("PAY-12")
    for (let index = 0; index < 3; index++) expect(linkify("PAY-12")).toBe(first)
    expect(linkify("PAY-12")).toBe("[PAY-12](https://issues.eque2.test/browse/PAY-12)")

    // A key that does not match is escaped as the renderer escapes.
    expect(linkify("<b>_x_|")).toBe("\\<b\\>\\_x\\_\\|")
    expect(plainLinkify("A_1")).toBe("A\\_1")
  })

  test(
    "[T1.5.c4] the CLI reads the config from the top level; missing is silent, bad warns, refs always appear",
    () => {
      const { dir, env, hash } = refsRepo()
      const subfolder = path.join(dir, "docs", "notes")
      mkdirSync(subfolder, { recursive: true })
      const linked = `# Release notes\n\n## Fixes\n\n- **pay:** round totals (${hash}) — refs [PAY-12](https://issues.eque2.test/browse/PAY-12), nonsense\n\nNext version: 0.0.1 (patch)\n`
      const plain = `# Release notes\n\n## Fixes\n\n- **pay:** round totals (${hash}) — refs PAY-12, nonsense\n\nNext version: 0.0.1 (patch)\n`

      // Missing: silent, plain refs.
      expect(run([process.execPath, CLI], subfolder, env)).toEqual({ code: 0, stdout: plain, stderr: "" })

      // Valid, read from the top level while running in a subfolder.
      const configPath = path.join(dir, CONFIG_FILE)
      writeFileSync(configPath, JSON.stringify(AGREED))
      expect(run([process.execPath, CLI], subfolder, env)).toEqual({ code: 0, stdout: linked, stderr: "" })
      expect(run([process.execPath, CLI], dir, env)).toEqual({ code: 0, stdout: linked, stderr: "" })

      // Invalid: a warning that names the problem, plain refs.
      writeFileSync(configPath, '{"issueUrl": "ftp://issues.eque2.test/{key}"}')
      const invalid = run([process.execPath, CLI], subfolder, env)
      expect(invalid.code).toBe(0)
      expect(invalid.stdout).toBe(plain)
      expect(invalid.stderr).toContain("warning")
      expect(invalid.stderr).toContain(CONFIG_FILE)
      expect(invalid.stderr).toContain("http")

      writeFileSync(configPath, "{ not json")
      const malformed = run([process.execPath, CLI], dir, env)
      expect(malformed.code).toBe(0)
      expect(malformed.stdout).toBe(plain)
      expect(malformed.stderr).toContain("not valid JSON")

      // Unreadable: a folder where the file should be.
      rmSync(configPath)
      mkdirSync(configPath)
      const unreadable = run([process.execPath, CLI], subfolder, env)
      expect(unreadable.code).toBe(0)
      expect(unreadable.stdout).toBe(plain)
      expect(unreadable.stderr).toContain("cannot read")
      expect(unreadable.stderr).toContain(CONFIG_FILE)
    },
    TIMEOUT,
  )

  test(
    "[S5] issue references become links when the key is known",
    () => {
      const { dir, env, hash } = refsRepo()
      writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(AGREED, null, 2))
      const result = run([process.execPath, CLI], dir, env)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      const line = result.stdout.split("\n").find((text) => text.includes(`(${hash})`))
      expect(line).toBe(
        `- **pay:** round totals (${hash}) — refs [PAY-12](https://issues.eque2.test/browse/PAY-12), nonsense`,
      )
    },
    TIMEOUT,
  )
})
