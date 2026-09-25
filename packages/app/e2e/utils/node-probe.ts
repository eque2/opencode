import type { Locator } from "@playwright/test"

declare global {
  interface Window {
    /** Tags that e2e specs attach to DOM nodes to detect a remount (a fresh node has no tag). */
    __e2eNodeProbes?: WeakMap<Element, string>
  }
}

/** Tags the element that the locator resolves to, so a later read can tell whether the same DOM node survived. */
export async function writeNodeProbe(locator: Locator, probe: string) {
  await locator.evaluate((element, probe) => {
    window.__e2eNodeProbes ??= new WeakMap()
    window.__e2eNodeProbes.set(element, probe)
  }, probe)
}

/** Reads the tag of the element that the locator resolves to now; a remounted element has no tag. */
export function readNodeProbe(locator: Locator) {
  return locator.evaluate((element) => window.__e2eNodeProbes?.get(element))
}
