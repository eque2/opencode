import { getFilename } from "@opencode-ai/core/util/path"
import { MutableHashMap, MutableHashSet, Option } from "effect"
import fuzzysort from "fuzzysort"

export function treeEntries(parent: string, nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>) {
  const prefix = parent.replace(/^\/+|\/+$/g, "")
  return nodes.map((node) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name
    return node.type === "directory" ? path + "/" : path
  })
}

export function pickerTreeEntries(
  parent: string,
  nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>,
  mode: "directory" | "file",
) {
  return treeEntries(parent, mode === "directory" ? nodes.filter((node) => node.type === "directory") : nodes)
}

export function pickerSearchEntries<T extends { type: "file" | "directory" }>(
  nodes: readonly T[],
  mode: "directory" | "file",
) {
  return mode === "directory" ? nodes.filter((node) => node.type === "directory") : [...nodes]
}

export function pickerMode(mode: "directory" | "file", base?: string) {
  if (mode === "file") {
    return {
      includeFiles: true,
      action: "file" as const,
      entries(parent: string, nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>) {
        return treeEntries(parent, nodes)
      },
      navigation(path: string) {
        return treePathWithin(base, path) ? pickerPathOption(path) : Option.none<string>()
      },
      result(root: string, selected: string) {
        return pickerPathOption(selected)
      },
      selection(root: string, path: string) {
        if (!treePathWithin(base, root)) return Option.none<string>()
        return selectedTreePath(root, path, "file", base)
      },
    }
  }
  return {
    includeFiles: false,
    action: "directory" as const,
    entries(parent: string, nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>) {
      return treeEntries(
        parent,
        nodes.filter((node) => node.type === "directory"),
      )
    },
    navigation(path: string) {
      return pickerPathOption(path)
    },
    result(root: string, selected: string, valid = true) {
      if (!valid) return Option.none<string>()
      return pickerPathOption(selected || (root ? nativePickerPath(root) : ""))
    },
    selection(root: string, path: string) {
      return selectedTreePath(root, path, "directory")
    },
  }
}

export function pickerFileSearchQuery(root: string, input: string, home: string) {
  const value = input
    .replace(/\\/g, "/")
    .replace(/^~(?=\/|$)/, home)
    .replace(/\/+$/, "")
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "")
  if (value === base) return ""
  if (value.startsWith(base + "/")) return value.slice(base.length + 1)
  return value
}

export function pickerAbsoluteInput(input: string, home: string, current: string) {
  const value = normalizePickerDrive(input).replace(/^~(?=\/|$)/, normalizePickerDrive(home))
  const absolute = pickerRoot(value) ? value : joinPickerPath(current, value)
  return canonicalPickerPath(absolute)
}

/** Reads a picker path that may be blank. An empty text is no path. */
export function pickerPathOption(value: string | undefined): Option.Option<string> {
  return value ? Option.some(value) : Option.none()
}

export function treePathWithin(base: string | undefined, path: string) {
  return Option.isSome(pickerRelativePath(base, path))
}

export function canonicalPickerPath(path: string) {
  const value = normalizePickerDrive(path)
  const root = pickerRoot(value)
  const parts = value.slice(root.length).split("/")
  const resolved = parts.reduce<string[]>((output, part) => {
    if (!part || part === ".") return output
    if (part === "..") {
      output.pop()
      return output
    }
    output.push(part)
    return output
  }, [])
  return joinPickerPath(root, resolved.join("/"))
}

export function pickerRelativePath(base: string | undefined, path: string): Option.Option<string> {
  if (!base) return Option.none()
  const rootPath = canonicalPickerPath(base)
  const targetPath = canonicalPickerPath(path)
  const insensitive = /^[A-Za-z]:\//.test(rootPath) || rootPath.startsWith("//")
  const root = insensitive ? rootPath.toLowerCase() : rootPath
  const target = insensitive ? targetPath.toLowerCase() : targetPath
  if (target === root) return Option.some("")
  const prefix = root.endsWith("/") ? root : root + "/"
  if (!target.startsWith(prefix)) return Option.none()
  return Option.some(targetPath.slice(prefix.length))
}

export function currentPickerSuggestions<T>(result: { query: string; items: readonly T[] } | undefined, query: string) {
  if (result?.query !== query) return []
  return result.items
}

export function preloadTreeDirectories(
  parent: string,
  nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>,
) {
  return treeEntries(
    parent,
    nodes.filter((node) => node.type === "directory"),
  )
}

export function advanceTreePreload(advanced: MutableHashSet.MutableHashSet<string>, path: string) {
  if (MutableHashSet.has(advanced, path)) return false
  MutableHashSet.add(advanced, path)
  return true
}

export function activeTreeNavigation(request: number, current: number) {
  return request === current
}

