import { describe, expect, test } from "bun:test"
import type { InvalidCommit, ParsedCommit } from "../src/commit"
import { renderNotes } from "../src/render"

function parsed(hash: string, type: string, subject: string, extra: Partial<ParsedCommit> = {}): ParsedCommit {
  return { valid: true, hash, type, subject, breaking: false, refs: [], ...extra }
}

function unparsed(hash: string, raw: string): InvalidCommit {
  return { valid: false, hash, raw, reason: "header has no type prefix" }
}

/** The hash token that ends each list line, before any refs suffix. */
function lineHashes(notes: string): string[] {
  return notes
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => / \(([0-9a-f]+)\)(?: — refs .*)?$/.exec(line)?.[1] ?? "")
}

describe("T1.3 render the release notes as Markdown", () => {
  test("[T1.3.c1] the output follows the exact format", () => {
    const notes = renderNotes([
      parsed("a000001", "feat", "add orders", { scope: "api" }),
      parsed("b000002", "fix", "repair parser"),
      parsed("c000003", "perf", "faster render"),
      parsed("d000004", "feat", "drop old flag", { scope: "core", breaking: true, breakingNote: "removed --old" }),
      parsed("e000005", "docs", "explain flags"),
      parsed("f000006", "fix", "same note", { breaking: true, breakingNote: "same note" }),
      unparsed("0000007", "update readme"),
    ])
    expect(notes).toBe(
      [
        "# Release notes",
        "",
        "## Breaking changes",
        "",
        "- **core:** drop old flag — removed --old (d000004)",
        "- same note (f000006)",
        "",
        "## Features",
        "",
        "- **api:** add orders (a000001)",
        "",
        "## Fixes",
        "",
        "- repair parser (b000002)",
        "",
        "## Performance",
        "",
        "- faster render (c000003)",
        "",
        "## Other",
        "",
        "- explain flags (e000005)",
        "",
        "## Unparsed commits",
        "",
        "- update readme (0000007)",
        "",
      ].join("\n"),
    )
    expect(notes.endsWith("\n")).toBe(true)
    expect(notes.endsWith("\n\n")).toBe(false)

    expect(renderNotes([])).toBe("# Release notes\n\nNo changes.\n")
    expect(renderNotes([parsed("a000001", "fix", "only fix")])).toBe(
      "# Release notes\n\n## Fixes\n\n- only fix (a000001)\n",
    )
  })

  test("[T1.3.c2] breaking commits go only under Breaking changes, other types under Other, input order kept", () => {
    const notes = renderNotes([
      parsed("a000001", "docs", "docs break", { breaking: true, breakingNote: "docs moved" }),
      parsed("b000002", "chore", "tidy"),
      parsed("c000003", "fix", "fix break", { breaking: true, breakingNote: "fix break" }),
      parsed("d000004", "wip", "unknown type"),
      parsed("e000005", "feat", "second feature"),
      parsed("f000006", "refactor", "rework"),
      parsed("0000007", "feat", "third feature"),
    ])
    expect(notes).toBe(
      [
        "# Release notes",
        "",
        "## Breaking changes",
        "",
        "- docs break — docs moved (a000001)",
        "- fix break (c000003)",
        "",
        "## Features",
        "",
        "- second feature (e000005)",
        "- third feature (0000007)",
        "",
        "## Other",
        "",
        "- tidy (b000002)",
        "- unknown type (d000004)",
        "- rework (f000006)",
        "",
      ].join("\n"),
    )
    expect(notes.split("\n").filter((line) => line.includes("(a000001)"))).toHaveLength(1)
    expect(notes.split("\n").filter((line) => line.includes("(c000003)"))).toHaveLength(1)
  })

  test("[T1.3.c3] invalid commits are listed last under Unparsed commits", () => {
    const notes = renderNotes([
      unparsed("a000001", "\r\n\r\nupdate readme\r\nwith a second line"),
      parsed("b000002", "fix", "repair"),
      unparsed("c000003", ""),
      unparsed("d000004", "  \n\t\n"),
    ])
    expect(notes).toBe(
      [
        "# Release notes",
        "",
        "## Fixes",
        "",
        "- repair (b000002)",
        "",
        "## Unparsed commits",
        "",
        "- update readme (a000001)",
        "- (empty message) (c000003)",
        "- (empty message) (d000004)",
        "",
      ].join("\n"),
    )
    expect(renderNotes([unparsed("a000001", "wip")])).toBe(
      "# Release notes\n\n## Unparsed commits\n\n- wip (a000001)\n",
    )
    expect(renderNotes([parsed("a000001", "feat", "x")])).not.toContain("Unparsed commits")
  })

  test("[T1.3.c4] commit text cannot inject a link, HTML or a table cell", () => {
    const notes = renderNotes([
      parsed("a000001", "feat", "use <b>bold</b> and [a](http://x.test) | cell", {
        scope: "my_scope",
        refs: ["A_1", "[x]"],
      }),
      parsed("b000002", "fix", "star * under _ tick ` back \\ slash", {
        breaking: true,
        breakingNote: "note <i> | [y]",
      }),
      unparsed("c000003", "raw *text* with <tag> | pipe"),
      parsed("d000004", "fix", "no refs"),
    ])
    expect(notes).toBe(
      [
        "# Release notes",
        "",
        "## Breaking changes",
        "",
        "- star \\* under \\_ tick \\` back \\\\ slash — note \\<i\\> \\| \\[y\\] (b000002)",
        "",
        "## Features",
        "",
        "- **my\\_scope:** use \\<b\\>bold\\</b\\> and \\[a\\](http://x.test) \\| cell (a000001) — refs A\\_1, \\[x\\]",
        "",
        "## Fixes",
        "",
        "- no refs (d000004)",
        "",
        "## Unparsed commits",
        "",
        "- raw \\*text\\* with \\<tag\\> \\| pipe (c000003)",
        "",
      ].join("\n"),
    )

    const linked = renderNotes([parsed("a000001", "fix", "x", { refs: ["PAY-12", "a_b"] })], {
      linkify: (key) => `<${key}>`,
    })
    expect(linked).toBe("# Release notes\n\n## Fixes\n\n- x (a000001) — refs <PAY-12>, <a_b>\n")
  })

  test("[T1.3.c5] every input hash appears exactly once at the token that ends its line", () => {
    const input = [
      parsed("a000001", "feat", "revert (b000002) and (c000003)", { refs: ["PAY-1"] }),
      parsed("b000002", "fix", "fix after a000001"),
      unparsed("c000003", "Revert (a000001)"),
      parsed("d000004", "docs", "docs", { breaking: true, breakingNote: "see (b000002)" }),
      unparsed("e000005", ""),
    ]
    const hashes = lineHashes(renderNotes(input))
    expect([...hashes].sort()).toEqual(input.map((commit) => commit.hash).sort())
    expect(new Set(hashes).size).toBe(input.length)
  })

  test("[S4] notes are grouped under fixed headings with bold scopes and short hashes", () => {
    const notes = renderNotes([
      parsed("9f8e7d6", "fix", "handle empty body", { scope: "parser" }),
      parsed("1a2b3c4", "feat", "add --to option", { scope: "cli" }),
      parsed("5d6e7f8", "feat", "add JSON export"),
      parsed("0a0b0c0", "chore", "bump tooling"),
      parsed("7e7e7e7", "feat", "drop v1 endpoints", { scope: "api", breaking: true, breakingNote: "removed /v1" }),
    ])
    expect(notes).toBe(
      [
        "# Release notes",
        "",
        "## Breaking changes",
        "",
        "- **api:** drop v1 endpoints — removed /v1 (7e7e7e7)",
        "",
        "## Features",
        "",
        "- **cli:** add --to option (1a2b3c4)",
        "- add JSON export (5d6e7f8)",
        "",
        "## Fixes",
        "",
        "- **parser:** handle empty body (9f8e7d6)",
        "",
        "## Other",
        "",
        "- bump tooling (0a0b0c0)",
        "",
      ].join("\n"),
    )
    expect(notes).not.toContain("## Performance")
  })

  test("[S12] every commit in the range appears exactly once", () => {
    const input: (ParsedCommit | InvalidCommit)[] = [
      parsed("1111111", "feat", "add export"),
      unparsed("2222222", "update readme mentions 1111111"),
      parsed("3333333", "fix", "undo (1111111)", { refs: ["PAY-3"] }),
      unparsed("4444444", ""),
      parsed("5555555", "perf", "cache", { breaking: true, breakingNote: "cache keys changed" }),
      parsed("6666666", "chore", "tidy"),
    ]
    const notes = renderNotes(input)
    const hashes = lineHashes(notes)
    expect(hashes).toHaveLength(input.length)
    for (const commit of input) {
      expect(hashes.filter((hash) => hash === commit.hash)).toHaveLength(1)
    }
  })
})
