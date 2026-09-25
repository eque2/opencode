import { useFile } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import {
  createEffect,
  createMemo,
  For,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  untrack,
  type ComponentProps,
  type ParentProps,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { Array as Arr, HashMap, HashSet, MutableHashSet, Option, Order } from "effect"
import type { FileNode } from "@opencode-ai/sdk/v2"

const MAX_DEPTH = 128

export function pathToFileUrl(filepath: string): string {
  return `file://${encodeFilePath(filepath)}`
}

export type Kind = "add" | "del" | "mix"

export type Filter = {
  files: HashSet.HashSet<string>
  dirs: HashSet.HashSet<string>
}

export function shouldListRoot(input: { level: number; dir?: { loaded?: boolean; loading?: boolean } }) {
  if (input.level !== 0) return false
  if (input.dir?.loaded) return false
  if (input.dir?.loading) return false
  return true
}

export function shouldListExpanded(input: {
  level: number
  dir?: { expanded?: boolean; loaded?: boolean; loading?: boolean }
}) {
  if (input.level === 0) return false
  if (!input.dir?.expanded) return false
  if (input.dir.loaded) return false
  if (input.dir.loading) return false
  return true
}

export function dirsToExpand(input: {
  level: number
  filter: Option.Option<{ dirs: HashSet.HashSet<string> }>
  expanded: (dir: string) => boolean
}) {
  if (input.level !== 0) return []
  if (Option.isNone(input.filter)) return []
  // HashSet has no insertion order; sorting keeps every parent ahead of its children.
  return Arr.sort(
    Arr.filter(Array.from(input.filter.value.dirs), (dir) => !input.expanded(dir)),
    Order.String,
  )
}

const kindLabel = (kind: Kind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

const kindTextColor = (kind: Kind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

const kindDotColor = (kind: Kind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-diff-modified-base)"
}

export const visibleKind = (
  node: FileNode,
  kinds?: HashMap.HashMap<string, Kind>,
  marks?: HashSet.HashSet<string>,
): Option.Option<Kind> => {
  if (!kinds || !marks || !HashSet.has(marks, node.path)) return Option.none()
  return HashMap.get(kinds, node.path)
}

const buildDragImage = (target: HTMLElement): Option.Option<HTMLDivElement> => {
  const icon = target.querySelector('[data-component="file-icon"]') ?? target.querySelector("svg")
  const text = target.querySelector("span")
  if (!icon || !text) return Option.none()

  const image = document.createElement("div")
  image.className =
    "flex items-center gap-x-2 px-2 py-1 bg-surface-raised-base rounded-md border border-border-base text-12-regular text-text-strong"
  image.style.position = "absolute"
  image.style.top = "-1000px"
  image.innerHTML = (icon as SVGElement).outerHTML + (text as HTMLSpanElement).outerHTML
  return Option.some(image)
}

export const withFileDragImage = (event: DragEvent) => {
  const built = buildDragImage(event.currentTarget as HTMLElement)
  if (Option.isNone(built)) return
  const image = built.value
  document.body.appendChild(image)
  event.dataTransfer?.setDragImage(image, 0, 12)
  setTimeout(() => document.body.removeChild(image), 0)
}

const FileTreeNode = (
  p: ParentProps &
    ComponentProps<"div"> &
    ComponentProps<"button"> & {
      node: FileNode
      level: number
      active?: string
      nodeClass?: string
      draggable: boolean
      kinds?: HashMap.HashMap<string, Kind>
      marks?: HashSet.HashSet<string>
      as?: "div" | "button"
    },
) => {
  const [local, rest] = splitProps(p, [
    "node",
    "level",
    "active",
    "nodeClass",
    "draggable",
    "kinds",
    "marks",
    "as",
    "children",
    "class",
    "classList",
  ])
  const kind = () => visibleKind(local.node, local.kinds, local.marks)
  const active = () => Option.isSome(kind()) && !local.node.ignored
  const color = () => (active() ? Option.map(kind(), kindTextColor) : Option.none<string>())

  return (
    <Dynamic
      component={local.as ?? "div"}
      classList={{
        "w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-start hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer": true,
        "bg-surface-base-active": local.node.path === local.active,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
        [local.nodeClass ?? ""]: !!local.nodeClass,
      }}
      style={`padding-inline-start: ${Math.max(0, 8 + local.level * 12 - (local.node.type === "file" ? 24 : 4))}px`}
      draggable={local.draggable}
      onDragStart={(event: DragEvent) => {
        if (!local.draggable) return
        event.dataTransfer?.setData("text/plain", `file:${local.node.path}`)
        event.dataTransfer?.setData("text/uri-list", pathToFileUrl(local.node.path))
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
        withFileDragImage(event)
      }}
      {...rest}
    >
      {local.children}
      <span
        classList={{
          "flex-1 min-w-0 text-12-medium whitespace-nowrap truncate": true,
          "text-text-weaker": local.node.ignored,
          "text-text-weak": !local.node.ignored && !active(),
        }}
        style={Option.getOrUndefined(color())}
      >
        {local.node.name}
      </span>
      <Show when={Option.getOrUndefined(kind())}>
        {(value) =>
          local.node.type === "file" ? (
            <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(value())}>
              {kindLabel(value())}
            </span>
          ) : (
            <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(value())} />
          )
        }
      </Show>
    </Dynamic>
  )
}

