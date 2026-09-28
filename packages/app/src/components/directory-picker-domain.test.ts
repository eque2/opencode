import { expect, test } from "bun:test"
import { Chunk, Data, Deferred, Effect, Exit, MutableHashSet, Option } from "effect"
import {
  absoluteTreePath,
  activeTreeNavigation,
  advanceTreePreload,
  nextSuggestionIndex,
  nextTreeScrollTop,
  pickerTreeEntries,
  pickerSearchEntries,
  pickerFileSearchQuery,
  pickerMode,
  preloadTreeDirectories,
  selectedTreePath,
  treeEntries,
  treePathWithin,
  currentPickerSuggestions,
  createDirectorySearch,
  createPriorityTaskQueue,
  displayPickerPath,
  pickerParent,
  pickerRoot,
  pickerAbsoluteInput,
  type DirectorySearchClient,
} from "./directory-picker-domain"

// A failure the test injects into a stand-in call.
class TestFailure extends Data.TaggedError("Test.Failure")<{ readonly message: string }> {}

// The client returns Promises, so a stand-in settles plain values through Effect.runPromise.
const settled = <A>(value: A) => Effect.runPromise(Effect.succeed(value))

test("maps server directory entries into Pierre paths", () => {
  expect(
    treeEntries("src/", [
      { name: "components", type: "directory" },
      { name: "index.ts", type: "file" },
    ]),
  ).toEqual(["src/components/", "src/index.ts"])
})

test("maps Pierre paths back to the selected server root", () => {
  expect(absoluteTreePath("C:/Users/luke", "src/components/")).toBe("C:/Users/luke/src/components")
  expect(absoluteTreePath("C:/", "")).toBe("C:/")
  expect(absoluteTreePath("C:/", "README.md")).toBe("C:/README.md")
  expect(absoluteTreePath("/home/luke", "README.md")).toBe("/home/luke/README.md")
})

test("includes files only when the picker selects files", () => {
  const nodes = [
    { name: "components", type: "directory" as const },
    { name: "index.ts", type: "file" as const },
  ]
  expect(pickerTreeEntries("", nodes, "directory")).toEqual(["components/"])
  expect(pickerTreeEntries("", nodes, "file")).toEqual(["components/", "index.ts"])
})

test("includes files in file autocomplete while preserving directory navigation", () => {
  const nodes = [
    { name: "src", absolute: "/repo/src", type: "directory" as const },
    { name: "README.md", absolute: "/repo/README.md", type: "file" as const },
  ]
  expect(pickerSearchEntries(nodes, "directory")).toEqual([nodes[0]])
  expect(pickerSearchEntries(nodes, "file")).toEqual(nodes)
})

test("centralizes file and directory selection policy", () => {
  const file = pickerMode("file", "/repo")
  expect(file.includeFiles).toBeTrue()
  expect(file.selection("/repo/src", "index.ts")).toEqual(Option.some("src/index.ts"))
  expect(file.selection("/repo", "src/")).toEqual(Option.none())
  expect(file.result("/repo", "src/index.ts")).toEqual(Option.some("src/index.ts"))
  expect(file.selection("/tmp", "example.txt")).toEqual(Option.none())
  expect(file.navigation("/repo/src")).toEqual(Option.some("/repo/src"))
  expect(file.navigation("/tmp")).toEqual(Option.none())

  const directory = pickerMode("directory")
  expect(directory.includeFiles).toBeFalse()
  expect(directory.selection("/repo", "src/")).toEqual(Option.some("/repo/src"))
  expect(directory.selection("C:/Users/luke", "repos/")).toEqual(Option.some("C:\\Users\\luke\\repos"))
  expect(directory.selection("//Server/Share", "repo/")).toEqual(Option.some("\\\\Server\\Share\\repo"))
  expect(directory.navigation("/tmp")).toEqual(Option.some("/tmp"))
  expect(directory.result("/repo", "")).toEqual(Option.some("/repo"))
  expect(directory.result("C:/Users/luke", "")).toEqual(Option.some("C:\\Users\\luke"))
  expect(directory.result("//Server/Share/repo", "")).toEqual(Option.some("\\\\Server\\Share\\repo"))
  expect(directory.result("/repo", "", false)).toEqual(Option.none())
})

test("accepts mutations only from the active navigation", () => {
  expect(activeTreeNavigation(3, 3)).toBeTrue()
  expect(activeTreeNavigation(2, 3)).toBeFalse()
})

