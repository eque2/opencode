import { Data, Deferred, Effect, Iterable, MutableHashMap, MutableHashSet, Option, Result } from "effect"
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

// Completed from the worker's onmessage handler with the reply for one request.
type Reply<A> = Deferred.Deferred<A, MarkdownWorkerError>

type HighlightPending = {
  key: string
  complete: boolean
  reply: Reply<MarkdownWorkerState>
}

type ProjectPending = {
  key: string
  reply: Reply<Projection>
}

type ParsePending = {
  reply: Reply<string>
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
    if (Option.isSome(result)) reject(result.value.reply, supersededError())
  },
})
const projectTransport = createWorkerTransport<Extract<MarkdownWorkerRequest, { type: "project" }>>({
  post: (request) => post(request),
  supersede: (request) => {
    const result = take(projects, request.id)
    if (Option.isSome(result)) reject(result.value.reply, supersededError())
  },
})

// The request functions below post their request at once, when they are called, so request IDs
// follow the call order. The returned Effect only waits for the worker's reply.

export function parseMarkdown(text: string): Effect.Effect<string, MarkdownWorkerError> {
  const instance = getWorker()
  if (Result.isFailure(instance)) return Effect.fail(instance.failure)
  const id = ++nextID
  const reply = Deferred.makeUnsafe<string, MarkdownWorkerError>()
  MutableHashMap.set(parses, id, { reply })
  instance.success.postMessage({ type: "parse", id, text } satisfies MarkdownWorkerRequest)
  return Deferred.await(reply)
}

export function projectMarkdown(
  key: string,
  text: string,
  live: boolean,
): Effect.Effect<Projection, MarkdownWorkerError> {
  const instance = getWorker()
  if (Result.isFailure(instance)) return Effect.fail(instance.failure)
  const id = ++nextID
  const reply = Deferred.makeUnsafe<Projection, MarkdownWorkerError>()
  MutableHashMap.set(projects, id, { key, reply })
  projectTransport.send({ type: "project", id, key, text, live })
  return Deferred.await(reply)
}

export function disposeMarkdownProjection(key: string) {
  projectTransport.dispose(key)
  for (const [id, request] of Array.from(projects)) {
    if (request.key !== key) continue
    MutableHashMap.remove(projects, id)
    reject(request.reply, disposedError())
  }
  post({ type: "dispose", key })
}

export function highlightStreamingCode(
  key: string,
  text: string,
  language: string,
  complete = false,
): Effect.Effect<MarkdownWorkerState, MarkdownWorkerError> {
  const instance = getWorker()
  if (Result.isFailure(instance)) return Effect.fail(instance.failure)
  const id = ++nextID
  MutableHashMap.set(latest, key, id)
  MutableHashSet.remove(keys, key)
  MutableHashSet.add(keys, key)
  // Evict the oldest key. MutableHashSet keeps insertion order for string keys.
  const oldest = MutableHashSet.size(keys) > 200 ? Iterable.head(keys) : Option.none()
  if (Option.isSome(oldest)) disposeStreamingCode(oldest.value)
  const reply = Deferred.makeUnsafe<MarkdownWorkerState, MarkdownWorkerError>()
  MutableHashMap.set(pending, id, { key, complete, reply })
  transport.send({ type: "highlight", id, key, text, language, complete })
  return Deferred.await(reply)
}

export function disposeStreamingCode(key: string) {
  MutableHashSet.remove(keys, key)
  MutableHashMap.remove(latest, key)
  MutableHashMap.remove(states, key)
  transport.dispose(key)
  for (const [id, request] of Array.from(pending)) {
    if (request.key !== key) continue
    MutableHashMap.remove(pending, id)
    reject(request.reply, disposedError())
  }
  post({ type: "dispose", key })
}

function post(request: MarkdownWorkerRequest) {
  if (Option.isSome(worker)) worker.value.postMessage(request)
}

