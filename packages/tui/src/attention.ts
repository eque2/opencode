/// <reference path="./audio.d.ts" />
import type {
  TuiAttention,
  TuiAttentionNotification,
  TuiAttentionNotifyInput,
  TuiAttentionNotifyResult,
  TuiAttentionNotifySkipReason,
  TuiAttentionWhen,
  TuiKV,
  TuiAttentionSound,
  TuiAttentionSoundName,
  TuiAttentionSoundPack,
  TuiAttentionSoundPackInfo,
} from "@opencode-ai/plugin/tui"
import { AttentionSoundName, type TuiConfig } from "./config"
import { Effect, MutableHashMap, Option, Predicate, Schema } from "effect"
import stripAnsi from "strip-ansi"
import * as TuiAudio from "./audio"
import defaultSoundPath from "@opencode-ai/ui/audio/bip-bop-01.mp3" with { type: "file" }
import questionSoundPath from "@opencode-ai/ui/audio/bip-bop-03.mp3" with { type: "file" }
import permissionSoundPath from "@opencode-ai/ui/audio/staplebops-06.mp3" with { type: "file" }
import errorSoundPath from "@opencode-ai/ui/audio/nope-03.mp3" with { type: "file" }
import doneSoundPath from "@opencode-ai/ui/audio/bip-bop-01.mp3" with { type: "file" }
import subagentDoneSoundPath from "@opencode-ai/ui/audio/yup-01.mp3" with { type: "file" }

type FocusState = "unknown" | "focused" | "blurred"

type AttentionRenderer = {
  readonly isDestroyed: boolean
  on(event: "focus" | "blur", listener: () => void): unknown
  off(event: "focus" | "blur", listener: () => void): unknown
  triggerNotification(message: string, title?: string): boolean
}

type RegisteredSoundPack = TuiAttentionSoundPack & {
  builtin: boolean
}

type TuiAttentionHost = TuiAttention & {
  dispose(): void
}

const DEFAULT_TITLE = "opencode"
const DEFAULT_PACK_ID = "opencode.default"
const KV_SOUND_PACK = "attention_sound_pack"
const TITLE_LIMIT = 80
const MESSAGE_LIMIT = 240
const BUILTIN_PACK: RegisteredSoundPack = {
  id: DEFAULT_PACK_ID,
  name: "OpenCode Default",
  builtin: true,
  sounds: {
    default: defaultSoundPath,
    question: questionSoundPath,
    permission: permissionSoundPath,
    error: errorSoundPath,
    done: doneSoundPath,
    subagent_done: subagentDoneSoundPath,
  },
}

function skipped(reason: TuiAttentionNotifySkipReason): TuiAttentionNotifyResult {
  return {
    ok: false,
    notification: false,
    sound: false,
    skipped: reason,
  }
}

function normalizeText(input: string | undefined, fallback: string, limit: number) {
  const text = stripAnsi(input ?? "")
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
  const normalized = text.length ? text : fallback
  return Array.from(normalized).slice(0, limit).join("")
}

function clampVolume(volume: number) {
  if (!Number.isFinite(volume)) return 0
  return Math.min(1, Math.max(0, volume))
}

function soundVolume(
  input: TuiAttentionNotifyInput,
  config: Pick<TuiConfig.Resolved, "attention">,
): Option.Option<number> {
  if (!config.attention.sound) return Option.none()
  if (input.sound === false) return Option.none()
  if (input.sound === undefined) return Option.some(clampVolume(config.attention.volume))
  if (input.sound === true) return Option.some(clampVolume(config.attention.volume))
  return Option.some(clampVolume(input.sound.volume ?? config.attention.volume))
}

function normalizePack(pack: TuiAttentionSoundPack): Option.Option<RegisteredSoundPack> {
  const id = pack.id.trim()
  if (!id) return Option.none()
  const name = pack.name?.trim()
  return Option.some({
    id,
    ...(name ? { name } : {}),
    builtin: false,
    sounds: Object.fromEntries(
      Object.entries(pack.sounds).filter(
        (item): item is [TuiAttentionSoundName, string] =>
          Schema.is(AttentionSoundName)(item[0]) && typeof item[1] === "string" && item[1].trim().length > 0,
      ),
    ),
  })
}

function focusSkip(when: TuiAttentionWhen, focus: FocusState): Option.Option<TuiAttentionNotifySkipReason> {
  if (when === "always") return Option.none()
  if (focus === "unknown") return Option.some("focus_unknown")
  if (when === "blurred" && focus === "focused") return Option.some("focused")
  if (when === "focused" && focus === "blurred") return Option.some("blurred")
  return Option.none()
}

// The `when` of an object request. A boolean or absent request uses the fallback.
function requestedWhen(request: TuiAttentionNotification | TuiAttentionSound | undefined, fallback: TuiAttentionWhen) {
  return Predicate.isObject(request) ? (request.when ?? fallback) : fallback
}

