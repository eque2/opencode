export * as ConfigMarkdown from "./markdown"

import matter from "gray-matter"
import { Result } from "effect"

// gray-matter throws on invalid YAML. Retry once with sanitized frontmatter;
// a second failure still throws to the caller, as before.
export function parse(content: string) {
  return Result.try(() => matter(content)).pipe(Result.getOrElse(() => matter(sanitize(content))))
}

export function parseOption(content: string) {
  return Result.getOrUndefined(Result.try(() => parse(content)))
}

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working.
export function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}
