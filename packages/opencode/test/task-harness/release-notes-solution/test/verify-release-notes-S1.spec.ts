import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Every path comes from this file's folder, never from the working directory.
const PACKAGE_ROOT = path.join(import.meta.dir, "..")
const CLI = path.join(PACKAGE_ROOT, "src", "cli.ts")
const EXPECTED = path.join(import.meta.dir, "expected", "release-notes.md")
const TIMEOUT = 30_000

type Run = { code: number; stdout: string; stderr: string }

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

function newFolder(): string {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "release-notes-cli-")))
  folders.push(folder)
  return folder
}

/** RN-D4: no global or system config, fixed identities, and git never looks above the temp folder. */
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

class Repo {
  readonly dir: string
  readonly env: Record<string, string>
  private tick = 0

  constructor(options: { bare?: boolean } = {}) {
    this.dir = newFolder()
    this.env = isolatedEnv(this.dir)
    this.git("init", "-q", ...(options.bare ? ["--bare"] : []))
  }

  git(...args: string[]): string {
    const result = run(["git", ...args], this.dir, this.env)
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
    return result.stdout.trim()
  }

  /** Commits with the next fixed date and returns the short hash, as `git log --format=%h` prints it. */
  commit(message: string): string {
    this.tick += 1
    const date = `${1767225600 + this.tick * 60} +0000`
    const result = run(["git", "commit", "-q", "--allow-empty", "-m", message], this.dir, {
      ...this.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    })
    if (result.code !== 0) throw new Error(`git commit failed: ${result.stderr}`)
    return this.git("log", "-1", "--format=%h")
  }

  cli(args: string[] = [], cwd = this.dir): Run {
    return run([process.execPath, CLI, ...args], cwd, this.env)
  }
}

/** The S1 repository: `chore: initial` tagged v1.4.0, then the five pinned commits, oldest first. */
function s1Repo(): { repo: Repo; expected: string } {
  const repo = new Repo()
  repo.commit("chore: initial")
  repo.git("tag", "v1.4.0")
  const hashes = [
    repo.commit("feat(api)!: drop v1 endpoints\n\nBREAKING CHANGE: removed /v1"),
    repo.commit("feat(cli): add --to option"),
    repo.commit("feat: add JSON export"),
    repo.commit("fix(parser): handle empty body"),
    repo.commit("update readme"),
  ]
  let expected = readFileSync(EXPECTED, "utf8")
  for (const [index, hash] of hashes.entries()) expected = expected.replaceAll(`{h${index + 1}}`, hash)
  return { repo, expected }
}

/** Tags v1.3.0 and v1.4.0, then a `nightly` tag and a pre-release tag that the default range skips. */
function taggedRepo() {
  const repo = new Repo()
  const c0 = repo.commit("chore: initial")
  repo.git("tag", "v1.3.0")
  const c1 = repo.commit("fix: early fix")
  repo.git("tag", "v1.4.0")
  const c2 = repo.commit("feat: new thing")
  repo.git("tag", "nightly")
  const c3 = repo.commit("fix: later fix")
  repo.git("tag", "v1.5.0-rc.1")
  return { repo, c0, c1, c2, c3 }
}

function notes(sections: string[], next: string): string {
  return `# Release notes\n\n${sections.join("\n\n")}\n\nNext version: ${next}\n`
}

