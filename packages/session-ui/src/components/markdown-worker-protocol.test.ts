import { expect, test } from "bun:test"
import { Option } from "effect"
import {
  applyMarkdownWorkerResponse,
  markdownBlockKey,
  shouldReleaseMarkdownWorkerState,
} from "./markdown-worker-protocol"

const token = (content: string): [string, string] => [content, ""]
const response = (id: number, reset: boolean, stable: [string, string][], unstable: [string, string][]) => ({
  type: "highlight" as const,
  id,
  key: "code",
  language: "typescript",
  reset,
  stable,
  unstable,
})

test("accumulates stable worker tokens and replaces the unstable tail", () => {
  const first = applyMarkdownWorkerResponse(Option.none(), {
    type: "highlight",
    id: 1,
    key: "code",
    language: "typescript",
    reset: true,
    stable: [token("one\n")],
    unstable: [token("tw")],
  })
  const second = applyMarkdownWorkerResponse(Option.some(first), {
    type: "highlight",
    id: 2,
    key: "code",
    language: "typescript",
    reset: false,
    stable: [token("two\n")],
    unstable: [token("three")],
  })

  expect(second.stable.map((item) => item[0])).toEqual(["one\n", "two\n"])
  expect(second.unstable.map((item) => item[0])).toEqual(["three"])
  expect(second.language).toBe("typescript")
})

test("increments generation only when the worker resets token identity", () => {
  const first = applyMarkdownWorkerResponse(Option.none(), response(1, true, [["const", ""]], []))
  const append = applyMarkdownWorkerResponse(Option.some(first), response(2, false, [[" x", ""]], []))
  const replacement = applyMarkdownWorkerResponse(Option.some(append), response(3, true, [["let y", ""]], []))
  expect([first.generation, append.generation, replacement.generation]).toEqual([1, 1, 2])
})

test("ignores stale worker responses and resets replacement streams", () => {
  const current = { id: 2, generation: 1, language: "typescript", stable: [token("current")], unstable: [] }
  expect(
    applyMarkdownWorkerResponse(Option.some(current), {
      type: "highlight",
      id: 1,
      key: "code",
      language: "typescript",
      reset: false,
      stable: [token("stale")],
      unstable: [],
    }),
  ).toBe(current)

  expect(
    applyMarkdownWorkerResponse(Option.some(current), {
      type: "highlight",
      id: 3,
      key: "code",
      language: "typescript",
      reset: true,
      stable: [token("replacement")],
      unstable: [],
    }).stable.map((item) => item[0]),
  ).toEqual(["replacement"])
})

test("releases only the latest completed worker state", () => {
  expect(shouldReleaseMarkdownWorkerState(true, Option.some(4), 4)).toBe(true)
  expect(shouldReleaseMarkdownWorkerState(true, Option.some(5), 4)).toBe(false)
  expect(shouldReleaseMarkdownWorkerState(false, Option.some(4), 4)).toBe(false)
  expect(shouldReleaseMarkdownWorkerState(true, Option.none(), 4)).toBe(false)
})

test("prefixes pending and dispatched block keys with the component owner", () => {
  expect(markdownBlockKey("owner", Option.some("message"), 2, "code")).toBe("owner:message:2:code")
  expect(markdownBlockKey("owner", Option.none(), 2, "code")).toBe("owner:block:2")
  expect(markdownBlockKey("owner", Option.some(""), 2, "code")).toBe("owner:block:2")
})
