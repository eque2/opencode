export type ParsedCommit = {
  valid: true
  hash: string
  type: string
  scope?: string
  subject: string
  body?: string
  breaking: boolean
  breakingNote?: string
  refs: string[]
}

export type InvalidCommit = { valid: false; hash: string; raw: string; reason: string }

const HEADER =
  /^(?<type>[A-Za-z][A-Za-z0-9-]*)(?:\((?<scope>[A-Za-z0-9][A-Za-z0-9._/-]*)\))?(?<bang>!)?: (?<subject>\S.*)$/
const FOOTER = /^(BREAKING CHANGE|BREAKING-CHANGE|[A-Za-z][A-Za-z0-9-]*)(: | #)/
const TYPE = /^[A-Za-z][A-Za-z0-9-]*/

type Footer = { token: string; separator: string; value: string }

const blank = (line: string) => line.trim() === ""

/** Explains why a header does not match `type(scope)!: subject`. */
function headerReason(header: string): string {
  const colon = header.indexOf(":")
  if (colon <= 0) return "header has no type prefix"
  const prefix = header.slice(0, colon)
  const type = TYPE.exec(prefix)
  if (!type) return "header type must start with a letter"
  const rest = prefix.slice(type[0].length)
  if (rest !== "" && rest !== "!") {
    if (rest.includes("(") || rest.includes(")")) return "header scope is malformed"
    return "header type has invalid characters"
  }
  const after = header.slice(colon + 1)
  if (after.trim() === "") return "header has an empty subject"
  if (!after.startsWith(" ")) return "header needs a space after the colon"
  return "header subject must follow a single space"
}

function parseFooters(lines: string[]): Footer[] {
  const footers: Footer[] = []
  for (const line of lines) {
    const match = FOOTER.exec(line)
    const last = footers.at(-1)
    if (match && match[1] !== undefined && match[2] !== undefined) {
      footers.push({ token: match[1], separator: match[2], value: line.slice(match[0].length).trim() })
    } else if (last) {
      const text = line.trim()
      if (text !== "") last.value = last.value === "" ? text : `${last.value} ${text}`
    }
  }
  return footers
}

export function parseCommit(hash: string, message: string): ParsedCommit | InvalidCommit {
  const invalid = (reason: string): InvalidCommit => ({ valid: false, hash, raw: message, reason })
  const text = message.replace(/\r\n/g, "\n")
  if (text.trim() === "") return invalid("empty message")

  const lines = text.split("\n")
  while (lines.length > 0 && blank(lines[lines.length - 1] ?? "")) lines.pop()

  const header = lines[0] ?? ""
  const match = HEADER.exec(header)
  const groups = match?.groups
  if (!groups || groups["type"] === undefined || groups["subject"] === undefined) return invalid(headerReason(header))
  if (lines.length > 1 && !blank(lines[1] ?? "")) return invalid("body must follow a blank line")

  // The final paragraph starts after the last blank line; it is the footer block only when it starts with a token.
  let start = lines.length
  while (start > 2 && !blank(lines[start - 1] ?? "")) start--
  const finalParagraph = lines.slice(start)
  const hasFooters = start >= 2 && start < lines.length && FOOTER.test(finalParagraph[0] ?? "")
  const footers = hasFooters ? parseFooters(finalParagraph) : []

  const bodyLines = lines.slice(2, hasFooters ? start : lines.length)
  while (bodyLines.length > 0 && blank(bodyLines[0] ?? "")) bodyLines.shift()
  while (bodyLines.length > 0 && blank(bodyLines[bodyLines.length - 1] ?? "")) bodyLines.pop()

  const subject = groups["subject"]
  const breakingFooter = footers.find(
    (footer) => (footer.token === "BREAKING CHANGE" || footer.token === "BREAKING-CHANGE") && footer.separator === ": ",
  )
  const bang = groups["bang"] === "!"
  const breaking = bang || breakingFooter !== undefined

  const refs: string[] = []
  for (const footer of footers) {
    if (footer.token.toLowerCase() !== "refs") continue
    for (const key of footer.value.split(/[\s,]+/)) {
      if (key !== "" && !refs.includes(key)) refs.push(key)
    }
  }

  const parsed: ParsedCommit = { valid: true, hash, type: groups["type"].toLowerCase(), subject, breaking, refs }
  if (groups["scope"] !== undefined) parsed.scope = groups["scope"]
  if (bodyLines.length > 0) parsed.body = bodyLines.join("\n")
  if (breaking) parsed.breakingNote = breakingFooter && breakingFooter.value !== "" ? breakingFooter.value : subject
  return parsed
}
