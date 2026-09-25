import { Data, Effect, HashMap, MutableHashMap, Option } from "effect"

/** A bundled sound file whose dynamic import failed. */
class SoundLoadError extends Data.TaggedError("App.SoundLoadError")<{ readonly cause: unknown }> {}

let files: Record<string, () => Promise<string>> | undefined
let loads: HashMap.HashMap<string, () => Promise<string>> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob<string>("../../../ui/src/assets/audio/*.aac", { import: "default" })
  return files
}

export const SOUND_OPTIONS = [
  { id: "alert-01", label: "sound.option.alert01" },
  { id: "alert-02", label: "sound.option.alert02" },
  { id: "alert-03", label: "sound.option.alert03" },
  { id: "alert-04", label: "sound.option.alert04" },
  { id: "alert-05", label: "sound.option.alert05" },
  { id: "alert-06", label: "sound.option.alert06" },
  { id: "alert-07", label: "sound.option.alert07" },
  { id: "alert-08", label: "sound.option.alert08" },
  { id: "alert-09", label: "sound.option.alert09" },
  { id: "alert-10", label: "sound.option.alert10" },
  { id: "bip-bop-01", label: "sound.option.bipbop01" },
  { id: "bip-bop-02", label: "sound.option.bipbop02" },
  { id: "bip-bop-03", label: "sound.option.bipbop03" },
  { id: "bip-bop-04", label: "sound.option.bipbop04" },
  { id: "bip-bop-05", label: "sound.option.bipbop05" },
  { id: "bip-bop-06", label: "sound.option.bipbop06" },
  { id: "bip-bop-07", label: "sound.option.bipbop07" },
  { id: "bip-bop-08", label: "sound.option.bipbop08" },
  { id: "bip-bop-09", label: "sound.option.bipbop09" },
  { id: "bip-bop-10", label: "sound.option.bipbop10" },
  { id: "staplebops-01", label: "sound.option.staplebops01" },
  { id: "staplebops-02", label: "sound.option.staplebops02" },
  { id: "staplebops-03", label: "sound.option.staplebops03" },
  { id: "staplebops-04", label: "sound.option.staplebops04" },
  { id: "staplebops-05", label: "sound.option.staplebops05" },
  { id: "staplebops-06", label: "sound.option.staplebops06" },
  { id: "staplebops-07", label: "sound.option.staplebops07" },
  { id: "nope-01", label: "sound.option.nope01" },
  { id: "nope-02", label: "sound.option.nope02" },
  { id: "nope-03", label: "sound.option.nope03" },
  { id: "nope-04", label: "sound.option.nope04" },
  { id: "nope-05", label: "sound.option.nope05" },
  { id: "nope-06", label: "sound.option.nope06" },
  { id: "nope-07", label: "sound.option.nope07" },
  { id: "nope-08", label: "sound.option.nope08" },
  { id: "nope-09", label: "sound.option.nope09" },
  { id: "nope-10", label: "sound.option.nope10" },
  { id: "nope-11", label: "sound.option.nope11" },
  { id: "nope-12", label: "sound.option.nope12" },
  { id: "yup-01", label: "sound.option.yup01" },
  { id: "yup-02", label: "sound.option.yup02" },
  { id: "yup-03", label: "sound.option.yup03" },
  { id: "yup-04", label: "sound.option.yup04" },
  { id: "yup-05", label: "sound.option.yup05" },
  { id: "yup-06", label: "sound.option.yup06" },
] as const

export type SoundOption = (typeof SOUND_OPTIONS)[number]
export type SoundID = SoundOption["id"]

function getLoads() {
  if (loads) return loads
  loads = HashMap.fromIterable(
    Object.entries(getFiles()).flatMap(([path, load]) => {
      const file = path.split("/").at(-1)
      if (!file) return []
      return [[file.replace(/\.aac$/, ""), load] as const]
    }),
  )
  return loads
}

// One shared load per sound. A failed load resolves to none and stays cached, as before.
const cache = MutableHashMap.empty<string, Promise<Option.Option<string>>>()

function cachedLoad(id: string, load: () => Promise<string>) {
  const hit = MutableHashMap.get(cache, id)
  if (Option.isSome(hit)) return hit.value
  const next = Effect.runPromise(
    Effect.tryPromise({ try: load, catch: (cause) => new SoundLoadError({ cause }) }).pipe(Effect.option),
  )
  MutableHashMap.set(cache, id, next)
  return next
}

// The bundled URL of a sound, or none for an empty or unknown id.
function soundSrcOption(id: string | undefined): Effect.Effect<Option.Option<string>> {
  if (!id) return Effect.succeedNone
  return Option.match(HashMap.get(getLoads(), id), {
    onNone: () => Effect.succeedNone,
    onSome: (load) => Effect.promise(() => cachedLoad(id, load)),
  })
}

export function soundSrc(id: string | undefined): Promise<string | undefined> {
  return Effect.runPromise(soundSrcOption(id).pipe(Effect.map(Option.getOrUndefined)))
}

// Starts a sound and gives its stop function, or none when the platform has no Audio.
function startSound(src: string): Option.Option<() => void> {
  if (typeof Audio === "undefined") return Option.none()
  const audio = new Audio(src)
  // runFork calls play() before it returns, so a user gesture still covers it. A blocked autoplay only stays silent.
  Effect.runFork(Effect.tryPromise(() => audio.play()).pipe(Effect.ignore))
  return Option.some(() => {
    audio.pause()
    audio.currentTime = 0
  })
}

export function playSound(src: string | undefined): (() => void) | undefined {
  if (!src) return undefined
  return Option.getOrUndefined(startSound(src))
}

export function playSoundById(id: string | undefined): Promise<(() => void) | undefined> {
  return Effect.runPromise(
    soundSrcOption(id).pipe(Effect.map((src) => Option.getOrUndefined(Option.flatMap(src, startSound)))),
  )
}
