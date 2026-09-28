import { glob, globSync, type GlobOptionsWithFileTypesFalse } from "glob"
import { minimatch } from "minimatch"

export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
  }

  // Without withFileTypes, glob resolves the string[] overloads.
  function toGlobOptions(options: Options): GlobOptionsWithFileTypesFalse {
    return {
      cwd: options.cwd,
      absolute: options.absolute,
      dot: options.dot,
      follow: options.symlink ?? false,
      nodir: options.include !== "all",
    }
  }

  export function scan(pattern: string, options: Options = {}): Promise<string[]> {
    return glob(pattern, toGlobOptions(options))
  }

  export function scanSync(pattern: string, options: Options = {}): string[] {
    return globSync(pattern, toGlobOptions(options))
  }

  export function match(pattern: string, filepath: string): boolean {
    return minimatch(filepath, pattern, { dot: true })
  }
}