export function createPriorityTaskQueue<T>(concurrency: number) {
  type Job = {
    key: string
    priority: "user" | "background"
    promise: Promise<T>
    run: () => void
  }

  const jobs = MutableHashMap.empty<string, Job>()
  const user: Job[] = []
  const background: Job[] = []
  let active = 0

  const drain = () => {
    while (active < concurrency) {
      const job = user.pop() ?? background.shift()
      if (!job) return
      active++
      job.run()
    }
  }

  const schedule = (key: string, priority: Job["priority"], task: () => Promise<T>) => {
    const existing = MutableHashMap.get(jobs, key)
    if (Option.isSome(existing)) {
      if (priority === "user") promote(key)
      return existing.value.promise
    }

    const deferred = Promise.withResolvers<T>()
    const job: Job = {
      key,
      priority,
      promise: deferred.promise,
      run: () => {
        const complete = () => {
          active--
          MutableHashMap.remove(jobs, key)
          drain()
        }
        Promise.resolve()
          .then(task)
          .then(
            (value) => {
              complete()
              deferred.resolve(value)
            },
            (error) => {
              complete()
              deferred.reject(error)
            },
          )
      },
    }
    MutableHashMap.set(jobs, key, job)
    ;(priority === "user" ? user : background).push(job)
    drain()
    return job.promise
  }

  const promote = (key: string) => {
    const found = MutableHashMap.get(jobs, key)
    if (Option.isNone(found) || found.value.priority === "user") return
    const job = found.value
    const index = background.indexOf(job)
    if (index === -1) return
    background.splice(index, 1)
    job.priority = "user"
    user.push(job)
  }

  return { schedule, promote }
}

export function nextTreeScrollTop(current: number, delta: number, scrollHeight: number, clientHeight: number) {
  return Math.min(Math.max(0, scrollHeight - clientHeight), Math.max(0, current + delta))
}

export function nextSuggestionIndex(current: number, delta: -1 | 1, count: number) {
  if (count === 0) return -1
  return (current + delta + count) % count
}

export function absoluteTreePath(root: string, path: string) {
  const base = trimPickerPath(root)
  const relative = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  if (!relative) return base || "/"
  if (!base || base === "/") return "/" + relative
  if (base.endsWith("/")) return base + relative
  return `${base}/${relative}`
}

export function selectedTreePath(
  root: string,
  path: string,
  mode: "directory" | "file",
  base?: string,
): Option.Option<string> {
  const directory = path.endsWith("/")
  if (mode === "file") {
    if (directory) return Option.none()
    if (!base) return Option.some(path)
    const absolute = absoluteTreePath(root, path)
    return pickerRelativePath(base, absolute)
  }
  return directory ? Option.some(nativePickerPath(absoluteTreePath(root, path))) : Option.none()
}

/** Drops repeated paths and keeps the first position of each, as `new Set` did. */
function uniquePaths(paths: Iterable<string>) {
  return Array.from(MutableHashSet.fromIterable(paths))
}

