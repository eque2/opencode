import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Audio, type AudioErrorContext, type AudioPlayOptions, type AudioSound, type AudioVoice } from "@opentui/core"
import { Effect, FileSystem, MutableHashMap, Option, Result } from "effect"

// None until the first use. Some(None) records that the engine failed to start,
// so it is not tried again until dispose.
let audio: Option.Option<Option.Option<Audio>> = Option.none()
const sounds = MutableHashMap.empty<string, Promise<Option.Option<AudioSound>>>()
const filesystem = LayerNode.compile(LayerNodePlatform.filesystem)

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

/**
 * Decode a sound file. Resolves null when no engine is available or the file
 * does not decode.
 */
export function loadSoundFile(file: string): Promise<AudioSound | null> {
  return Effect.runPromise(Effect.map(loadSound(file), Option.getOrNull))
}

// The first request for a file starts its decode, and later requests share the
// result, so a file decodes once until dispose clears the cache.
function loadSound(file: string): Effect.Effect<Option.Option<AudioSound>> {
  const current = getAudio()
  if (Option.isNone(current)) return Effect.succeedNone
  const cached = MutableHashMap.get(sounds, file)
  if (Option.isSome(cached)) return Effect.promise(() => cached.value)
  const task = Effect.runPromise(decodeSound(current.value, file))
  MutableHashMap.set(sounds, file, task)
  return Effect.promise(() => task)
}

const decodeSound = (current: Audio, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bytes = yield* fs.readFile(file)
    return Option.fromNullishOr(yield* Effect.try(() => current.loadSound(bytes)))
  }).pipe(
    Effect.provide(filesystem),
    Effect.catch((error) => Effect.logDebug("failed to load tui sound", { file, error }).pipe(Effect.as(Option.none()))),
  )

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
