import { expect, test } from "bun:test"
import { createDesktopDraftStore } from "./draft-store"

test("flushes the latest buffered draft and stores blobs", () => {
  const store = createDesktopDraftStore(":memory:")
  store.set("prompt", "first")
  store.set("prompt", "latest")
  expect(store.get("prompt")).toBe("latest")
  store.flush()
  expect(store.get("prompt")).toBe("latest")

  const bytes = new TextEncoder().encode("image")
  const id = store.putBlob(bytes)
  expect(store.getBlob(id)).toEqual(bytes)
  store.close()
})

test("deletes a buffered and a flushed draft", () => {
  const store = createDesktopDraftStore(":memory:")
  store.set("prompt", "text")
  store.delete("prompt")
  expect(store.get("prompt")).toBeNull()
  store.set("prompt", "text")
  store.flush()
  store.delete("prompt")
  store.flush()
  expect(store.get("prompt")).toBeNull()
  store.close()
})
