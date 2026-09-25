import { Predicate } from "effect"

export function errorDescriptionKey(error: unknown) {
  if (Predicate.isObjectOrArray(error) && "localServerStartup" in error && error.localServerStartup === true) {
    return "error.page.description.localServerStartup" as const
  }
  return "error.page.description" as const
}
