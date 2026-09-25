import { Data, Iterable, MutableHashMap, MutableHashSet, Option } from "effect"
import MarkdownWorkerUrl from "./markdown.worker.ts?worker&url"
import {
  applyMarkdownWorkerResponse,
  shouldReleaseMarkdownWorkerState,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
  type MarkdownWorkerState,
} from "./markdown-worker-protocol"
import { createWorkerTransport } from "./markdown-worker-transport"
import type { Projection } from "./markdown-stream"

/** The request's key was disposed before the worker answered. */
export class MarkdownWorkerDisposedError extends Data.TaggedError("MarkdownWorkerDisposedError")<{
  readonly message: string
}> {}

/** A newer request for the same key replaced this request. */
export class MarkdownWorkerSupersededError extends Data.TaggedError("MarkdownWorkerSupersededError")<{
  readonly message: string
}> {}

/** The worker could not start, or an earlier failure disabled it. */
export class MarkdownWorkerUnavailableError extends Data.TaggedError("MarkdownWorkerUnavailableError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** The worker reported an error for the request, or it failed while the request was pending. */
export class MarkdownWorkerFailedError extends Data.TaggedError("MarkdownWorkerFailedError")<{
  readonly message: string
}> {}

export type MarkdownWorkerError =
  | MarkdownWorkerDisposedError
  | MarkdownWorkerSupersededError
  | MarkdownWorkerUnavailableError
  | MarkdownWorkerFailedError

type HighlightPending = {
  key: string
  complete: boolean
  resolve: (state: MarkdownWorkerState) => void
  reject: (error: MarkdownWorkerError) => void
}

type ProjectPending = {
  key: string
  resolve: (projection: Projection) => void
  reject: (error: MarkdownWorkerError) => void
}

type ParsePending = {
  resolve: (html: string) => void
  reject: (error: MarkdownWorkerError) => void
}

let worker: Option.Option<Worker> = Option.none()
// The message of the failure that disabled the worker.
let disabled: Option.Option<string> = Option.none()
let nextID = 0
const pending = MutableHashMap.empty<number, HighlightPending>()
const projects = MutableHashMap.empty<number, ProjectPending>()
const parses = MutableHashMap.empty<number, ParsePending>()
const states = MutableHashMap.empty<string, MarkdownWorkerState>()
const keys = MutableHashSet.empty<string>()
const latest = MutableHashMap.empty<string, number>()
const transport = createWorkerTransport<Extract<MarkdownWorkerRequest, { type: "highlight" }>>({
  post: (request) => post(request),
  supersede: (request) => {
    const result = take(pending, request.id)
    if (Option.isSome(result)) result.value.reject(supersededError())
  },
})
const projectTransport = createWorkerTransport<Extract<MarkdownWorkerRequest, { type: "project" }>>({
  post: (request) => post(request),
  supersede: (request) => {
    const result = take(projects, request.id)
    if (Option.isSome(result)) result.value.reject(supersededError())
  },
})

export function parseMarkdown(text: string) {
  const instance = getWorker()
  const id = ++nextID
  return new Promise<string>((resolve, reject) => {
    MutableHashMap.set(parses, id, { resolve, reject })
    instance.postMessage({ type: "parse", id, text } satisfies MarkdownWorkerRequest)
  })
}

export function projectMarkdown(key: string, text: string, live: boolean) {
  getWorker()
  const id = ++nextID
  return new Promise<Projection>((resolve, reject) => {
    MutableHashMap.set(projects, id, { key, resolve, reject })
    projectTransport.send({ type: "project", id, key, text, live })
  })
}

export function disposeMarkdownProjection(key: string) {
  projectTransport.dispose(key)
  for (const [id, request] of Array.from(projects)) {
    if (request.key !== key) continue
    MutableHashMap.remove(projects, id)
    request.reject(disposedError())
  }
  post({ type: "dispose", key })
}

export function highlightStreamingCode(key: string, text: string, language: string, complete = false) {
  const instance = getWorker()
  const id = ++nextID
  MutableHashMap.set(latest, key, id)
  MutableHashSet.remove(keys, key)
  MutableHashSet.add(keys, key)
  // Evict the oldest key. MutableHashSet keeps insertion order for string keys.
  const oldest = MutableHashSet.size(keys) > 200 ? Iterable.head(keys) : Option.none()
  if (Option.isSome(oldest)) disposeStreamingCode(oldest.value)
  return new Promise<MarkdownWorkerState>((resolve, reject) => {
    MutableHashMap.set(pending, id, { key, complete, resolve, reject })
    transport.send({ type: "highlight", id, key, text, language, complete })
  })
}

export function disposeStreamingCode(key: string) {
  MutableHashSet.remove(keys, key)
  MutableHashMap.remove(latest, key)
  MutableHashMap.remove(states, key)
  transport.dispose(key)
  for (const [id, request] of Array.from(pending)) {
    if (request.key !== key) continue
    MutableHashMap.remove(pending, id)
    request.reject(disposedError())
  }
  post({ type: "dispose", key })
}

function post(request: MarkdownWorkerRequest) {
  if (Option.isSome(worker)) worker.value.postMessage(request)
}

function getWorker() {
  if (Option.isSome(worker)) return worker.value
  if (Option.isSome(disabled)) throw new MarkdownWorkerUnavailableError({ message: disabled.value })
  let instance: Worker
  try {
    instance = new Worker(MarkdownWorkerUrl, { type: "module" })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    disabled = Option.some(message)
    throw new MarkdownWorkerUnavailableError({ message, cause: error })
  }
  worker = Option.some(instance)
  instance.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
    const response = event.data
    if (response.type === "parse") {
      const result = take(parses, response.id)
      if (Option.isSome(result)) result.value.resolve(response.html)
      return
    }
    if (response.type === "project") {
      const result = take(projects, response.id)
      if (Option.isSome(result)) result.value.resolve(response.projection)
      projectTransport.complete(response.key, response.id)
      return
    }
    if (response.type === "error") {
      const parsed = take(parses, response.id)
      if (Option.isSome(parsed)) {
        parsed.value.reject(new MarkdownWorkerFailedError({ message: response.message }))
        return
      }
      const projected = take(projects, response.id)
      if (Option.isSome(projected)) {
        projected.value.reject(new MarkdownWorkerFailedError({ message: response.message }))
        projectTransport.complete(projected.value.key, response.id)
        return
      }
    }
    if (response.type === "superseded") {
      const projected = take(projects, response.id)
      if (Option.isSome(projected)) {
        projected.value.reject(supersededError())
        projectTransport.complete(projected.value.key, response.id)
        return
      }
    }
    const key = response.key
    if (!key) return
    const result = take(pending, response.id)
    if (Option.isNone(result)) {
      transport.complete(key, response.id)
      return
    }
    if (!MutableHashSet.has(keys, key)) {
      result.value.reject(disposedError())
      transport.complete(key, response.id)
      return
    }
    if (response.type === "superseded") {
      result.value.reject(supersededError())
      transport.complete(key, response.id)
      return
    }
    if (response.type === "error") {
      result.value.reject(new MarkdownWorkerFailedError({ message: response.message }))
      transport.complete(key, response.id)
      return
    }
    const state = applyMarkdownWorkerResponse(MutableHashMap.get(states, key), response)
    if (shouldReleaseMarkdownWorkerState(result.value.complete, MutableHashMap.get(latest, key), response.id)) {
      MutableHashMap.remove(states, key)
      MutableHashSet.remove(keys, key)
      MutableHashMap.remove(latest, key)
    } else MutableHashMap.set(states, key, state)
    result.value.resolve(state)
    transport.complete(key, response.id)
  }
  const fail = (message: string) => {
    const error = new MarkdownWorkerFailedError({ message })
    disabled = Option.some(message)
    transport.reset()
    projectTransport.reset()
    for (const request of MutableHashMap.values(pending)) request.reject(error)
    for (const request of MutableHashMap.values(projects)) request.reject(error)
    for (const request of MutableHashMap.values(parses)) request.reject(error)
    MutableHashMap.clear(pending)
    MutableHashMap.clear(projects)
    MutableHashMap.clear(parses)
    MutableHashMap.clear(states)
    MutableHashSet.clear(keys)
    MutableHashMap.clear(latest)
    if (Option.isSome(worker)) worker.value.terminate()
    worker = Option.none()
  }
  instance.onerror = (event) => fail(event.message || "Markdown highlighting worker failed")
  instance.onmessageerror = () => fail("Markdown worker response failed")
  return instance
}

// Reads and removes one entry, as the old get-then-delete did.
function take<K, V>(map: MutableHashMap.MutableHashMap<K, V>, key: K): Option.Option<V> {
  const value = MutableHashMap.get(map, key)
  MutableHashMap.remove(map, key)
  return value
}

function disposedError() {
  return new MarkdownWorkerDisposedError({ message: "Markdown worker request was disposed" })
}

function supersededError() {
  return new MarkdownWorkerSupersededError({ message: "Markdown worker request was superseded" })
}
