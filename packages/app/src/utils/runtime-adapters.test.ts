import { describe, expect, test } from "bun:test"
import { Chunk } from "effect"
import {
  disposeIfDisposable,
  getHoveredLinkText,
  getSpeechRecognitionCtor,
  hasSetOption,
  isDisposable,
  setOptionIfSupported,
} from "./runtime-adapters"

describe("runtime adapters", () => {
  test("detects and disposes disposable values", () => {
    let count = 0
    const value = {
      dispose: () => {
        count += 1
      },
    }
    expect(isDisposable(value)).toBe(true)
    disposeIfDisposable(value)
    expect(count).toBe(1)
  })

  test("ignores non-disposable values", () => {
    expect(isDisposable({ dispose: "nope" })).toBe(false)
    expect(() => disposeIfDisposable({ dispose: "nope" })).not.toThrow()
  })

  test("sets options only when setter exists", () => {
    let calls = Chunk.empty<[string, unknown]>()
    const value = {
      setOption: (key: string, next: unknown) => {
        calls = Chunk.append(calls, [key, next])
      },
    }
    expect(hasSetOption(value)).toBe(true)
    setOptionIfSupported(value, "fontFamily", "Berkeley Mono")
    expect(Chunk.toArray(calls)).toEqual([["fontFamily", "Berkeley Mono"]])
    expect(() => setOptionIfSupported({}, "fontFamily", "Berkeley Mono")).not.toThrow()
  })

  test("reads hovered link text safely", () => {
    expect(getHoveredLinkText({ currentHoveredLink: { text: "https://example.com" } })).toBe("https://example.com")
    expect(getHoveredLinkText({ currentHoveredLink: { text: 1 } })).toBeUndefined()
    // eslint-disable-next-line effect/no-null-use-option -- (b) probes the JavaScript null runtime value that the untyped terminal value can hold
    expect(getHoveredLinkText(null)).toBeUndefined()
  })

  test("resolves speech recognition constructor with webkit precedence", () => {
    function SpeechCtor() {}
    function WebkitCtor() {}
    const ctor = getSpeechRecognitionCtor({
      SpeechRecognition: SpeechCtor,
      webkitSpeechRecognition: WebkitCtor,
    })
    expect(ctor).toBe(WebkitCtor)
  })

  test("returns undefined when no valid speech constructor exists", () => {
    expect(getSpeechRecognitionCtor({ SpeechRecognition: "nope" })).toBeUndefined()
    expect(getSpeechRecognitionCtor(undefined)).toBeUndefined()
  })
})
