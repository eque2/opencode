import { Array, Effect, Predicate, Record } from "effect"
import fuzzysort from "fuzzysort"
import { createEffect, createMemo, createResource, on } from "solid-js"
import { createStore } from "solid-js/store"
import { createList } from "solid-list"

export interface FilteredListProps<T> {
  items: T[] | ((filter: string) => T[] | Promise<T[]>)
  key: (item: T) => string
  filterKeys?: string[]
  current?: T
  groupBy?: (x: T) => string
  sortBy?: (a: T, b: T) => number
  sortGroupsBy?: (a: { category: string; items: T[] }, b: { category: string; items: T[] }) => number
  skipFilter?: (item: T) => boolean
  onSelect?: (value: T | undefined, index: number) => void
  noInitialSelection?: boolean
}

export function useFilteredList<T>(props: FilteredListProps<T>) {
  const [store, setStore] = createStore<{ filter: string }>({ filter: "" })

  type Group = { category: string; items: [T, ...T[]] }
  const empty: Group[] = []

  const search = (all: T[], needle: string) => {
    const skipFilter = props.skipFilter
    const filterable = skipFilter ? all.filter((item) => !skipFilter(item)) : all
    const skipped = skipFilter ? all.filter(skipFilter) : []
    const filtered =
      !props.filterKeys && Array.isArray(filterable) && filterable.every((e) => typeof e === "string")
        ? fuzzysort.go(needle, filterable, { key: (item) => item }).map((x) => x.obj)
        : fuzzysort.go(needle, filterable, { keys: props.filterKeys! }).map((x) => x.obj)
    return skipped.length ? [...filtered, ...skipped] : filtered
  }

  const [grouped, { refetch }] = createResource(
    () => ({
      filter: store.filter,
      items: typeof props.items === "function" ? props.items(store.filter) : props.items,
    }),
    ({ filter, items }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const query = filter ?? ""
          const needle = query.toLowerCase()
          const all = (Predicate.isPromiseLike(items) ? yield* Effect.promise(() => items) : items) || []
          const groups = Array.map(
            Record.toEntries(
              Array.groupBy(needle ? search(all, needle) : all, (x) => (props.groupBy ? props.groupBy(x) : "")),
            ),
            ([k, v]) => ({ category: k, items: props.sortBy ? v.sort(props.sortBy) : v }),
          )
          return props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups
        }),
      ),
    { initialValue: empty },
  )

  const flat = createMemo(() => Array.flatMap(grouped.latest || [], (x) => x.items))

  function initialActive() {
    if (props.noInitialSelection) return ""
    if (props.current) return props.key(props.current)

    const items = flat()
    if (items.length === 0) return ""
    return props.key(items[0])
  }

  const list = createList({
    items: () => flat().map(props.key),
    initialActive: initialActive(),
    loop: true,
  })

  const reset = () => {
    if (props.noInitialSelection) {
      list.setActive("")
      return
    }
    const all = flat()
    if (all.length === 0) return
    list.setActive(props.key(all[0]))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const selectedIndex = flat().findIndex((x) => props.key(x) === list.active())
      const selected = flat()[selectedIndex]
      if (selected) props.onSelect?.(selected, selectedIndex)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "n" || event.key === "p") {
        event.preventDefault()
        const navEvent = new KeyboardEvent("keydown", {
          key: event.key === "n" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
        })
        list.onKeyDown(navEvent)
      }
    } else {
      // Skip list navigation for text editing shortcuts (e.g., Option+Arrow, Option+Backspace on macOS)
      if (event.altKey || event.metaKey) return
      list.onKeyDown(event)
    }
  }

  createEffect(
    on(grouped, () => {
      reset()
    }),
  )

  const onInput = (value: string) => {
    setStore("filter", value)
  }

  return {
    grouped,
    filter: () => store.filter,
    flat,
    reset,
    refetch,
    clear: () => setStore("filter", ""),
    onKeyDown,
    onInput,
    active: list.active,
    setActive: list.setActive,
  }
}
