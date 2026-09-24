import { createRequire } from "node:module"
import path from "node:path"
import { Result } from "effect"

export namespace Module {
  // A package that require.resolve cannot find resolves to undefined.
  export function resolve(id: string, dir: string) {
    return Result.getOrUndefined(Result.try(() => createRequire(path.join(dir, "package.json")).resolve(id)))
  }
}
