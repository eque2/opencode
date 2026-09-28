import { test, expect } from "bun:test"
import {
  formatImportFileError,
  parseShareUrl,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Option, PlatformError } from "effect"

test("formats import file errors", () => {
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("File not found: test.json")
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("Failed to read file: Permission denied")
  expect(
    formatImportFileError(
      "test.json",
      new FSUtil.FileSystemError({ method: "readJson", cause: new SyntaxError("Unexpected token") }),
    ),
  ).toBe("Invalid JSON in test.json: Unexpected token")
})

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toEqual(Option.some("Jsj3hNIW"))
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toEqual(Option.some("abc123"))
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toEqual(Option.some("test_id-123"))
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toEqual(Option.none()) // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toEqual(Option.none())
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toEqual(Option.none())
  expect(parseShareUrl("not-a-url")).toEqual(Option.none())
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } },
    { type: "message", data: { id: SessionV1.MessageID.make("msg-1"), sessionID: "sess-1" } },
    { type: "part", data: { id: "part-1", messageID: SessionV1.MessageID.make("msg-1") } },
    { type: "part", data: { id: "part-2", messageID: SessionV1.MessageID.make("msg-1") } },
  ]

  const result = Option.getOrThrow(transformShareData(data))

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns none for invalid share data", () => {
  expect(transformShareData([])).toEqual(Option.none())
  expect(transformShareData([{ type: "message", data: { id: SessionV1.MessageID.make("msg-1") } }])).toEqual(
    Option.none(),
  ) // no session
  expect(transformShareData([{ type: "session", data: { id: "s" } }])).toEqual(Option.none()) // no messages
})