describe("T1.4 print release notes for a git range", () => {
  test(
    "[T1.4.c1] the five pinned S1 commits print exactly the expected file",
    () => {
      const { repo, expected } = s1Repo()
      const result = repo.cli()
      expect(result.stderr).toBe("")
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(expected)
      expect(result.stdout.endsWith("Next version: 2.0.0 (major)\n")).toBe(true)
    },
    TIMEOUT,
  )

  test(
    "[T1.4.c2] the range and the current version follow the tags, the options and their defaults",
    () => {
      const { repo, c1, c2, c3 } = taggedRepo()
      const latest = notes(
        ["## Features\n\n- new thing (" + c2 + ")", "## Fixes\n\n- later fix (" + c3 + ")"],
        "1.5.0 (minor)",
      )

      // The latest stable tag, skipping `nightly` and `v1.5.0-rc.1`.
      expect(repo.cli()).toEqual({ code: 0, stdout: latest, stderr: "" })

      // --from and --to, also as --name=value.
      expect(repo.cli(["--from", "v1.3.0"])).toEqual({
        code: 0,
        stdout: notes(
          ["## Features\n\n- new thing (" + c2 + ")", "## Fixes\n\n- later fix (" + c3 + ")\n- early fix (" + c1 + ")"],
          "1.4.0 (minor)",
        ),
        stderr: "",
      })
      expect(repo.cli(["--from=v1.3.0", "--to=v1.4.0"])).toEqual({
        code: 0,
        stdout: notes(["## Fixes\n\n- early fix (" + c1 + ")"], "1.3.1 (patch)"),
        stderr: "",
      })
      expect(repo.cli(["--from", "v1.3.0", "--to", "v1.4.0"]).stdout).toBe(
        notes(["## Fixes\n\n- early fix (" + c1 + ")"], "1.3.1 (patch)"),
      )

      // --current with or without `v` overrides the tag.
      for (const current of ["v2.1.0", "2.1.0", "--current=v2.1.0"]) {
        const args = current.startsWith("--") ? [current] : ["--current", current]
        expect(repo.cli(args)).toEqual({
          code: 0,
          stdout: latest.replace("1.5.0 (minor)", "2.2.0 (minor)"),
          stderr: "",
        })
      }

      // A SHA --from: the range starts there and the version comes from the latest stable tag reachable from it.
      const sha = repo.git("rev-parse", c2)
      expect(repo.cli(["--from", sha])).toEqual({
        code: 0,
        stdout: notes(["## Fixes\n\n- later fix (" + c3 + ")"], "1.4.1 (patch)"),
        stderr: "",
      })

      // No tag at all: the whole history and 0.0.0.
      const untagged = new Repo()
      const a = untagged.commit("fix: first")
      const b = untagged.commit("feat: second")
      expect(untagged.cli()).toEqual({
        code: 0,
        stdout: notes(["## Features\n\n- second (" + b + ")", "## Fixes\n\n- first (" + a + ")"], "0.1.0 (minor)"),
        stderr: "",
      })

      // HEAD on the tag: no changes and no bump.
      const onTag = new Repo()
      onTag.commit("feat: released")
      onTag.git("tag", "v1.0.0")
      expect(onTag.cli()).toEqual({
        code: 0,
        stdout: "# Release notes\n\nNo changes.\n\nNext version: 1.0.0 (none)\n",
        stderr: "",
      })

      // An empty repository.
      expect(new Repo().cli()).toEqual({
        code: 0,
        stdout: "# Release notes\n\nNo changes.\n\nNext version: 0.0.0 (none)\n",
        stderr: "",
      })
    },
    TIMEOUT,
  )

  test(
    "[T1.4.c3] bad arguments print nothing on stdout and exit 2; --help and -h print usage and exit 0",
    () => {
      const { repo } = taggedRepo()
      const usageErrors = [
        ["--bogus"],
        ["--from"],
        ["--from="],
        ["--from", ""],
        ["--current"],
        ["HEAD"],
        ["--from", "-1"],
        ["--to=-x"],
        ["--from", "v1.3.0", "extra"],
        ["-x"],
      ]
      for (const args of usageErrors) {
        const result = repo.cli(args)
        expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 2, stdout: "" })
        expect(result.stderr).toContain("Usage: release-notes")
      }
      const unknownRefs: [string[], string][] = [
        [["--from", "nope"], "nope"],
        [["--to=missing-ref"], "missing-ref"],
      ]
      for (const [args, ref] of unknownRefs) {
        const result = repo.cli(args)
        expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 2, stdout: "" })
        expect(result.stderr).toContain(`unknown ref "${ref}"`)
      }
      for (const flag of ["--help", "-h"]) {
        const result = repo.cli([flag])
        expect(result.code).toBe(0)
        expect(result.stderr).toBe("")
        expect(result.stdout.startsWith("Usage: release-notes [--from <ref>] [--to <ref>] [--current <version>]")).toBe(
          true,
        )
      }
    },
    TIMEOUT,
  )

  test(
    "[T1.4.c4] an empty folder, the .git folder and a bare repository exit 3 with git's message",
    () => {
      const empty = newFolder()
      const outside = run([process.execPath, CLI], empty, isolatedEnv(empty))
      expect(outside.code).toBe(3)
      expect(outside.stdout).toBe("")
      expect(outside.stderr).toContain("not a git repository")

      const repo = new Repo()
      repo.commit("chore: initial")
      const inside = repo.cli([], path.join(repo.dir, ".git"))
      expect(inside.code).toBe(3)
      expect(inside.stdout).toBe("")
      expect(inside.stderr).toContain("not inside a git work tree")

      const bare = new Repo({ bare: true })
      const bareRun = bare.cli()
      expect(bareRun.code).toBe(3)
      expect(bareRun.stdout).toBe("")
      expect(bareRun.stderr).toContain("not inside a git work tree")
    },
    TIMEOUT,
  )

  test(
    "[T1.4.c5] --current 1.x exits 2",
    () => {
      const { repo } = taggedRepo()
      for (const args of [["--current", "1.x"], ["--current=v1.x"]]) {
        const result = repo.cli(args)
        expect(result.code).toBe(2)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("is not a semantic version")
      }
    },
    TIMEOUT,
  )

  test(
    "[T1.4.c6] with no git on the PATH the real entry prints git not found and exits 4",
    () => {
      const repo = new Repo()
      repo.commit("chore: initial")
      const noGit = newFolder()
      const result = run([process.execPath, CLI], repo.dir, { ...repo.env, PATH: noGit })
      expect(result.code).toBe(4)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("git not found")
    },
    TIMEOUT,
  )

  test(
    "[T1.4.c7] merges are left out, records stay whole, warnings go to stderr, and git is isolated",
    () => {
      // Git sees only the repository's own config and the fixed identity and date.
      const repo = new Repo()
      const first = repo.commit("chore: initial")
      const origins = repo.git("config", "--list", "--show-origin").split("\n")
      expect(origins.filter((line) => !line.startsWith("file:.git/config\t"))).toEqual([])
      expect(repo.git("log", "-1", "--format=%an <%ae> %at %cn <%ce> %ct")).toBe(
        "Release Notes <release-notes@eque2.test> 1767225660 Release Notes <release-notes@eque2.test> 1767225660",
      )

      // A merge commit is left out; the merged commits are listed.
      const main = repo.git("symbolic-ref", "--short", "HEAD")
      repo.git("checkout", "-q", "-b", "topic")
      const topic = repo.commit("feat: topic work")
      repo.git("checkout", "-q", main)
      const onMain = repo.commit("fix: main work")
      repo.git("merge", "-q", "--no-ff", "-m", "Merge branch 'topic'", "topic")
      // A message with blank lines, a hash-like line and a header-like line is still one record.
      const whole = repo.commit(
        "fix: keep records whole\n\nabc1234\n\nfeat: this line looks like a header\n\nRefs: PAY-9",
      )
      const merged = repo.cli()
      expect(merged.code).toBe(0)
      expect(merged.stderr).toBe("")
      expect(merged.stdout).not.toContain("Merge branch")
      expect(merged.stdout).toBe(
        notes(
          [
            "## Features\n\n- topic work (" + topic + ")",
            "## Fixes\n\n- keep records whole (" + whole + ") — refs PAY-9\n- main work (" + onMain + ")",
            "## Other\n\n- initial (" + first + ")",
          ],
          "0.1.0 (minor)",
        ),
      )

      // An unparsed commit with a BREAKING CHANGE footer warns and still exits 0.
      const footer = repo.commit("update deps\n\nBREAKING CHANGE: node 18 is gone")
      const warned = repo.cli(["--from", whole])
      expect(warned.code).toBe(0)
      expect(warned.stdout).toBe(notes(["## Unparsed commits\n\n- update deps (" + footer + ")"], "0.0.0 (none)"))
      expect(warned.stderr).toContain("warning")
      expect(warned.stderr).toContain(footer)
      expect(warned.stderr).toContain("BREAKING CHANGE")

      // A shallow clone warns and still exits 0.
      const clone = newFolder()
      const cloned = run(["git", "clone", "-q", "--depth", "1", `file://${repo.dir}`, clone], repo.dir, repo.env)
      expect(cloned.stderr).toBe("")
      expect(cloned.code).toBe(0)
      const shallow = run([process.execPath, CLI], clone, isolatedEnv(clone))
      expect(shallow.code).toBe(0)
      expect(shallow.stdout).toContain("- update deps (")
      expect(shallow.stderr).toContain("shallow")
    },
    TIMEOUT,
  )

  test("[T1.4.c8] the entry starts with the bun shebang and package.json has the bin entry", () => {
    expect(readFileSync(CLI, "utf8").split("\n")[0]).toBe("#!/usr/bin/env bun")
    const pkg: unknown = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"))
    expect(pkg).toMatchObject({ bin: { "release-notes": "src/cli.ts" } })
  })

  test(
    "[S1] release notes and the next version for a known range",
    () => {
      const { repo, expected } = s1Repo()
      const result = repo.cli()
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(expected)
      expect(result.stdout).toContain("## Unparsed commits\n\n- update readme (")
      expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("Next version: 2.0.0 (major)")
    },
    TIMEOUT,
  )

  test(
    "[S6] the default range starts at the latest tag",
    () => {
      const { repo, c0, c1, c2, c3 } = taggedRepo()
      const result = repo.cli()
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`(${c2})`)
      expect(result.stdout).toContain(`(${c3})`)
      expect(result.stdout).not.toContain(`(${c1})`)
      expect(result.stdout).not.toContain(`(${c0})`)
      // A feature on 1.4.0 gives 1.5.0, so the current version was taken as 1.4.0.
      expect(result.stdout.endsWith("Next version: 1.5.0 (minor)\n")).toBe(true)
    },
    TIMEOUT,
  )

  test(
    "[S8] an unknown option explains the usage and exits 2",
    () => {
      const { repo } = s1Repo()
      const result = repo.cli(["--since", "v1.4.0"])
      expect(result.code).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain('unknown option "--since"')
      expect(result.stderr).toContain("Usage: release-notes")
    },
    TIMEOUT,
  )

  test(
    "[S9] a folder that is not a repository exits 3",
    () => {
      const folder = newFolder()
      mkdirSync(path.join(folder, "notes"))
      const result = run([process.execPath, CLI], path.join(folder, "notes"), isolatedEnv(folder))
      expect(result.code).toBe(3)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("not a git repository")
    },
    TIMEOUT,
  )

  test(
    "[S10] an invalid current version exits 2",
    () => {
      const { repo } = s1Repo()
      const result = repo.cli(["--current", "1.x"])
      expect(result.code).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain('"1.x" is not a semantic version')
    },
    TIMEOUT,
  )

  test(
    "[S11] a machine without git exits 4",
    () => {
      const folder = newFolder()
      const result = run([process.execPath, CLI], folder, { ...isolatedEnv(folder), PATH: newFolder() })
      expect(result.code).toBe(4)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("git not found")
    },
    TIMEOUT,
  )

  // The deployed scenario: it needs the published package (T8), so it reports skipped when no registry is named.
  const registry = process.env["RELEASE_NOTES_REGISTRY"]
  test.skipIf(registry === undefined || registry === "")(
    "[S13] the published package runs from the registry",
    () => {
      const { repo, expected } = s1Repo()
      const published = run([process.execPath, "x", "@eque2-spike/release-notes"], repo.dir, {
        ...repo.env,
        BUN_CONFIG_REGISTRY: registry ?? "",
      })
      expect(published.code).toBe(0)
      expect(published.stdout).toBe(expected)
      expect(published.stdout).toBe(repo.cli().stdout)
    },
    120_000,
  )
})
