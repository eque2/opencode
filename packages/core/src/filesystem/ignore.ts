import { HashSet } from "effect"
import { Glob } from "../util/glob"

const FOLDER_NAMES = [
  "node_modules",
  "bower_components",
  ".pnpm-store",
  "vendor",
  ".npm",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "bin",
  "obj",
  ".git",
  ".svn",
  ".hg",
  ".vscode",
  ".idea",
  ".turbo",
  ".output",
  "desktop",
  ".sst",
  ".cache",
  ".webkit-cache",
  "__pycache__",
  ".pytest_cache",
  "mypy_cache",
  ".history",
  ".gradle",
]

const FOLDERS = HashSet.fromIterable(FOLDER_NAMES)

const FILES = [
  "**/*.swp",
  "**/*.swo",
  "**/*.pyc",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/logs/**",
  "**/tmp/**",
  "**/temp/**",
  "**/*.log",
  "**/coverage/**",
  "**/.nyc_output/**",
]

export const PATTERNS = [...FILES, ...FOLDER_NAMES]

export function match(filepath: string, opts?: { extra?: string[]; whitelist?: string[] }) {
  for (const pattern of opts?.whitelist || []) {
    if (Glob.match(pattern, filepath)) return false
  }

  const parts = filepath.split(/[/\\]/)
  for (const part of parts) {
    if (HashSet.has(FOLDERS, part)) return true
  }

  for (const pattern of [...FILES, ...(opts?.extra || [])]) {
    if (Glob.match(pattern, filepath)) return true
  }

  return false
}

export * as Ignore from "./ignore"
