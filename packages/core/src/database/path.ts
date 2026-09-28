import nodePath from "path"
import { Schema } from "effect"
import { customType } from "drizzle-orm/sqlite-core"
import { AbsolutePath } from "../schema"

function storagePath(input: string) {
  if (process.platform !== "win32") return input
  return input.replaceAll("\\", "/")
}

function isWindowsStoragePath(input: string) {
  return /^[A-Za-z]:\//.test(input) || input.startsWith("//")
}

// A stored path must be absolute: POSIX, or a drive or UNC path on Windows. The drizzle-orm
// customType mappers are synchronous, so decodeSync rejects a bad path by throwing its schema error.
const StoragePath = Schema.String.check(
  Schema.makeFilter((path) =>
    nodePath.posix.isAbsolute(path) || (process.platform === "win32" && isWindowsStoragePath(path))
      ? true
      : `Path is not absolute: ${path}`,
  ),
)
const decodeStoragePath = Schema.decodeSync(StoragePath)
const StoragePathsJson = Schema.fromJsonString(Schema.Array(Schema.String))

function absolute(input: string) {
  return decodeStoragePath(storagePath(input))
}

function toPlatform(input: string) {
  if (process.platform !== "win32" || !isWindowsStoragePath(input)) return input
  return input.replaceAll("/", "\\")
}

export const absoluteColumn = customType<{
  data: AbsolutePath
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return absolute(input)
  },
  fromDriver(input) {
    return AbsolutePath.make(toPlatform(absolute(input)))
  },
})

// Legacy sessions may persist an empty directory. Keep that existing value
// readable while normalizing and validating every real directory.
export const directoryColumn = customType<{
  data: string
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return input ? absolute(input) : input
  },
  fromDriver(input) {
    return input ? toPlatform(absolute(input)) : input
  },
})

export const pathColumn = customType<{
  data: string
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return storagePath(input)
  },
  fromDriver(input) {
    return storagePath(input)
  },
})

export const absoluteArrayColumn = customType<{
  data: AbsolutePath[]
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return Schema.encodeSync(StoragePathsJson)(input.map(absolute))
  },
  fromDriver(input) {
    return Schema.decodeSync(StoragePathsJson)(input).map((item) => AbsolutePath.make(toPlatform(absolute(item))))
  },
})
