import { beforeAll, describe, expect, mock, test } from "bun:test"
import { HashSet, MutableHashSet, Option } from "effect"

let shouldListRoot: typeof import("./file-tree").shouldListRoot
let shouldListExpanded: typeof import("./file-tree").shouldListExpanded
let dirsToExpand: typeof import("./file-tree").dirsToExpand

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => {},
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => {}],
  }))
  mock.module("@/context/file", () => ({
    useFile: () => ({
      tree: {
        state: () => {},
        list: () => Promise.resolve(),
        children: () => [],
        expand: () => {},
        collapse: () => {},
      },
    }),
  }))
  mock.module("@opencode-ai/ui/collapsible", () => ({
    Collapsible: {
      Trigger: (props: { children?: unknown }) => props.children,
      Content: (props: { children?: unknown }) => props.children,
    },
  }))
  mock.module("@opencode-ai/ui/file-icon", () => ({ FileIcon: () => [] }))
  mock.module("@opencode-ai/ui/icon", () => ({ Icon: () => [] }))
  mock.module("@opencode-ai/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
  const mod = await import("./file-tree")
  shouldListRoot = mod.shouldListRoot
  shouldListExpanded = mod.shouldListExpanded
  dirsToExpand = mod.dirsToExpand
})

describe("file tree fetch discipline", () => {
  test("root lists on mount unless already loaded or loading", () => {
    expect(shouldListRoot({ level: 0 })).toBe(true)
    expect(shouldListRoot({ level: 0, dir: { loaded: true } })).toBe(false)
    expect(shouldListRoot({ level: 0, dir: { loading: true } })).toBe(false)
    expect(shouldListRoot({ level: 1 })).toBe(false)
  })

  test("nested dirs list only when expanded and stale", () => {
    expect(shouldListExpanded({ level: 1 })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: false } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true } })).toBe(true)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loaded: true } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loading: true } })).toBe(false)
    expect(shouldListExpanded({ level: 0, dir: { expanded: true } })).toBe(false)
  })

  test("allowed auto-expand picks only collapsed dirs", () => {
    const expanded = MutableHashSet.empty<string>()
    const filter = Option.some({ dirs: HashSet.make("src", "src/components") })

    const first = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => MutableHashSet.has(expanded, dir),
    })

    expect(first).toEqual(["src", "src/components"])

    for (const dir of first) MutableHashSet.add(expanded, dir)

    const second = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => MutableHashSet.has(expanded, dir),
    })

    expect(second).toEqual([])
    expect(dirsToExpand({ level: 1, filter, expanded: () => false })).toEqual([])
  })
})