export function nativePickerPath(path: string) {
  const value = trimPickerPath(path)
  if (/^[A-Za-z]:\//.test(value) || value.startsWith("//")) return value.replaceAll("/", "\\")
  return value
}

export function cleanPickerInput(value: string) {
  const first = (value ?? "").split(/\r?\n/)[0] ?? ""
  return first.replace(/[\u0000-\u001F\u007F]/g, "").trim()
}

export function normalizePickerPath(input: string) {
  const value = input.replaceAll("\\", "/")
  if (value.startsWith("//") && !value.startsWith("///")) return "//" + value.slice(2).replace(/\/+/g, "/")
  return value.replace(/\/+/g, "/")
}

export function normalizePickerDrive(input: string) {
  const value = normalizePickerPath(input)
  if (/^[A-Za-z]:$/.test(value)) return value + "/"
  return value
}

export function trimPickerPath(input: string) {
  const value = normalizePickerDrive(input)
  if (value === "/" || value === "//" || /^[A-Za-z]:\/$/.test(value)) return value
  return value.replace(/\/+$/, "")
}

export function joinPickerPath(base: string | undefined, relative: string) {
  const root = trimPickerPath(base ?? "")
  const path = trimPickerPath(relative).replace(/^\/+/, "")
  if (!root) return path
  if (!path) return root
  if (root.endsWith("/")) return root + path
  return root + "/" + path
}

export function pickerRoot(input: string) {
  const value = normalizePickerDrive(input)
  if (value.startsWith("//")) {
    const [server, share] = value.slice(2).split("/")
    if (server && share) return `//${server}/${share}`
    return "//"
  }
  if (value.startsWith("/")) return "/"
  if (/^[A-Za-z]:\//.test(value)) return value.slice(0, 3)
  return ""
}

export function pickerParent(input: string) {
  const value = trimPickerPath(input)
  const root = pickerRoot(value)
  if (value === root) return value
  if (value === "/" || value === "//" || /^[A-Za-z]:\/$/.test(value)) return value
  const index = value.lastIndexOf("/")
  if (index < root.length) return root
  if (index <= 0) return "/"
  if (index === 2 && /^[A-Za-z]:/.test(value)) return value.slice(0, 3)
  return value.slice(0, index)
}

function pickerTilde(absolute: string, home: string) {
  const path = trimPickerPath(absolute)
  if (!home) return ""
  const root = trimPickerPath(home)
  if (/^[A-Za-z]:\//.test(root)) return ""
  if (path === root) return "~"
  if (path.startsWith(root + "/")) return "~" + path.slice(root.length)
  return ""
}

export function displayPickerPath(path: string, input: string, home: string) {
  const value = trimPickerPath(path)
  if (/^[A-Za-z]:\//.test(trimPickerPath(home)) || /^[A-Za-z]:\//.test(value)) return value.replaceAll("/", "\\")
  return pickerTilde(value, home) || value
}

/** The file calls the directory search makes. ServerSDK satisfies it, and so does a test stand-in. */
export type DirectorySearchClient = {
  readonly api: {
    readonly file: {
      readonly list: (input: { location: { directory: string } }) => Promise<{
        readonly data: ReadonlyArray<{ readonly path: string; readonly type: "file" | "directory" }>
      }>
      readonly find: (input: {
        location: { directory: string }
        query: string
        type: "directory"
        limit: number
      }) => Promise<{ readonly data: ReadonlyArray<{ readonly path: string }> }>
    }
  }
}

export function createDirectorySearch(args: {
  sdk: DirectorySearchClient
  base: () => Option.Option<string>
  home: () => string
}) {
  const cache = MutableHashMap.empty<string, Promise<Array<{ name: string; absolute: string }>>>()
  let current = 0

  const scoped = (value: string): Option.Option<{ directory: string; path: string }> => {
    const raw = normalizePickerDrive(value)
    const root = pickerRoot(raw)
    if (root) return Option.some({ directory: trimPickerPath(root), path: raw.slice(root.length) })
    const found = Option.filter(args.base(), (base) => base !== "")
    if (Option.isNone(found)) return Option.none()
    const base = found.value
    if (!raw) return Option.some({ directory: trimPickerPath(base), path: "" })
    const home = args.home()
    if (raw === "~") return Option.some({ directory: trimPickerPath(home || base), path: "" })
    if (raw.startsWith("~/")) return Option.some({ directory: trimPickerPath(home || base), path: raw.slice(2) })
    return Option.some({ directory: trimPickerPath(base), path: raw })
  }

  const directories = async (directory: string) => {
    const key = trimPickerPath(directory)
    const existing = MutableHashMap.get(cache, key)
    if (Option.isSome(existing)) return existing.value
    const request = args.sdk.api.file
      .list({ location: { directory: key } })
      .then((result) => result.data)
      .catch(() => [])
      .then((nodes) =>
        nodes
          .filter((node) => node.type === "directory")
          .map((node) => {
            const relative = trimPickerPath(normalizePickerDrive(node.path))
            return { name: getFilename(relative), absolute: joinPickerPath(key, relative) }
          }),
      )
    MutableHashMap.set(cache, key, request)
    return request
  }

  const match = async (directory: string, query: string, limit: number) => {
    const items = await directories(directory)
    if (!query) return items.slice(0, limit).map((item) => item.absolute)
    return fuzzysort.go(query, items, { key: "name", limit }).map((item) => item.obj.absolute)
  }

  return async (filter: string) => {
    const token = ++current
    const active = () => token === current
    const value = cleanPickerInput(filter)
    const scope = scoped(value)
    if (Option.isNone(scope)) return [] as string[]
    const input = scope.value
    const raw = normalizePickerDrive(value)
    const pathInput = raw.startsWith("~") || !!pickerRoot(raw) || raw.includes("/")
    const query = normalizePickerDrive(input.path)
    if (!pathInput) {
      const results = await args.sdk.api.file
        .find({ location: { directory: input.directory }, query, type: "directory", limit: 50 })
        .then((result) => result.data.map((entry) => entry.path))
        .catch(() => [])
      if (!active()) return []
      if (results.length) {
        return results.map((path) => joinPickerPath(input.directory, path)).slice(0, 50)
      }
      const fallback = query
        ? await match(input.directory, query, 50)
        : (await directories(input.directory)).map((item) => item.absolute)
      if (!active()) return []
      return fallback
    }
    const segments = query.replace(/^\/+/, "").split("/")
    const head = segments.slice(0, -1).filter((part) => part && part !== ".")
    const tail = segments.at(-1) ?? ""
    let paths = [input.directory]
    for (const part of head) {
      if (!active()) return []
      if (part === "..") {
        paths = paths.map(pickerParent)
        continue
      }
      paths = uniquePaths((await Promise.all(paths.map((path) => match(path, part, 4)))).flat()).slice(0, 12)
      if (!active() || paths.length === 0) return []
    }
    const matches = uniquePaths((await Promise.all(paths.map((path) => match(path, tail, 50)))).flat())
    if (!active()) return []
    const base = raw.startsWith("~") ? trimPickerPath(input.directory) : ""
    if (raw.endsWith("/") || !tail) return uniquePaths([base, ...matches].filter(Boolean)).slice(0, 50)
    const target = matches.find((path) => getFilename(path).toLowerCase() === tail.toLowerCase())
    if (!target) return matches.slice(0, 50)
    const children = await match(target, "", 30)
    if (!active()) return []
    return uniquePaths([base, ...matches, ...children].filter(Boolean)).slice(0, 50)
  }
}
