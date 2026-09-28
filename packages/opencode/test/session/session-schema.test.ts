import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { isRecord } from "@/util/record"

const info = {
  id: SessionID.descending(),
  slug: "test-session",
  projectID: ProjectV2.ID.global,
  workspaceID: undefined,
  directory: "/tmp/opencode",
  parentID: undefined,
  summary: undefined,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  share: undefined,
  title: "Test session",
  version: "1.0.0",
  time: {
    created: 1,
    updated: 2,
    compacting: undefined,
    archived: undefined,
  },
  permission: undefined,
  revert: undefined,
} satisfies Session.Info

// Encoded values are untyped JSON objects; fail the test when one is not an object.
function record(value: unknown): Record<string, unknown> {
  expect(isRecord(value)).toBe(true)
  return isRecord(value) ? value : {}
}

describe("Session schema", () => {
  test("encodes undefined optional session fields as omitted keys", () => {
    const encoded = record(Schema.encodeUnknownSync(Session.Info)(info))

    for (const key of ["workspaceID", "parentID", "summary", "share", "permission", "revert"]) {
      expect(Object.hasOwn(encoded, key)).toBe(false)
    }
    expect(Object.hasOwn(record(encoded.time), "compacting")).toBe(false)
    expect(Object.hasOwn(record(encoded.time), "archived")).toBe(false)
    expect(JSON.stringify(encoded)).not.toContain("parentID")
  })

  test("encodes undefined optional global session project fields as omitted keys", () => {
    const encoded = record(
      Schema.encodeUnknownSync(Session.GlobalInfo)({
        ...info,
        project: {
          id: ProjectV2.ID.global,
          name: undefined,
          worktree: "/tmp/opencode",
        },
      }),
    )

    expect(Object.hasOwn(encoded, "parentID")).toBe(false)
    expect(Object.hasOwn(record(encoded.project), "name")).toBe(false)
  })

  test("encodes nested undefined optional session fields as omitted keys", () => {
    const encoded = record(
      Schema.encodeUnknownSync(Session.Info)({
        ...info,
        summary: {
          additions: 1,
          deletions: 2,
          files: 3,
          diffs: undefined,
        },
        revert: {
          messageID: MessageID.ascending(),
          partID: undefined,
          snapshot: undefined,
          diff: undefined,
        },
      }),
    )

    expect(Object.hasOwn(record(encoded.summary), "diffs")).toBe(false)
    for (const key of ["partID", "snapshot", "diff"]) {
      expect(Object.hasOwn(record(encoded.revert), key)).toBe(false)
    }
  })
})
