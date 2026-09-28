import type { FileContent } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, Match, on, onCleanup, Show, Switch, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Option } from "effect"
import {
  dataUrlFromMediaValue,
  hasMediaValue,
  isBinaryContent,
  mediaKindFromPath,
  normalizeMimeType,
  svgTextFromValue,
  type MediaKind,
} from "../pierre/media"

export type FileMediaOptions = {
  mode?: "auto" | "off"
  path?: string
  current?: unknown
  before?: unknown
  after?: unknown
  deleted?: boolean
  readFile?: (path: string) => Promise<FileContent | undefined>
  onLoad?: () => void
  onError?: (ctx: { kind: "image" | "audio" | "svg" }) => void
}

type MediaView = MediaKind | "none"

type RemoteRequest = {
  key: string
  kind: "image" | "audio"
  path: string
  readFile: (path: string) => Promise<FileContent | undefined>
  onError: FileMediaOptions["onError"]
}

function mediaValue(cfg: FileMediaOptions, mode: "image" | "audio") {
  if (cfg.current !== undefined) return cfg.current
  if (mode === "image") return cfg.after ?? cfg.before
  return cfg.after ?? cfg.before
}

export function FileMedia(props: { media?: FileMediaOptions; fallback: () => JSX.Element }) {
  const i18n = useI18n()
  const [remote, setRemote] = createStore<{
    key: Option.Option<string>
    loading: boolean
    error: boolean
    src: Option.Option<string>
    mime: Option.Option<string>
  }>({ key: Option.none(), loading: false, error: false, src: Option.none(), mime: Option.none() })
  const cfg = () => props.media
  const kind = createMemo((): MediaView => {
    const media = cfg()
    if (!media || media.mode === "off") return "none"
    return Option.getOrElse(mediaKindFromPath(media.path), (): MediaView => "none")
  })

  const isBinary = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return false
    if (kind() !== "none") return false
    return isBinaryContent(media.current)
  })

  const onLoad = () => props.media?.onLoad?.()

  const deleted = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || k === "none") return false
    if (media.deleted) return true
    if (k === "svg") return false
    if (media.current !== undefined) return false
    return !hasMediaValue(media.after) && hasMediaValue(media.before)
  })

  const direct = createMemo((): Option.Option<string> => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return Option.none()
    return dataUrlFromMediaValue(mediaValue(media, k), k)
  })

  const request = createMemo((): Option.Option<RemoteRequest> => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return Option.none()
    if (media.current !== undefined) return Option.none()
    if (deleted()) return Option.none()
    if (Option.isSome(direct())) return Option.none()
    if (!media.path || !media.readFile) return Option.none()

    return Option.some({
      key: `${k}:${media.path}`,
      kind: k,
      path: media.path,
      readFile: media.readFile,
      onError: media.onError,
    })
  })

  // True when the remote store holds the load or the result for this request.
  const remoteFor = (input: RemoteRequest) => Option.contains(remote.key, input.key)

  createEffect(() => {
    const next = request()
    if (Option.isNone(next)) {
      setRemote({ key: Option.none(), loading: false, error: false, src: Option.none(), mime: Option.none() })
      return
    }
    const input = next.value

    let active = true
    // Keep the previous media visible while re-reading the same file (e.g. a vcs
    // diff refresh); only a key change resets to the loading placeholder.
    if (untrack(() => remoteFor(input))) setRemote({ loading: true, error: false })
    else setRemote({ key: Option.some(input.key), loading: true, error: false, src: Option.none(), mime: Option.none() })
    void input.readFile(input.path).then(
      (result) => {
        if (!active) return
        const src = dataUrlFromMediaValue(result, input.kind)
        if (Option.isNone(src)) {
          input.onError?.({ kind: input.kind })
          setRemote({ key: Option.some(input.key), loading: false, error: true, src: Option.none(), mime: Option.none() })
          return
        }

        setRemote({
          key: Option.some(input.key),
          loading: false,
          error: false,
          src,
          mime:
            input.kind === "audio"
              ? Option.fromNullishOr(result?.mimeType).pipe(Option.flatMap(normalizeMimeType))
              : Option.none(),
        })
      },
      () => {
        if (!active) return
        input.onError?.({ kind: input.kind })
        setRemote({ key: Option.some(input.key), loading: false, error: true, src: Option.none(), mime: Option.none() })
      },
    )

    onCleanup(() => {
      active = false
    })
  })

  const src = createMemo((): Option.Option<string> => {
    const input = request()
    if (Option.isNone(input) || !remoteFor(input.value) || remote.error) return direct()
    return Option.orElse(direct(), () => remote.src)
  })
  const status = createMemo(() => {
    if (Option.isSome(direct())) return "ready" as const
    const input = request()
    if (Option.isNone(input)) return "idle" as const
    if (!remoteFor(input.value) || remote.loading) return "loading" as const
    if (remote.error) return "error" as const
    if (Option.isSome(src())) return "ready" as const
    return "idle" as const
  })
  const audioMime = createMemo((): Option.Option<string> => {
    const input = request()
    if (Option.isNone(input) || !remoteFor(input.value)) return Option.none()
    return remote.mime
  })

  const svgSource = createMemo((): Option.Option<string> => {
    const media = cfg()
    if (!media || kind() !== "svg") return Option.none()
    return svgTextFromValue(media.current)
  })
  const svgSrc = createMemo((): Option.Option<string> => {
    const media = cfg()
    if (!media || kind() !== "svg") return Option.none()
    return dataUrlFromMediaValue(media.current, "svg")
  })
  const svgInvalid = createMemo((): Option.Option<readonly [string | undefined, unknown]> => {
    const media = cfg()
    if (!media || kind() !== "svg") return Option.none()
    if (Option.isSome(svgSource())) return Option.none()
    if (!hasMediaValue(media.current)) return Option.none()
    return Option.some([media.path, media.current] as const)
  })

  createEffect(
    on(
      svgInvalid,
      (value) => {
        if (Option.isNone(value)) return
        cfg()?.onError?.({ kind: "svg" })
      },
      { defer: true },
    ),
  )

  const kindLabel = (value: "image" | "audio") =>
    i18n.t(value === "image" ? "ui.fileMedia.kind.image" : "ui.fileMedia.kind.audio")

  return (
    <Switch>
      <Match when={kind() === "image" || kind() === "audio"}>
        <Show
          when={Option.getOrUndefined(src())}
          fallback={(() => {
            const media = cfg()
            const k = kind()
            if (!media || (k !== "image" && k !== "audio")) return props.fallback()
            const label = kindLabel(k)

            if (deleted()) {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.removed", { kind: label })}
                </div>
              )
            }
            if (status() === "loading") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.loading", { kind: label })}
                </div>
              )
            }
            if (status() === "error") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.error", { kind: label })}
                </div>
              )
            }
            return (
              <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                {i18n.t("ui.fileMedia.state.unavailable", { kind: label })}
              </div>
            )
          })()}
        >
          {(value) => {
            const k = kind()
            if (k !== "image" && k !== "audio") return props.fallback()
            if (k === "image") {
              return (
                <div class="flex justify-center bg-background-stronger px-6 py-4">
                  <img
                    src={value()}
                    alt={cfg()?.path}
                    class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain"
                    onLoad={onLoad}
                  />
                </div>
              )
            }

            return (
              <div class="flex justify-center bg-background-stronger px-6 py-4">
                <audio class="w-full max-w-xl" controls preload="metadata" onLoadedMetadata={onLoad}>
                  <source src={value()} type={Option.getOrUndefined(audioMime())} />
                </audio>
              </div>
            )
          }}
        </Show>
      </Match>
      <Match when={kind() === "svg"}>
        {(() => {
          if (Option.isNone(svgSource()) && Option.isNone(svgSrc())) return props.fallback()

          return (
            <div class="flex flex-col gap-4 px-6 py-4">
              <Show when={Option.isSome(svgSource())}>{props.fallback()}</Show>
              <Show when={Option.getOrUndefined(svgSrc())}>
                {(value) => (
                  <div class="flex justify-center">
                    <img
                      src={value()}
                      alt={cfg()?.path}
                      class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain"
                      onLoad={onLoad}
                    />
                  </div>
                )}
              </Show>
            </div>
          )
        })()}
      </Match>
      <Match when={isBinary()}>
        <div class="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div class="text-14-semibold text-text-strong">
            {cfg()?.path?.split("/").pop() ?? i18n.t("ui.fileMedia.binary.title")}
          </div>
          <div class="text-14-regular text-text-weak">
            {(() => {
              const path = cfg()?.path
              if (!path) return i18n.t("ui.fileMedia.binary.description.default")
              return i18n.t("ui.fileMedia.binary.description.path", { path })
            })()}
          </div>
        </div>
      </Match>
      <Match when={true}>{props.fallback()}</Match>
    </Switch>
  )
}
