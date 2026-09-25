import { describe, expect, test } from "bun:test"
import { Chunk, Option } from "effect"
import { invalidateFromWatcher } from "./watcher"

describe("file watcher invalidation", () => {
  test("reloads open files and refreshes loaded parent on add", () => {
    let loads = Chunk.empty<string>()
    let refresh = Chunk.empty<string>()
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/new.ts",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: (path) => path === "src/new.ts",
        loadFile: (path) => {
          loads = Chunk.append(loads, path)
        },
        node: () => Option.none(),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => {
          refresh = Chunk.append(refresh, path)
        },
      },
    )

    expect(Chunk.toReadonlyArray(loads)).toEqual(["src/new.ts"])
    expect(Chunk.toReadonlyArray(refresh)).toEqual(["src"])
  })

  test("reloads files that are open in tabs", () => {
    let loads = Chunk.empty<string>()

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/open.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        isOpen: (path) => path === "src/open.ts",
        loadFile: (path) => {
          loads = Chunk.append(loads, path)
        },
        node: () =>
          Option.some({
            path: "src/open.ts",
            type: "file",
            name: "open.ts",
            absolute: "/repo/src/open.ts",
            ignored: false,
          }),
        isDirLoaded: () => false,
        refreshDir: () => {},
      },
    )

    expect(Chunk.toReadonlyArray(loads)).toEqual(["src/open.ts"])
  })

  test("refreshes only changed loaded directory nodes", () => {
    let refresh = Chunk.empty<string>()

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => Option.some({ path: "src", type: "directory", name: "src", absolute: "/repo/src", ignored: false }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => {
          refresh = Chunk.append(refresh, path)
        },
      },
    )

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/file.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () =>
          Option.some({
            path: "src/file.ts",
            type: "file",
            name: "file.ts",
            absolute: "/repo/src/file.ts",
            ignored: false,
          }),
        isDirLoaded: () => true,
        refreshDir: (path) => {
          refresh = Chunk.append(refresh, path)
        },
      },
    )

    expect(Chunk.toReadonlyArray(refresh)).toEqual(["src"])
  })

  test("ignores invalid or git watcher updates", () => {
    let loads = Chunk.empty<string>()
    let refresh = Chunk.empty<string>()

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: ".git/index.lock",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => true,
        loadFile: (path) => {
          loads = Chunk.append(loads, path)
        },
        node: () => Option.none(),
        isDirLoaded: () => true,
        refreshDir: (path) => {
          refresh = Chunk.append(refresh, path)
        },
      },
    )

    invalidateFromWatcher(
      {
        type: "project.updated",
        properties: {},
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => Option.none(),
        isDirLoaded: () => true,
        refreshDir: (path) => {
          refresh = Chunk.append(refresh, path)
        },
      },
    )

    expect(Chunk.toReadonlyArray(loads)).toEqual([])
    expect(Chunk.toReadonlyArray(refresh)).toEqual([])
  })
})
