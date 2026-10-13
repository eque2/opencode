import { describe, expect, test } from "bun:test"
import { parseCommit, type InvalidCommit, type ParsedCommit } from "../src/commit"

function valid(message: string, hash = "a1b2c3d"): ParsedCommit {
  const commit = parseCommit(hash, message)
  if (!commit.valid) throw new Error(`expected a valid commit, got: ${commit.reason}`)
  return commit
}

function invalid(message: string, hash = "a1b2c3d"): InvalidCommit {
  const commit = parseCommit(hash, message)
  if (commit.valid) throw new Error(`expected an invalid commit for ${JSON.stringify(message)}`)
  return commit
}

describe("T1.1 parse a conventional-commit message", () => {
  test("[T1.1.c1] a valid header gives its lower-cased type, optional scope and subject", () => {
    expect(valid("feat(api): add the orders endpoint")).toEqual({
      valid: true,
      hash: "a1b2c3d",
      type: "feat",
      scope: "api",
      subject: "add the orders endpoint",
      breaking: false,
      refs: [],
    })
    const upper = valid("FIX(Parser.v2/core-x): repair it")
    expect(upper.type).toBe("fix")
    expect(upper.scope).toBe("Parser.v2/core-x")
    expect(upper.subject).toBe("repair it")

    const noScope = valid("docs: explain the flags")
    expect(noScope.type).toBe("docs")
    expect(noScope.scope).toBeUndefined()
    expect("scope" in noScope).toBe(false)

    expect(valid("fix: handle a: b").subject).toBe("handle a: b")
    expect(valid("build-system: bump").type).toBe("build-system")
  })

  test("[T1.1.c2] '!' and BREAKING CHANGE / BREAKING-CHANGE footers make a commit breaking with its note", () => {
    const bang = valid("feat(api)!: drop v1 endpoints")
    expect(bang.breaking).toBe(true)
    expect(bang.breakingNote).toBe("drop v1 endpoints")

    const footer = valid("feat: new config format\n\nBREAKING CHANGE: the old keys are removed")
    expect(footer.breaking).toBe(true)
    expect(footer.breakingNote).toBe("the old keys are removed")

    const hyphen = valid("refactor: rename flags\n\nBREAKING-CHANGE: --out is now --output")
    expect(hyphen.breaking).toBe(true)
    expect(hyphen.breakingNote).toBe("--out is now --output")

    const both = valid("feat(api)!: drop v1\n\nBREAKING CHANGE: removed /v1")
    expect(both.breaking).toBe(true)
    expect(both.breakingNote).toBe("removed /v1")

    for (const message of [
      "feat: x\n\nBREAKING CHANGE #12",
      "feat: x\n\nbreaking change: x",
      "feat: x\n\nbreaking-change: y",
    ]) {
      const commit = valid(message)
      expect(commit.breaking).toBe(false)
      expect(commit.breakingNote).toBeUndefined()
    }
    expect(valid("feat: x\n\nbreaking change: x").body).toBe("breaking change: x")
    expect(valid("fix: plain").breaking).toBe(false)
  })

  test("[T1.1.c3] Refs footers in any case give the keys, split and de-duplicated in first-seen order", () => {
    expect(valid("fix: x\n\nRefs: PAY-12, PAY-13 PAY-12").refs).toEqual(["PAY-12", "PAY-13"])
    expect(valid("fix: x\n\nRefs #PAY-7").refs).toEqual(["PAY-7"])
    expect(valid("fix: x\n\nREFS: B-2\nrefs #A-1, B-2\nReviewed-by: Sam\nRefs: C-3,,D-4").refs).toEqual([
      "B-2",
      "A-1",
      "C-3",
      "D-4",
    ])
    expect(valid("fix: x\n\nRefs: A-1,\n  B-2").refs).toEqual(["A-1", "B-2"])
    expect(valid("fix: x\n\nReviewed-by: Sam").refs).toEqual([])
  })

  test("[T1.1.c4] bodies, footers, continuation lines, '!' after the colon and CRLF parse at their boundaries", () => {
    const multi = valid("fix: x\n\nfirst paragraph\nstill first\n\nNote: x\nsecond paragraph\n\nRefs: A-1")
    expect(multi.body).toBe("first paragraph\nstill first\n\nNote: x\nsecond paragraph")
    expect(multi.refs).toEqual(["A-1"])

    const notFooter = valid("fix: x\n\nbody\n\nthis final paragraph is body\nRefs: A-1")
    expect(notFooter.body).toBe("body\n\nthis final paragraph is body\nRefs: A-1")
    expect(notFooter.refs).toEqual([])

    const continued = valid("feat: x\n\nBREAKING CHANGE: the config file\n  moved to a new folder\nRefs: A-1")
    expect(continued.breakingNote).toBe("the config file moved to a new folder")
    expect(continued.refs).toEqual(["A-1"])
    expect(continued.body).toBeUndefined()

    const bangInSubject = valid("feat: !important flag")
    expect(bangInSubject.subject).toBe("!important flag")
    expect(bangInSubject.breaking).toBe(false)

    const lf = parseCommit("a1b2c3d", "fix(io): read it\n\nbody line\n\nBREAKING CHANGE: gone\nRefs: A-1\n")
    const crlf = parseCommit(
      "a1b2c3d",
      "fix(io): read it\r\n\r\nbody line\r\n\r\nBREAKING CHANGE: gone\r\nRefs: A-1\r\n",
    )
    expect(crlf).toEqual(lf)
    expect(lf).toEqual({
      valid: true,
      hash: "a1b2c3d",
      type: "fix",
      scope: "io",
      subject: "read it",
      body: "body line",
      breaking: true,
      breakingNote: "gone",
      refs: ["A-1"],
    })
  })

  test("[T1.1.c5] a message that breaks the convention returns an invalid commit with its reason", () => {
    const cases: [string, string][] = [
      ["update readme", "header has no type prefix"],
      [": no type", "header has no type prefix"],
      ["1fix: digits first", "header type must start with a letter"],
      ["fix:no space", "header needs a space after the colon"],
      ["fix:", "header has an empty subject"],
      ["fix:   ", "header has an empty subject"],
      ["fix:  two spaces", "header subject must follow a single space"],
      ["feat(: x", "header scope is malformed"],
      ["feat(): x", "header scope is malformed"],
      ["feat!(api): x", "header scope is malformed"],
      ["feat (api): x", "header scope is malformed"],
      ["feat(a)(b): x", "header scope is malformed"],
      ["fe at: x", "header type has invalid characters"],
      ["fix: x\nno blank line", "body must follow a blank line"],
      ["", "empty message"],
      ["  \n\t\n", "empty message"],
    ]
    for (const [message, reason] of cases) {
      let commit: ParsedCommit | InvalidCommit | undefined
      expect(() => {
        commit = parseCommit("a1b2c3d", message)
      }).not.toThrow()
      expect(commit).toEqual({ valid: false, hash: "a1b2c3d", raw: message, reason })
    }
  })

  test("[S2] a conventional message is read into its parts", () => {
    const marked = valid("feat(api)!: drop v1 endpoints\n\nThe v1 routes were deprecated a year ago.", "1111111")
    expect(marked).toEqual({
      valid: true,
      hash: "1111111",
      type: "feat",
      scope: "api",
      subject: "drop v1 endpoints",
      body: "The v1 routes were deprecated a year ago.",
      breaking: true,
      breakingNote: "drop v1 endpoints",
      refs: [],
    })
    const footed = valid(
      "fix(parser): reject empty scopes\n\nEmpty scopes used to pass.\n\nBREAKING CHANGE: feat(): x is now invalid\nRefs: PAY-12, PAY-13",
      "2222222",
    )
    expect(footed).toEqual({
      valid: true,
      hash: "2222222",
      type: "fix",
      scope: "parser",
      subject: "reject empty scopes",
      body: "Empty scopes used to pass.",
      breaking: true,
      breakingNote: "feat(): x is now invalid",
      refs: ["PAY-12", "PAY-13"],
    })
  })

  test("[S7] a message that is not conventional is kept as invalid, not lost", () => {
    const message = "update readme\n\nfix typos in the install section"
    let commit: ParsedCommit | InvalidCommit | undefined
    expect(() => {
      commit = parseCommit("3333333", message)
    }).not.toThrow()
    expect(commit).toEqual({ valid: false, hash: "3333333", raw: message, reason: "header has no type prefix" })
    expect(invalid(message, "3333333").raw).toBe(message)
  })
})