test("preserves POSIX case while matching Windows drives case-insensitively", () => {
  expect(treePathWithin("/repo", "/Repo")).toBeFalse()
  expect(treePathWithin("C:/Repo", "c:/repo/src")).toBeTrue()
  expect(treePathWithin("//Server/Share/Repo", "//server/share/repo/src")).toBeTrue()
  expect(pickerMode("file", "//Server/Share/Repo").selection("//server/share/repo/src", "file.ts")).toEqual(
    Option.some("src/file.ts"),
  )
  expect(treePathWithin("/repo", "/repo/../tmp")).toBeFalse()
  expect(treePathWithin("/", "/src")).toBeTrue()
  expect(pickerMode("file", "C:/Repo").selection("c:/repo/src", "file.ts")).toEqual(Option.some("src/file.ts"))
  expect(pickerMode("file", "C:/").selection("C:/", "file.ts")).toEqual(Option.some("file.ts"))
})

test("displays paths using the selected server path format", () => {
  expect(displayPickerPath("C:/Users/luke/repos", "C:/Users/luke/repos", "C:/Users/luke")).toBe(
    "C:\\Users\\luke\\repos",
  )
  expect(displayPickerPath("C:/Users/luke/repos", "C:\\Users\\luke\\repos", "C:/Users/luke")).toBe(
    "C:\\Users\\luke\\repos",
  )
  expect(displayPickerPath("/home/luke/repos", "repos", "/home/luke")).toBe("~/repos")
  expect(displayPickerPath("/home/luke/repos", "~/repos", "/home/luke")).toBe("~/repos")
})

test("treats the server share prefix as the UNC root", () => {
  expect(pickerRoot("//Server/Share/repo/src")).toBe("//Server/Share")
  expect(pickerRoot("\\\\Server\\Share\\repo\\src")).toBe("//Server/Share")
  expect(pickerParent("//Server/Share")).toBe("//Server/Share")
  expect(pickerParent("//Server/Share/repo")).toBe("//Server/Share")
})

test("resolves relative input against the current picker root", () => {
  expect(pickerAbsoluteInput("src", "/home/luke", "/home/luke/repo")).toBe("/home/luke/repo/src")
  expect(pickerAbsoluteInput("../other", "/home/luke", "/home/luke/repo")).toBe("/home/luke/other")
  expect(pickerAbsoluteInput("~/.config", "/home/luke", "/home/luke/repo")).toBe("/home/luke/.config")
  expect(pickerAbsoluteInput("src", "C:/Users/luke", "C:/Users/luke/repo")).toBe("C:/Users/luke/repo/src")
})

test("exposes autocomplete results only for their source query", () => {
  const result = { query: "/repo/src", items: ["/repo/src/index.ts"] }
  expect(currentPickerSuggestions(result, "/repo/src")).toEqual(result.items)
  expect(currentPickerSuggestions(result, "/repo/test")).toEqual([])
})

test("scopes file autocomplete to the current browser root", () => {
  expect(pickerFileSearchQuery("/home/luke/repos", "/home/luke/repos/src/in", "/home/luke")).toBe("src/in")
  expect(pickerFileSearchQuery("/home/luke", "~/repos/op", "/home/luke")).toBe("repos/op")
})

test("resolves directory autocomplete from the current browser root", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let directories = Chunk.empty<string>()
      const sdk: DirectorySearchClient = {
        api: {
          file: {
            find: (input) => {
              directories = Chunk.append(directories, input.location.directory)
              return settled({ data: [] })
            },
            list: () => settled({ data: [] }),
          },
        },
      }
      let base = "/repo"
      const search = createDirectorySearch({ sdk, home: () => "/home/luke", base: () => Option.some(base) })

      yield* search("components")
      base = "/repo/src"
      yield* search("components")

      expect(Chunk.toReadonlyArray(directories)).toEqual(["/repo", "/repo/src"])
    }),
  ))

test("keeps indexed directory results for servers that support empty search", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sdk: DirectorySearchClient = {
        api: {
          file: {
            find: () => settled({ data: [{ path: "projects/", type: "directory" }] }),
            list: () =>
              Effect.runPromise(
                Effect.fail(new TestFailure({ message: "listing should not run when search returns results" })),
              ),
          },
        },
      }
      const search = createDirectorySearch({ sdk, home: () => "/home/luke", base: () => Option.some("/home/luke") })

      expect(yield* search("")).toEqual(["/home/luke/projects"])
    }),
  ))

test("lists the default directory when empty search is unsupported", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let calls = Chunk.empty<string>()
      const directories = Array.from({ length: 60 }, (_, index) => ({
        path: `project-${index}/`,
        type: "directory" as const,
      }))
      const sdk: DirectorySearchClient = {
        api: {
          file: {
            find: () => settled({ data: [] }),
            list: (input) => {
              calls = Chunk.append(calls, input.location.directory)
              return settled({
                data: [...directories, { path: "README.md", type: "file" as const }],
              })
            },
          },
        },
      }
      const search = createDirectorySearch({ sdk, home: () => "/home/luke", base: () => Option.some("/home/luke") })

      const results = yield* search("")
      expect(results).toHaveLength(60)
      expect(results.at(-1)).toBe("/home/luke/project-59")
      expect(Chunk.toReadonlyArray(calls)).toEqual(["/home/luke"])
    }),
  ))

