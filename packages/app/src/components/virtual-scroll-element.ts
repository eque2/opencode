import { Option } from "effect"

/**
 * Finds the scroll viewport that holds a connected root.
 *
 * The result feeds the virtualizer's `getScrollElement`, which reads null as
 * "no scroll element yet", so the Option is converted there.
 */
export function virtualScrollElement(root: HTMLElement | undefined): HTMLDivElement | null {
  return Option.fromNullishOr(root).pipe(
    Option.filter((element) => element.isConnected),
    Option.flatMap((element) => Option.fromNullishOr(element.closest<HTMLDivElement>(".scroll-view__viewport"))),
    Option.getOrNull,
  )
}