export default function FileTree(props: {
  path: string
  class?: string
  nodeClass?: string
  active?: string
  level?: number
  allowed?: readonly string[]
  modified?: readonly string[]
  kinds?: HashMap.HashMap<string, Kind>
  draggable?: boolean
  onFileClick?: (file: FileNode) => void
  onFileDoubleClick?: (file: FileNode) => void

  _filter?: Option.Option<Filter>
  _marks?: HashSet.HashSet<string>
  _deeps?: HashMap.HashMap<string, number>
  _kinds?: HashMap.HashMap<string, Kind>
  _chain?: readonly string[]
}) {
  const file = useFile()
  const level = props.level ?? 0
  const draggable = () => props.draggable ?? true

  const key = (p: string) =>
    file
      .normalize(p)
      .replace(/[\\/]+$/, "")
      .replaceAll("\\", "/")
  const chain = props._chain ? [...props._chain, key(props.path)] : [key(props.path)]

  const filter = createMemo((): Option.Option<Filter> => {
    if (props._filter) return props._filter

    const allowed = props.allowed
    if (!allowed) return Option.none()

    const files = HashSet.fromIterable(allowed)
    const dirs = HashSet.fromIterable(
      allowed.flatMap((item) => {
        const parents = item.split("/").slice(0, -1)
        return parents.map((_, idx) => parents.slice(0, idx + 1).join("/")).filter((dir) => dir.length > 0)
      }),
    )

    return Option.some({ files, dirs })
  })

  const marks = createMemo(() => {
    if (props._marks) return props._marks

    return HashSet.union(
      HashSet.fromIterable(props.modified ?? []),
      props.kinds ? HashSet.fromIterable(HashMap.keys(props.kinds)) : HashSet.empty<string>(),
    )
  })

  const kinds = createMemo(() => {
    if (props._kinds) return props._kinds
    return props.kinds
  })

  const deeps = createMemo(() => {
    if (props._deeps) return props._deeps

    const root = props.path
    if (!(file.tree.state(root)?.expanded ?? false)) return HashMap.empty<string, number>()

    return HashMap.mutate(HashMap.empty<string, number>(), (out) => {
      const seen = MutableHashSet.empty<string>()
      const stack: { dir: string; lvl: number; i: number; kids: string[]; max: number }[] = []

      const push = (dir: string, lvl: number) => {
        const id = key(dir)
        if (MutableHashSet.has(seen, id)) return
        MutableHashSet.add(seen, id)

        const kids = file.tree
          .children(dir)
          .filter((node) => node.type === "directory" && (file.tree.state(node.path)?.expanded ?? false))
          .map((node) => node.path)

        stack.push({ dir, lvl, i: 0, kids, max: lvl })
      }

      push(root, level - 1)

      while (stack.length > 0) {
        const top = stack[stack.length - 1]!

        if (top.i < top.kids.length) {
          const next = top.kids[top.i]!
          top.i++
          push(next, top.lvl + 1)
          continue
        }

        HashMap.set(out, top.dir, top.max)
        stack.pop()

        const parent = stack[stack.length - 1]
        if (!parent) continue
        parent.max = Math.max(parent.max, top.max)
      }
    })
  })

  createEffect(() => {
    const current = filter()
    const dirs = dirsToExpand({
      level,
      filter: current,
      expanded: (dir) => untrack(() => file.tree.state(dir)?.expanded) ?? false,
    })
    for (const dir of dirs) file.tree.expand(dir)
  })

  createEffect(
    on(
      () => props.path,
      (path) => {
        const dir = untrack(() => file.tree.state(path))
        if (!shouldListRoot({ level, dir })) return
        void file.tree.list(path)
      },
      { defer: false },
    ),
  )

  const nodes = createMemo(() => {
    const nodes = file.tree.children(props.path)
    const filtered = filter()
    if (Option.isNone(filtered)) return nodes
    const current = filtered.value

    const parent = (path: string) => {
      const idx = path.lastIndexOf("/")
      if (idx === -1) return ""
      return path.slice(0, idx)
    }

    const leaf = (path: string) => {
      const idx = path.lastIndexOf("/")
      return idx === -1 ? path : path.slice(idx + 1)
    }

    const out = nodes.filter((node) => {
      if (node.type === "file") return HashSet.has(current.files, node.path)
      return HashSet.has(current.dirs, node.path)
    })

    const seen = MutableHashSet.fromIterable(out.map((node) => node.path))

    for (const dir of current.dirs) {
      if (parent(dir) !== props.path) continue
      if (MutableHashSet.has(seen, dir)) continue
      out.push({
        name: leaf(dir),
        path: dir,
        absolute: dir,
        type: "directory",
        ignored: false,
      })
      MutableHashSet.add(seen, dir)
    }

    for (const item of current.files) {
      if (parent(item) !== props.path) continue
      if (MutableHashSet.has(seen, item)) continue
      out.push({
        name: leaf(item),
        path: item,
        absolute: item,
        type: "file",
        ignored: false,
      })
      MutableHashSet.add(seen, item)
    }

    out.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    return out
  })

  return (
    <div data-component="filetree" class={`flex flex-col gap-0.5 ${props.class ?? ""}`}>
      <For each={nodes()}>
        {(node) => {
          const expanded = () => file.tree.state(node.path)?.expanded ?? false
          const deep = () => Option.getOrElse(HashMap.get(deeps(), node.path), () => -1)
          const kind = () => visibleKind(node, kinds(), marks())
          const active = () => Option.isSome(kind()) && !node.ignored

          return (
            <Switch>
              <Match when={node.type === "directory"}>
                <Collapsible
                  variant="ghost"
                  class="w-full"
                  data-scope="filetree"
                  forceMount={false}
                  open={expanded()}
                  onOpenChange={(open) => (open ? file.tree.expand(node.path) : file.tree.collapse(node.path))}
                >
                  <Collapsible.Trigger>
                    <FileTreeNode
                      node={node}
                      level={level}
                      active={props.active}
                      nodeClass={props.nodeClass}
                      draggable={draggable()}
                      kinds={kinds()}
                      marks={marks()}
                    >
                      <div class="size-4 flex items-center justify-center text-icon-weak">
                        <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                      </div>
                    </FileTreeNode>
                  </Collapsible.Trigger>
                  <Collapsible.Content class="relative pt-0.5">
                    <div
                      classList={{
                        "absolute top-0 bottom-0 w-px pointer-events-none bg-border-weak-base opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none": true,
                        "group-hover/filetree:opacity-100": expanded() && deep() === level,
                        "group-hover/filetree:opacity-50": !(expanded() && deep() === level),
                      }}
                      style={`left: ${Math.max(0, 8 + level * 12 - 4) + 8}px`}
                    />
                    <Show
                      when={level < MAX_DEPTH && !chain.includes(key(node.path))}
                      fallback={<div class="px-2 py-1 text-12-regular text-text-weak">...</div>}
                    >
                      <FileTree
                        path={node.path}
                        level={level + 1}
                        allowed={props.allowed}
                        modified={props.modified}
                        kinds={props.kinds}
                        active={props.active}
                        draggable={props.draggable}
                        onFileClick={props.onFileClick}
                        onFileDoubleClick={props.onFileDoubleClick}
                        _filter={filter()}
                        _marks={marks()}
                        _deeps={deeps()}
                        _kinds={kinds()}
                        _chain={chain}
                      />
                    </Show>
                  </Collapsible.Content>
                </Collapsible>
              </Match>
              <Match when={node.type === "file"}>
                <FileTreeNode
                  node={node}
                  level={level}
                  active={props.active}
                  nodeClass={props.nodeClass}
                  draggable={draggable()}
                  kinds={kinds()}
                  marks={marks()}
                  as="button"
                  type="button"
                  onClick={() => props.onFileClick?.(node)}
                  onDblClick={() => props.onFileDoubleClick?.(node)}
                >
                  <div class="w-4 shrink-0" />
                  <Switch>
                    <Match when={node.ignored}>
                      <FileIcon
                        node={node}
                        class="size-4 filetree-icon filetree-icon--mono"
                        style="color: var(--icon-weak-base)"
                        mono
                      />
                    </Match>
                    <Match when={active() && Option.getOrUndefined(kind())}>
                      {(value) => (
                        <FileIcon
                          node={node}
                          class="size-4 filetree-icon filetree-icon--mono"
                          style={kindTextColor(value())}
                          mono
                        />
                      )}
                    </Match>
                    <Match when={!node.ignored}>
                      <span class="filetree-iconpair size-4">
                        <FileIcon
                          node={node}
                          class="size-4 filetree-icon filetree-icon--color opacity-0 group-hover/filetree:opacity-100"
                        />
                        <FileIcon
                          node={node}
                          class="size-4 filetree-icon filetree-icon--mono group-hover/filetree:opacity-0"
                          mono
                        />
                      </span>
                    </Match>
                  </Switch>
                </FileTreeNode>
              </Match>
            </Switch>
          )
        }}
      </For>
    </div>
  )
}
