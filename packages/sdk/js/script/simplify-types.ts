import ts from "typescript"

/**
 * Removes redundant members from the union types in generated TypeScript.
 *
 * @hey-api/openapi-ts writes unions without simplifying them. An index
 * signature, for example, unions `additionalProperties` with the type of
 * every declared property, so the same member can occur more than once.
 * Each rewrite keeps the type that TypeScript already computes for the
 * union:
 * - A member whose text repeats an earlier member adds nothing.
 *
 * The rewrite works on the source text: only a union that loses a member
 * gets new text, and prettier formats the result later.
 */

const unwrap = (node: ts.TypeNode): ts.TypeNode => (ts.isParenthesizedTypeNode(node) ? unwrap(node.type) : node)

/** Collects the members of a union, including the members of nested unions. */
const flatten = (node: ts.UnionTypeNode): ReadonlyArray<ts.TypeNode> =>
  node.types.flatMap((member) => {
    const inner = unwrap(member)
    return ts.isUnionTypeNode(inner) ? flatten(inner) : [member]
  })

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * Returns the new text of `node` when a union inside it changes, or undefined
 * when nothing changes. `start` and `text` give the node's current source.
 */
const spliceChildren = (node: ts.Node, source: ts.SourceFile, start: number, text: string): string | undefined => {
  const edits: Array<Edit> = []
  ts.forEachChild(node, (child) => {
    const replacement = simplifyNode(child, source)
    if (replacement !== undefined) {
      edits.push({ start: child.getStart(source), end: child.end, text: replacement })
    }
  })
  if (edits.length === 0) {
    return undefined
  }
  return edits.reduceRight(
    (result, edit) => result.slice(0, edit.start - start) + edit.text + result.slice(edit.end - start),
    text,
  )
}

const simplifyUnion = (node: ts.UnionTypeNode, source: ts.SourceFile): string | undefined => {
  const members = flatten(node).map((member) => {
    const simplified = simplifyNode(member, source)
    return { changed: simplified !== undefined, text: simplified ?? member.getText(source) }
  })
  const seen = new Set<string>()
  const kept: Array<string> = []
  for (const member of members) {
    if (seen.has(member.text)) {
      continue
    }
    seen.add(member.text)
    kept.push(member.text)
  }
  if (kept.length === members.length && !members.some((member) => member.changed)) {
    return undefined
  }
  return kept.join(" | ")
}

function simplifyNode(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isUnionTypeNode(node)) {
    return simplifyUnion(node, source)
  }
  return spliceChildren(node, source, node.getStart(source), node.getText(source))
}

/** Returns `text` with the redundant members of each union type removed. */
export const simplifyUnionTypes = (text: string, fileName: string): string => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return spliceChildren(source, source, 0, text) ?? text
}

/** Simplifies the union types in every TypeScript file below `dir`. */
export const simplifyUnionFiles = async (dir: string): Promise<void> => {
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: dir, absolute: true })) {
    const text = await Bun.file(file).text()
    const simplified = simplifyUnionTypes(text, file)
    if (simplified !== text) {
      await Bun.write(file, simplified)
    }
  }
}