export function createTuiAttention(input: {
  renderer: AttentionRenderer
  config: Pick<TuiConfig.Resolved, "attention">
  kv?: TuiKV
  audio?: Pick<typeof TuiAudio, "loadSoundFile" | "play">
}): TuiAttentionHost {
  let focus: FocusState = "unknown"
  let disposed = false
  let activePackID: Option.Option<string> = Option.none()
  const packs = MutableHashMap.make([BUILTIN_PACK.id, BUILTIN_PACK])
  const audio = input.audio ?? TuiAudio

  const onFocus = () => {
    focus = "focused"
  }
  const onBlur = () => {
    focus = "blurred"
  }

  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)

  function configuredPackID() {
    const stored = Option.fromNullishOr(input.kv?.get<string | undefined>(KV_SOUND_PACK))
    return activePackID.pipe(
      Option.orElse(() => stored),
      Option.getOrElse(() => input.config.attention.sound_pack),
    )
  }

  function currentPack() {
    return Option.getOrElse(MutableHashMap.get(packs, configuredPackID()), () => BUILTIN_PACK)
  }

  function soundCandidates(name: TuiAttentionSoundName) {
    return [input.config.attention.sounds[name], currentPack().sounds[name], BUILTIN_PACK.sounds[name]].filter(
      (item, index, list): item is string => typeof item === "string" && list.indexOf(item) === index,
    )
  }

  // Try each candidate file in order until one loads and plays.
  const playSound = (name: TuiAttentionSoundName, volume: number) =>
    Effect.gen(function* () {
      for (const file of soundCandidates(name)) {
        const current = yield* Effect.tryPromise(() => audio.loadSoundFile(file)).pipe(
          Effect.map(Option.fromNullishOr),
          Effect.catch((error) =>
            Effect.logDebug("failed to load attention sound", { file, error: error.cause }).pipe(
              Effect.as(Option.none()),
            ),
          ),
        )
        if (disposed) return false
        if (Option.isNone(current)) continue
        if (Predicate.isNotNullish(audio.play(current.value, { volume }))) return true
      }
      return false
    }).pipe(
      Effect.catchDefect((error) => Effect.logDebug("failed to play attention sound", { error }).pipe(Effect.as(false))),
    )

  const deliver = (request: TuiAttentionNotifyInput) =>
    Effect.gen(function* () {
      if (!input.config.attention.enabled) return skipped("attention_disabled")
      if (disposed || input.renderer.isDestroyed) return skipped("renderer_destroyed")

      const message = normalizeText(request.message, "", MESSAGE_LIMIT)
      if (!message) return skipped("empty_message")

      const notificationSkip = focusSkip(requestedWhen(request.notification, "blurred"), focus)
      const notificationRequested = input.config.attention.notifications && request.notification !== false
      const shouldNotify = notificationRequested && Option.isNone(notificationSkip)
      const notification = shouldNotify
        ? yield* Effect.try(() =>
            input.renderer.triggerNotification(message, normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT)),
          ).pipe(
            Effect.catch((error) =>
              Effect.logDebug("failed to trigger attention notification", { error: error.cause }).pipe(
                Effect.as(false),
              ),
            ),
          )
        : false
      const volume = soundVolume(request, input.config)
      const soundSkip = Option.isSome(volume) ? focusSkip(requestedWhen(request.sound, "always"), focus) : Option.none()
      const soundName =
        Predicate.isObject(request.sound) && Schema.is(AttentionSoundName)(request.sound.name)
          ? request.sound.name
          : "default"
      const sound =
        Option.isSome(volume) && Option.isNone(soundSkip) ? yield* playSound(soundName, volume.value) : false

      if (!notification && !sound) {
        if (notificationRequested && Option.isSome(notificationSkip)) return skipped(notificationSkip.value)
        if (Option.isSome(soundSkip)) return skipped(soundSkip.value)
      }

      return {
        ok: notification || sound,
        notification,
        sound,
      }
    }).pipe(
      // A throw anywhere in the request still resolves to "not delivered".
      Effect.catchDefect((error) =>
        Effect.logDebug("failed to handle attention notification", { error }).pipe(
          Effect.as({ ok: false, notification: false, sound: false }),
        ),
      ),
    )

  return {
    notify(request) {
      return Effect.runPromise(deliver(request))
    },
    soundboard: {
      registerPack(pack) {
        const normalized = normalizePack(pack)
        if (Option.isNone(normalized)) return () => {}
        const next = normalized.value
        MutableHashMap.set(packs, next.id, next)
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          // Remove the pack only while it is still the one registered under this id.
          if (Option.exists(MutableHashMap.get(packs, next.id), (current) => current === next))
            MutableHashMap.remove(packs, next.id)
        }
      },
      activate(id, options) {
        const pack = MutableHashMap.get(packs, id)
        if (Option.isNone(pack)) return false
        activePackID = Option.some(pack.value.id)
        if (options?.persist) input.kv?.set(KV_SOUND_PACK, pack.value.id)
        return true
      },
      current() {
        return currentPack().id
      },
      list(): TuiAttentionSoundPackInfo[] {
        const current = currentPack().id
        return Array.from(MutableHashMap.values(packs), (pack) => ({
          id: pack.id,
          name: pack.name,
          active: pack.id === current,
          builtin: pack.builtin,
        }))
      },
    },
    dispose() {
      if (disposed) return
      disposed = true
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
    },
  }
}
