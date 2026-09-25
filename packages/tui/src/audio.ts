import { Audio, type AudioErrorContext, type AudioPlayOptions, type AudioSound, type AudioVoice } from "@opentui/core"
import { Effect, MutableHashMap, Option, Result } from "effect"
import { readFile } from "node:fs/promises"

// None until the first use. Some(None) records that the engine failed to start,
// so it is not tried again until dispose.
let audio: Option.Option<Option.Option<Audio>> = Option.none()
const sounds = MutableHashMap.empty<string, Promise<AudioSound | null>>()

function getAudio(): Option.Option<Audio> {
  if (Option.isSome(audio)) return audio.value
  const created = Result.try(() => {
    const next = Audio.create({ autoStart: false })
    next.on("error", (error: Error, context: AudioErrorContext) => logDebug("tui audio error", { error, context }))
    return next
  })
  if (Result.isFailure(created)) logDebug("failed to create tui audio", { error: created.failure })
  const next = Result.getSuccess(created)
  audio = Option.some(next)
  return next
}

// Engine callbacks and the synchronous exports run outside any fiber, so each log runs in its own.
function logDebug(message: string, data: Record<string, unknown>) {
  Effect.runFork(Effect.logDebug(message, data))
}

export function loadSoundFile(file: string) {
  const current = getAudio()
  if (Option.isNone(current)) return Promise.resolve(null)
  const cached = MutableHashMap.get(sounds, file)
  if (Option.isSome(cached)) return cached.value
  const task = readFile(file)
    .then((bytes) => current.value.loadSound(bytes))
    .catch((error) => {
      console.debug("failed to load tui sound", { file, error })
      return null
    })
  MutableHashMap.set(sounds, file, task)
  return task
}

/**
 * Play a loaded sound. Returns null when no engine is available, the engine
 * does not start, or the engine does not play the sound.
 */
export function play(sound: AudioSound, options?: AudioPlayOptions): AudioVoice | null {
  return getAudio().pipe(
    Option.filter((current) => current.isStarted() || current.start()),
    Option.flatMapNullishOr((current) => current.play(sound, options)),
    Option.getOrNull,
  )
}

export function stopVoice(voice: AudioVoice) {
  return Option.exists(Option.flatten(audio), (current) => current.stopVoice(voice))
}

export function dispose() {
  const current = Option.flatten(audio)
  if (Option.isSome(current)) current.value.dispose()
  audio = Option.none()
  MutableHashMap.clear(sounds)
}