function getWorker(): Result.Result<Worker, MarkdownWorkerUnavailableError> {
  if (Option.isSome(worker)) return Result.succeed(worker.value)
  if (Option.isSome(disabled)) return Result.fail(new MarkdownWorkerUnavailableError({ message: disabled.value }))
  const created = Result.try(() => new Worker(MarkdownWorkerUrl, { type: "module" }))
  if (Result.isFailure(created)) {
    const cause = created.failure
    const message = cause instanceof Error ? cause.message : String(cause)
    disabled = Option.some(message)
    return Result.fail(new MarkdownWorkerUnavailableError({ message, cause }))
  }
  const instance = created.success
  worker = Option.some(instance)
  instance.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => receive(event.data)
  instance.onerror = (event) => fail(event.message || "Markdown highlighting worker failed")
  instance.onmessageerror = () => fail("Markdown worker response failed")
  return Result.succeed(instance)
}

function receive(response: MarkdownWorkerResponse) {
  if (response.type === "parse") {
    const result = take(parses, response.id)
    if (Option.isSome(result)) resolve(result.value.reply, response.html)
    return
  }
  if (response.type === "project") {
    const result = take(projects, response.id)
    if (Option.isSome(result)) resolve(result.value.reply, response.projection)
    projectTransport.complete(response.key, response.id)
    return
  }
  if (response.type === "error") {
    const parsed = take(parses, response.id)
    if (Option.isSome(parsed)) {
      reject(parsed.value.reply, new MarkdownWorkerFailedError({ message: response.message }))
      return
    }
    const projected = take(projects, response.id)
    if (Option.isSome(projected)) {
      reject(projected.value.reply, new MarkdownWorkerFailedError({ message: response.message }))
      projectTransport.complete(projected.value.key, response.id)
      return
    }
  }
  if (response.type === "superseded") {
    const projected = take(projects, response.id)
    if (Option.isSome(projected)) {
      reject(projected.value.reply, supersededError())
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
    reject(result.value.reply, disposedError())
    transport.complete(key, response.id)
    return
  }
  if (response.type === "superseded") {
    reject(result.value.reply, supersededError())
    transport.complete(key, response.id)
    return
  }
  if (response.type === "error") {
    reject(result.value.reply, new MarkdownWorkerFailedError({ message: response.message }))
    transport.complete(key, response.id)
    return
  }
  const state = applyMarkdownWorkerResponse(MutableHashMap.get(states, key), response)
  if (shouldReleaseMarkdownWorkerState(result.value.complete, MutableHashMap.get(latest, key), response.id)) {
    MutableHashMap.remove(states, key)
    MutableHashSet.remove(keys, key)
    MutableHashMap.remove(latest, key)
  } else MutableHashMap.set(states, key, state)
  resolve(result.value.reply, state)
  transport.complete(key, response.id)
}

// Disables the worker and fails every pending request with the same error.
function fail(message: string) {
  const error = new MarkdownWorkerFailedError({ message })
  disabled = Option.some(message)
  transport.reset()
  projectTransport.reset()
  for (const request of MutableHashMap.values(pending)) reject(request.reply, error)
  for (const request of MutableHashMap.values(projects)) reject(request.reply, error)
  for (const request of MutableHashMap.values(parses)) reject(request.reply, error)
  MutableHashMap.clear(pending)
  MutableHashMap.clear(projects)
  MutableHashMap.clear(parses)
  MutableHashMap.clear(states)
  MutableHashSet.clear(keys)
  MutableHashMap.clear(latest)
  if (Option.isSome(worker)) worker.value.terminate()
  worker = Option.none()
}

function resolve<A>(reply: Reply<A>, value: A) {
  Deferred.doneUnsafe(reply, Effect.succeed(value))
}

function reject<A>(reply: Reply<A>, error: MarkdownWorkerError) {
  Deferred.doneUnsafe(reply, Effect.fail(error))
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
