import { describe, expect, test } from "bun:test"
import { nextVersion, type BumpInput } from "../src/bump"

const feat: BumpInput = { type: "feat", breaking: false }
const fix: BumpInput = { type: "fix", breaking: false }
const perf: BumpInput = { type: "perf", breaking: false }
const breaking = (type: string): BumpInput => ({ type, breaking: true })
const plain = (type: string): BumpInput => ({ type, breaking: false })

describe("T1.2 compute the next version", () => {
  test("[T1.2.c1] each type maps to its bump and the most significant change wins", () => {
    expect(nextVersion("1.4.2", [breaking("feat")])).toEqual({ bump: "major", next: "2.0.0" })
    expect(nextVersion("1.4.2", [breaking("chore")])).toEqual({ bump: "major", next: "2.0.0" })
    expect(nextVersion("0.4.2", [breaking("chore")])).toEqual({ bump: "minor", next: "0.5.0" })
    expect(nextVersion("1.4.2", [feat])).toEqual({ bump: "minor", next: "1.5.0" })
    expect(nextVersion("1.4.2", [fix])).toEqual({ bump: "patch", next: "1.4.3" })
    expect(nextVersion("1.4.2", [perf])).toEqual({ bump: "patch", next: "1.4.3" })
    for (const type of ["docs", "chore", "refactor", "test", "ci", "build", "style", "wip", "release"]) {
      expect(nextVersion("1.4.2", [plain(type)])).toEqual({ bump: "none", next: "1.4.2" })
    }
    expect(nextVersion("1.4.2", [fix, feat, plain("docs")])).toEqual({ bump: "minor", next: "1.5.0" })
    expect(nextVersion("1.4.2", [feat, breaking("fix"), fix])).toEqual({ bump: "major", next: "2.0.0" })
    expect(nextVersion("1.4.2", [plain("docs"), perf])).toEqual({ bump: "patch", next: "1.4.3" })
  })

  test("[T1.2.c2] the bump resets the lower parts, drops pre-release and build, and none keeps the version", () => {
    expect(nextVersion("0.9.9", [breaking("feat")])).toEqual({ bump: "minor", next: "0.10.0" })
    expect(nextVersion("0.9.9", [fix])).toEqual({ bump: "patch", next: "0.9.10" })
    expect(nextVersion("0.3.2", [feat])).toEqual({ bump: "minor", next: "0.4.0" })
    expect(nextVersion("0.0.0", [breaking("fix")])).toEqual({ bump: "minor", next: "0.1.0" })
    expect(nextVersion("0.0.0", [fix])).toEqual({ bump: "patch", next: "0.0.1" })
    expect(nextVersion("1.0.0", [breaking("feat")])).toEqual({ bump: "major", next: "2.0.0" })
    expect(nextVersion("1.4.2", [feat])).toEqual({ bump: "minor", next: "1.5.0" })
    expect(nextVersion("3.7.9", [breaking("feat")])).toEqual({ bump: "major", next: "4.0.0" })
    expect(nextVersion("1.4.2-rc.1+build.5", [fix])).toEqual({ bump: "patch", next: "1.4.3" })
    expect(nextVersion("2.0.0-rc.1", [breaking("feat")])).toEqual({ bump: "major", next: "3.0.0" })
    expect(nextVersion("1.4.2-rc.1+build.5", [])).toEqual({ bump: "none", next: "1.4.2-rc.1+build.5" })
    expect(nextVersion("1.4.2-rc.1+build.5", [plain("docs")])).toEqual({ bump: "none", next: "1.4.2-rc.1+build.5" })
  })

  test("[T1.2.c3] an invalid version returns an error and never throws", () => {
    for (const version of [
      "1.x",
      "01.2.3",
      "1.2",
      "1.2.3-",
      "1.2.3-01",
      "1.2.3+",
      "1.2.3-a..b",
      "1.02.3",
      "1.2.03",
      "",
      " 1.2.3",
    ]) {
      let result: ReturnType<typeof nextVersion> | undefined
      expect(() => {
        result = nextVersion(version, [fix])
      }).not.toThrow()
      expect(result).toEqual({ error: `"${version}" is not a semantic version` })
    }
    expect(nextVersion("1.x", [])).toEqual({ error: '"1.x" is not a semantic version' })
  })

  test("[T1.2.c4] parts beyond Number.MAX_SAFE_INTEGER stay exact", () => {
    expect(nextVersion("1.4.9007199254740993", [fix])).toEqual({ bump: "patch", next: "1.4.9007199254740994" })
    expect(nextVersion("9007199254740993.0.0", [breaking("feat")])).toEqual({
      bump: "major",
      next: "9007199254740994.0.0",
    })
    expect(nextVersion("1.9007199254740993.7", [feat])).toEqual({ bump: "minor", next: "1.9007199254740994.0" })
  })

  test("[S3] the next version follows the most significant change", () => {
    const rows: [string, BumpInput[], ReturnType<typeof nextVersion>][] = [
      ["1.4.0", [feat, breaking("feat"), fix], { bump: "major", next: "2.0.0" }],
      ["0.4.0", [breaking("feat")], { bump: "minor", next: "0.5.0" }],
      ["1.4.0", [fix, feat], { bump: "minor", next: "1.5.0" }],
      ["1.4.0", [fix], { bump: "patch", next: "1.4.1" }],
      ["1.4.0", [perf], { bump: "patch", next: "1.4.1" }],
      ["1.4.0", [plain("docs"), plain("chore")], { bump: "none", next: "1.4.0" }],
      ["1.4.0", [], { bump: "none", next: "1.4.0" }],
    ]
    for (const [current, commits, expected] of rows) {
      expect(nextVersion(current, commits)).toEqual(expected)
    }
  })
})