test("matches the default directory listing when typed search is unsupported", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sdk: DirectorySearchClient = {
        api: {
          file: {
            find: () => settled({ data: [] }),
            list: () =>
              settled({
                data: [
                  { path: "Documents/", type: "directory" as const },
                  { path: "Downloads/", type: "directory" as const },
                ],
              }),
          },
        },
      }
      const search = createDirectorySearch({ sdk, home: () => "/home/luke", base: () => Option.some("/home/luke") })

      expect(yield* search("documents")).toEqual(["/home/luke/Documents"])
    }),
  ))

test("searches from an absolute root without a default base", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let directories = Chunk.empty<string>()
      let searches = Chunk.empty<string>()
      const sdk: DirectorySearchClient = {
        api: {
          file: {
            find: (input) => {
              searches = Chunk.append(searches, input.location.directory)
              return settled({ data: [] })
            },
            list: (input) => {
              directories = Chunk.append(directories, input.location.directory)
              return settled({
                data: [
                  { path: "Users/", type: "directory" as const },
                  { path: "tmp/", type: "directory" as const },
                ],
              })
            },
          },
        },
      }
      const search = createDirectorySearch({ sdk, home: () => "", base: () => Option.none() })

      expect(yield* search("/")).toEqual(["/Users", "/tmp"])
      expect(Chunk.toReadonlyArray(directories)).toEqual(["/"])
      expect(Chunk.toReadonlyArray(searches)).toEqual([])
    }),
  ))

test("identifies the next directory level to preload", () => {
  expect(
    preloadTreeDirectories("src/", [
      { name: "components", type: "directory" },
      { name: "index.ts", type: "file" },
      { name: "utils", type: "directory" },
    ]),
  ).toEqual(["src/components/", "src/utils/"])
})

test("advances preloading once for every expanded directory", () => {
  const advanced = MutableHashSet.empty<string>()
  expect(advanceTreePreload(advanced, "")).toBeTrue()
  expect(advanceTreePreload(advanced, "")).toBeFalse()
  expect(advanceTreePreload(advanced, "repos/")).toBeTrue()
})

test("limits background tasks and prioritizes newly requested work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const queue = createPriorityTaskQueue<void>(2)
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      let started = Chunk.empty<string>()
      let active = 0
      let maximum = 0
      const task = (name: string, blocker: Effect.Effect<void> = Effect.void) =>
        Effect.gen(function* () {
          started = Chunk.append(started, name)
          active++
          maximum = Math.max(maximum, active)
          yield* blocker
          active--
        })

      const running = yield* Effect.all([
        queue.schedule("first", "background", task("first", Deferred.await(first))),
        queue.schedule("second", "background", task("second", Deferred.await(second))),
        queue.schedule("preload", "background", task("preload")),
        queue.schedule("opened", "user", task("opened")),
      ])
      yield* Effect.yieldNow
      expect(Chunk.toReadonlyArray(started)).toEqual(["first", "second"])

      yield* Deferred.done(first, Exit.void)
      yield* running[0]
      yield* Effect.yieldNow
      expect(Chunk.toReadonlyArray(started)).toEqual(["first", "second", "opened"])

      yield* Deferred.done(second, Exit.void)
      yield* Effect.all(running)
      expect(Chunk.toReadonlyArray(started)).toEqual(["first", "second", "opened", "preload"])
      expect(maximum).toBe(2)
    }),
  ))

test("clamps bridged tree wheel scrolling", () => {
  expect(nextTreeScrollTop(100, 40, 500, 200)).toBe(140)
  expect(nextTreeScrollTop(10, -40, 500, 200)).toBe(0)
  expect(nextTreeScrollTop(290, 40, 500, 200)).toBe(300)
})

test("wraps autocomplete keyboard navigation", () => {
  expect(nextSuggestionIndex(-1, 1, 4)).toBe(0)
  expect(nextSuggestionIndex(3, 1, 4)).toBe(0)
  expect(nextSuggestionIndex(0, -1, 4)).toBe(3)
  expect(nextSuggestionIndex(0, 1, 0)).toBe(-1)
})

test("returns absolute directories and relative files", () => {
  expect(selectedTreePath("/home/luke/repo", "src/", "directory")).toEqual(Option.some("/home/luke/repo/src"))
  expect(selectedTreePath("/home/luke/repo", "src/index.ts", "file")).toEqual(Option.some("src/index.ts"))
  expect(selectedTreePath("/home/luke/repo/src", "index.ts", "file", "/home/luke/repo")).toEqual(
    Option.some("src/index.ts"),
  )
  expect(selectedTreePath("/home/luke/repo", "src/", "file")).toEqual(Option.none())
})
