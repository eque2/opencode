import { Effect, MutableHashSet, Predicate } from "effect"
import { createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createFiberSlot } from "@/utils/fiber-slot"
import { persisted } from "@/utils/persist"
import { DialogReleaseNotes, type Highlight } from "@/components/dialog-release-notes"

const CHANGELOG_URL = "https://opencode.ai/changelog.json"

type Store = {
  version?: string
}

type ParsedRelease = {
  tag?: string
  highlights: Highlight[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Predicate.isObject(value)
}

function getText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    if (text.length === 0) return undefined
    return text
  }

  if (typeof value === "number") return String(value)
  return undefined
}

function normalizeVersion(value: string | undefined) {
  const text = value?.trim()
  if (!text) return undefined
  return text.startsWith("v") || text.startsWith("V") ? text.slice(1) : text
}

function parseMedia(value: unknown, alt: string): Highlight["media"] | undefined {
  if (!isRecord(value)) return undefined
  const type = getText(value.type)?.toLowerCase()
  const src = getText(value.src) ?? getText(value.url)
  if (!src) return undefined
  if (type !== "image" && type !== "video") return undefined

  return { type, src, alt }
}

function parseHighlight(value: unknown): Highlight | undefined {
  if (!isRecord(value)) return undefined

  const title = getText(value.title)
  if (!title) return undefined

  const description = getText(value.description) ?? getText(value.shortDescription)
  if (!description) return undefined

  const media = parseMedia(value.media, title)
  return { title, description, media }
}

function parseRelease(value: unknown): ParsedRelease | undefined {
  if (!isRecord(value)) return undefined
  const tag = getText(value.tag) ?? getText(value.tag_name) ?? getText(value.name)

  if (!Array.isArray(value.highlights)) {
    return { tag, highlights: [] }
  }

  const highlights = value.highlights.flatMap((group) => {
    if (!isRecord(group)) return []

    const source = getText(group.source)
    if (!source) return []
    if (!source.toLowerCase().includes("desktop")) return []

    if (Array.isArray(group.items)) {
      return group.items.map((item) => parseHighlight(item)).filter((item): item is Highlight => item !== undefined)
    }

    const item = parseHighlight(group)
    if (!item) return []
    return [item]
  })

  return { tag, highlights }
}

function parseChangelog(value: unknown): ParsedRelease[] | undefined {
  if (Array.isArray(value)) {
    return value.map(parseRelease).filter((release): release is ParsedRelease => release !== undefined)
  }

  if (!isRecord(value)) return undefined
  if (!Array.isArray(value.releases)) return undefined

  return value.releases.map(parseRelease).filter((release): release is ParsedRelease => release !== undefined)
}

function sliceHighlights(input: { releases: ParsedRelease[]; current?: string; previous?: string }) {
  const current = normalizeVersion(input.current)
  const previous = normalizeVersion(input.previous)
  const releases = input.releases

  const start = (() => {
    if (!current) return 0
    const index = releases.findIndex((release) => normalizeVersion(release.tag) === current)
    return index === -1 ? 0 : index
  })()

  const end = (() => {
    if (!previous) return releases.length
    const index = releases.findIndex((release, i) => i >= start && normalizeVersion(release.tag) === previous)
    return index === -1 ? releases.length : index
  })()

  const highlights = releases.slice(start, end).flatMap((release) => release.highlights)
  const seen = MutableHashSet.empty<string>()
  const unique = highlights.filter((highlight) => {
    const key = dedupeKey(highlight)
    if (MutableHashSet.has(seen, key)) return false
    MutableHashSet.add(seen, key)
    return true
  })
  return unique.slice(0, 5)
}

function dedupeKey(highlight: Highlight) {
  return [highlight.title, highlight.description, highlight.media?.type ?? "", highlight.media?.src ?? ""].join("\n")
}

function loadReleaseHighlights(value: unknown, current?: string, previous?: string) {
  const releases = parseChangelog(value)
  if (!releases?.length) return []
  return sliceHighlights({ releases, current, previous })
}

export const { use: useHighlights, provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const dialog = useDialog()
    const settings = useSettings()
    const [store, setStore, _, ready] = persisted("highlights.v1", createStore<Store>({}))

    const [range, setRange] = createStore<{ from?: string; to?: string }>({})
    const state = { started: false }

    const markSeen = () => {
      if (!platform.version) return
      setStore("version", platform.version)
    }

    const start = (previous: string) => {
      if (!settings.general.releaseNotes()) {
        markSeen()
        return
      }

      const fetcher = platform.fetch ?? fetch
      // The slot belongs to the current Solid effect run; its cleanup interrupts the request or the delay.
      const load = createFiberSlot()

      const loadHighlights = Effect.gen(function* () {
        const response = yield* Effect.tryPromise((signal) =>
          fetcher(CHANGELOG_URL, {
            signal,
            headers: { Accept: "application/json" },
          }),
        )
        if (!response.ok) return
        const json: unknown = yield* Effect.tryPromise(() => response.json())
        if (!json) return
        const highlights = loadReleaseHighlights(json, platform.version, previous)

        if (highlights.length === 0) {
          markSeen()
          return
        }

        yield* Effect.sleep("500 millis")
        markSeen()
        void dialog.show(() => <DialogReleaseNotes highlights={highlights} />)
      })
      // A failed changelog request or body read leaves the release notes unseen, as the old .catch did.
      load.run(loadHighlights.pipe(Effect.ignore))
    }

    createEffect(() => {
      if (state.started) return
      if (!ready()) return
      if (!settings.ready()) return
      if (!platform.version) return
      state.started = true

      const previous = store.version
      if (!previous) {
        setStore("version", platform.version)
        return
      }

      if (previous === platform.version) return

      setRange({ from: previous, to: platform.version })
      start(previous)
    })

    return {
      ready,
      from: () => range.from,
      to: () => range.to,
      get last() {
        return store.version
      },
      markSeen,
    }
  },
})
