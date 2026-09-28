import { createStore, produce, reconcile } from "solid-js/store"
import { Data, Effect, HashSet, MutableHashMap, Option, Predicate } from "effect"
import type { FileNode } from "@opencode-ai/sdk/v2"

type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  children?: string[]
}

export class FileTreeListError extends Data.TaggedError("App.FileTreeListError")<{ readonly cause: unknown }> {}

type TreeStoreOptions = {
  scope: () => string
  normalizeDir: (input: string) => string
  list: (input: string) => Effect.Effect<readonly FileNode[], FileTreeListError>
  onError: (message: Option.Option<string>) => void
}

// The listing request can reject with an Error or with a plain error body, so
// read a string message from either one.
const causeMessage = (cause: unknown) =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? Option.some(cause.message)
    : Option.none<string>()

export function createFileTreeStore(options: TreeStoreOptions) {
  const [tree, setTree] = createStore<{
    node: Record<string, FileNode>
    dir: Record<string, DirectoryState>
  }>({
    node: {},
    dir: { "": { expanded: true } },
  })

  const inflight = MutableHashMap.empty<string, Promise<void>>()

  const reset = () => {
    MutableHashMap.clear(inflight)
    setTree("node", reconcile({}))
    setTree("dir", reconcile({}))
    setTree("dir", "", { expanded: true })
  }

  const ensureDir = (path: string) => {
    if (tree.dir[path]) return
    setTree("dir", path, { expanded: false })
  }

  // Records a running listing until it settles. A listing that settles before
  // runPromise returns is not recorded, so no settled promise stays cached.
  const track = (dir: string, program: Effect.Effect<void>) => {
    let settled = false
    const promise = Effect.runPromise(
      program.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            settled = true
            MutableHashMap.remove(inflight, dir)
          }),
        ),
      ),
    )
    if (!settled) MutableHashMap.set(inflight, dir, promise)
    return promise
  }

  const listDir = (input: string, opts?: { force?: boolean }): Promise<void> => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)

    const current = tree.dir[dir]
    if (!opts?.force && current?.loaded) return Effect.runPromise(Effect.void)

    const pending = MutableHashMap.get(inflight, dir)
    if (Option.isSome(pending)) return pending.value

    setTree(
      "dir",
      dir,
      produce((draft) => {
        draft.loading = true
        delete draft.error
      }),
    )

    const directory = options.scope()

    const listing = options.list(dir).pipe(
      Effect.map((nodes) => {
        if (options.scope() !== directory) return
        const prevChildren = tree.dir[dir]?.children ?? []
        const nextChildren = nodes.map((node) => node.path)
        const nextSet = HashSet.fromIterable(nextChildren)

        setTree(
          "node",
          produce((draft) => {
            const removedChildren = prevChildren.filter((child) => !HashSet.has(nextSet, child))
            const removedDirs = removedChildren.filter((child) => draft[child]?.type === "directory")

            for (const child of removedChildren) {
              delete draft[child]
            }

            if (removedDirs.length > 0) {
              const keys = Object.keys(draft)
              for (const key of keys) {
                for (const removed of removedDirs) {
                  if (!key.startsWith(removed + "/")) continue
                  delete draft[key]
                  break
                }
              }
            }

            for (const node of nodes) {
              draft[node.path] = node
            }
          }),
        )

        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loaded = true
            draft.loading = false
            draft.children = nextChildren
          }),
        )
      }),
      Effect.catch((error) =>
        Effect.sync(() => {
          if (options.scope() !== directory) return
          const message = causeMessage(error.cause)
          setTree(
            "dir",
            dir,
            produce((draft) => {
              draft.loading = false
              if (Option.isSome(message)) draft.error = message.value
              else delete draft.error
            }),
          )
          options.onError(message)
        }),
      ),
    )

    return track(dir, listing)
  }

  // `list: false` marks a directory expanded without fetching its children, for
  // trees whose nodes are synthesized from a filter; listing directories that
  // only exist on a diff's base branch fails and surfaces error toasts.
  const expandDir = (input: string, behavior?: { list?: boolean }) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", true)
    if (behavior?.list === false) return
    void listDir(dir)
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", false)
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    const ids = tree.dir[dir]?.children
    if (!ids) return []
    const out: FileNode[] = []
    for (const id of ids) {
      const node = tree.node[id]
      if (node) out.push(node)
    }
    return out
  }

  return {
    listDir,
    expandDir,
    collapseDir,
    dirState,
    children,
    node: (path: string) => Option.fromNullishOr(tree.node[path]),
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded),
    reset,
  }
}
