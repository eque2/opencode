import type { InvalidCommit, ParsedCommit } from "./commit"

const HEADINGS = ["Breaking changes", "Features", "Fixes", "Performance", "Other", "Unparsed commits"] as const

type Heading = (typeof HEADINGS)[number]

/** Escapes the characters that would let commit text start a link, HTML, emphasis, code or a table cell. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_`[\]<>|]/g, "\\$&")
}

function headingOf(commit: ParsedCommit): Heading {
  if (commit.breaking) return "Breaking changes"
  if (commit.type === "feat") return "Features"
  if (commit.type === "fix") return "Fixes"
  if (commit.type === "perf") return "Performance"
  return "Other"
}

function parsedLine(commit: ParsedCommit, linkify: ((key: string) => string) | undefined): string {
  const scope = commit.scope === undefined ? "" : `**${escapeMarkdown(commit.scope)}:** `
  const note =
    commit.breaking && commit.breakingNote !== undefined && commit.breakingNote !== commit.subject
      ? ` — ${escapeMarkdown(commit.breakingNote)}`
      : ""
  const keys = commit.refs.map((key) => (linkify ? linkify(key) : escapeMarkdown(key)))
  const refs = keys.length > 0 ? ` — refs ${keys.join(", ")}` : ""
  return `- ${scope}${escapeMarkdown(commit.subject)}${note} (${commit.hash})${refs}`
}

function invalidLine(commit: InvalidCommit): string {
  const first = commit.raw
    .split("\n")
    .map((line) => line.replace(/\r/g, ""))
    .find((line) => line.trim() !== "")
  return `- ${first === undefined ? "(empty message)" : escapeMarkdown(first)} (${commit.hash})`
}

export function renderNotes(
  commits: (ParsedCommit | InvalidCommit)[],
  options?: { linkify?: (key: string) => string },
): string {
  const groups = new Map<Heading, string[]>(HEADINGS.map((heading) => [heading, []]))
  for (const commit of commits) {
    const heading = commit.valid ? headingOf(commit) : "Unparsed commits"
    const line = commit.valid ? parsedLine(commit, options?.linkify) : invalidLine(commit)
    groups.get(heading)?.push(line)
  }
  const sections = HEADINGS.flatMap((heading) => {
    const lines = groups.get(heading) ?? []
    return lines.length === 0 ? [] : [`## ${heading}\n\n${lines.join("\n")}`]
  })
  if (sections.length === 0) return "# Release notes\n\nNo changes.\n"
  return `# Release notes\n\n${sections.join("\n\n")}\n`
}
