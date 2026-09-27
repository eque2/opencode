// Low-level OpenAI Responses WebSocket protocol helpers. Session pooling,
// fallback, and continuation state intentionally live above this file.

import WebSocket from "ws"
import { APICallError } from "ai"
import { Effect, Fiber, Option, Predicate, Schema } from "effect"
import { ProviderError } from "@/provider/error"
import { errorMessage } from "@/util/error"
import { ProxyEnv } from "@/util/proxy-env"
import { isRecord } from "@/util/record"

export const PROTOCOL_HEADER = "responses_websockets=2026-02-06"
export const MESSAGE_TOO_BIG_CLOSE_CODE = 1009

export class WebSocketConnectError extends Schema.TaggedError<WebSocketConnectError>()("OpenAIWebSocket.ConnectError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ConnectResponsesWebSocketOptions {
  url: string
  headers: Record<string, string>
  timeout?: number
  signal?: AbortSignal
}

// The socket surface that streamResponsesWebSocket drives. A connected ws WebSocket satisfies it.
export interface ResponsesSocket {
  readonly url: string
  on(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  once(event: "close", listener: (code: number, reason: Buffer) => void): unknown
  off(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): unknown
  off(event: "error", listener: (error: Error) => void): unknown
  off(event: "close", listener: (code: number, reason: Buffer) => void): unknown
  send(data: string, callback: (error?: Error) => void): void
  terminate(): void
}

export interface StreamResponsesWebSocketOptions {
  socket: ResponsesSocket
  body: Record<string, unknown>
  idleTimeout?: number
  signal?: AbortSignal
  onFirstEvent?: (error?: WrappedError) => void
  onComplete?: (event: Record<string, unknown>) => void
  onTerminal?: (event: Record<string, unknown>) => void
  // Some yields a replacement socket for the same request; None keeps the error frame as the terminal event.
  onRetryableTerminal?: (event: Record<string, unknown>) => Effect.Effect<Option.Option<ResponsesSocket>, Error>
  onConnectionInvalid?: (error: ProviderError.ResponseStreamError, closeCode?: number) => void
  onAbort?: (error: Error) => void
}

export interface WrappedError {
  status: number
  headers?: Record<string, string>
  body: string
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export function toWebSocketUrl(url: string) {
  return url.replace(/^http/, "ws")
}

export function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value
    })
    return result
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key.toLowerCase()] = value
    }
    return result
  }

  for (const [key, value] of Object.entries(headers)) {
    if (Predicate.isNotNullish(value)) result[key.toLowerCase()] = value
  }
  return result
}

export function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError"
}

// Reads a text frame. ws delivers text frames as a Buffer unless the socket changes its binaryType.
export function messageText(data: WebSocket.RawData) {
  if (Buffer.isBuffer(data)) return data.toString()
  if (Array.isArray(data)) return Buffer.concat(data).toString()
  return Buffer.from(data).toString()
}

export function connectResponsesWebSocket(options: ConnectResponsesWebSocketOptions) {
  const connect = Effect.callback<WebSocket, WebSocketConnectError | DOMException>((resume) => {
    if (options.signal?.aborted) {
      resume(Effect.fail(abortError(options.signal)))
      return Effect.void
    }

    const headers: Record<string, string> = {
      ...options.headers,
      "openai-beta": options.headers["openai-beta"] ?? PROTOCOL_HEADER,
    }
    delete headers["content-length"]

    // Bun does not apply HTTP(S)_PROXY to WebSockets unless the proxy is supplied explicitly.
    const proxy =
      typeof Bun === "undefined"
        ? Option.none<string>()
        : Option.fromNullishOr(
            ProxyEnv.getProxyForUrl(options.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")),
          ).pipe(Option.filter((value) => value !== ""))
    const socket = new WebSocket(options.url, {
      headers,
      ...Option.match(proxy, { onNone: () => ({}), onSome: (value) => ({ proxy: value }) }),
    })

    function cleanup() {
      socket.off("open", onOpen)
      socket.off("error", onError)
      socket.off("close", onClose)
      options.signal?.removeEventListener("abort", onAbort)
    }

    function terminate() {
      cleanup()
      socket.on("error", () => {})
      socket.terminate()
    }

    function onOpen() {
      cleanup()
      resume(Effect.succeed(socket))
    }

    function onError(error: unknown) {
      socket.on("error", () => {})
      cleanup()
      resume(Effect.fail(new WebSocketConnectError({ message: errorMessage(error), cause: error })))
    }

    function onClose(code: number, reason: Buffer) {
      cleanup()
      resume(
        Effect.fail(new WebSocketConnectError({ message: closeMessage("WebSocket closed before open", code, reason) })),
      )
    }

    function onAbort() {
      terminate()
      resume(Effect.fail(abortError(options.signal)))
    }

    socket.once("open", onOpen)
    socket.once("error", onError)
    socket.once("close", onClose)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    // Interruption (the connect timeout) abandons the handshake.
    return Effect.sync(terminate)
  })

  if (!options.timeout) return connect
  return connect.pipe(
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () => Effect.fail(new WebSocketConnectError({ message: "WebSocket connect timed out" })),
    }),
  )
}

export function streamResponsesWebSocket(options: StreamResponsesWebSocketOptions) {
  const encoder = new TextEncoder()

  let socket = options.socket
  let controller = Option.none<ReadableStreamDefaultController<Uint8Array>>()
  let cleanupSocket = () => {}
  let completed = false
  let emitted = false
  let idleTimer = Option.none<Fiber.Fiber<void>>()

  function clearIdleTimer() {
    if (Option.isSome(idleTimer)) Effect.runFork(Fiber.interrupt(idleTimer.value))
    idleTimer = Option.none()
  }

  function cleanup() {
    clearIdleTimer()
    cleanupSocket()
    options.signal?.removeEventListener("abort", onAbort)
  }

  function terminateSocket(target = socket) {
    target.on("error", () => {})
    target.terminate()
  }

  function closeCompleted() {
    cleanup()
    if (Option.isNone(controller)) return
    controller.value.enqueue(encoder.encode("data: [DONE]\n\n"))
    controller.value.close()
  }

  function failStream(error: unknown) {
    if (Option.isSome(controller)) controller.value.error(error)
  }

  function invalidate(error: ProviderError.ResponseStreamError, closeCode?: number) {
    if (completed) return
    completed = true
    cleanup()
    options.onConnectionInvalid?.(error, closeCode)
    failStream(error)
  }

  function resetIdleTimeout(message: string) {
    if (completed) return
    const timeout = options.idleTimeout
    if (!timeout) return
    clearIdleTimer()
    idleTimer = Option.some(
      Effect.runFork(
        Effect.sleep(timeout).pipe(
          Effect.andThen(Effect.sync(() => invalidate(new ProviderError.ResponseStreamError(message)))),
        ),
      ),
    )
  }

  function onMessage(data: WebSocket.RawData, isBinary: boolean) {
    if (completed) return
    if (isBinary) {
      invalidate(new ProviderError.ResponseStreamError("Unexpected binary WebSocket frame"))
      return
    }

    const text = messageText(data)
    const event = decodeJson(text).pipe(Option.filter(isRecord))
    const retry = options.onRetryableTerminal

    if (retry && Option.isSome(event) && event.value.type === "error") {
      cleanupSocket()
      clearIdleTimer()
      Effect.runFork(
        retry(event.value).pipe(
          Effect.match({
            onFailure: (error) => invalidate(new ProviderError.ResponseStreamError(error.message, { cause: error })),
            onSuccess: (next) => {
              if (completed) {
                if (Option.isSome(next)) terminateSocket(next.value)
                return
              }
              if (Option.isSome(next)) {
                attach(next.value)
                return
              }
              handleEvent(event, text)
            },
          }),
        ),
      )
      return
    }

    handleEvent(event, text)
  }

  function handleEvent(event: Option.Option<Record<string, unknown>>, text: string) {
    if (Option.isSome(event)) {
      const wrappedError = parseWrappedError(event.value, text)
      if (Option.isSome(wrappedError)) {
        if (!emitted) options.onFirstEvent?.(wrappedError.value)
        completed = true
        cleanup()
        options.onTerminal?.(event.value)
        failStream(
          new APICallError({
            message: wrappedError.value.message,
            url: socket.url,
            requestBodyValues: options.body,
            statusCode: wrappedError.value.status,
            responseHeaders: wrappedError.value.headers,
            responseBody: wrappedError.value.body,
          }),
        )
        return
      }
    }

    if (!emitted) options.onFirstEvent?.()
    if (Option.isSome(controller)) {
      controller.value.enqueue(
        encoder.encode(
          `${text
            .split(/\r?\n/)
            .map((line) => `data: ${line}`)
            .join("\n")}\n\n`,
        ),
      )
    }
    emitted = true
    resetIdleTimeout("idle timeout waiting for websocket")

    if (Option.isNone(event)) return
    const type = event.value.type

    if (type === "response.completed" || type === "response.done") {
      completed = true
      options.onComplete?.(event.value)
      options.onTerminal?.(event.value)
      closeCompleted()
      return
    }

    if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      completed = true
      options.onTerminal?.(event.value)
      closeCompleted()
    }
  }

  function onError(error: Error) {
    invalidate(new ProviderError.ResponseStreamError(error.message, { cause: error }))
  }

  function onClose(code: number, reason: Buffer) {
    if (completed) return
    invalidate(
      new ProviderError.ResponseStreamError(closeMessage("WebSocket closed before response.completed", code, reason)),
      code,
    )
  }

  function onAbort() {
    const error = abortError(options.signal)
    if (completed) return
    completed = true
    cleanup()
    terminateSocket()
    options.onAbort?.(error)
    failStream(error)
  }

  function onCancel(reason: unknown) {
    if (completed) return
    completed = true
    cleanup()
    terminateSocket()
    options.onAbort?.(cancelError(reason))
  }

  function attach(next: ResponsesSocket) {
    cleanupSocket()
    socket = next
    socket.on("message", onMessage)
    socket.once("error", onError)
    socket.once("close", onClose)
    cleanupSocket = () => {
      socket.off("message", onMessage)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    const { stream: _stream, background: _background, ...payload } = options.body
    resetIdleTimeout("idle timeout sending websocket request")
    socket.send(encodeJson({ type: "response.create", ...payload }), (error) => {
      if (completed) return
      resetIdleTimeout("idle timeout waiting for websocket")
      if (error) invalidate(new ProviderError.ResponseStreamError(error.message, { cause: error }))
    })
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      start(next) {
        controller = Option.some(next)
        options.signal?.addEventListener("abort", onAbort, { once: true })

        if (options.signal?.aborted) {
          onAbort()
          return
        }

        attach(socket)
      },
      cancel(reason) {
        onCancel(reason)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function parseWrappedError(event: Record<string, unknown>, body: string) {
  if (event.type !== "error") return Option.none()
  const status = event.status ?? event.status_code
  if (typeof status !== "number" || (status >= 200 && status < 300)) return Option.none()
  return Option.some({
    status,
    ...(isRecord(event.headers)
      ? {
          headers: Object.fromEntries(
            Object.entries(event.headers).flatMap(([key, value]) =>
              typeof value === "string" || typeof value === "number" || typeof value === "boolean"
                ? [[key, String(value)]]
                : [],
            ),
          ),
        }
      : {}),
    body,
    message: isRecord(event.error) && typeof event.error.message === "string" ? event.error.message : `${status}`,
  })
}

function cancelError(reason: unknown) {
  if (isAbortError(reason)) return reason
  if (reason instanceof Error) return reason
  return new DOMException(typeof reason === "string" ? reason : "Aborted", "AbortError")
}

function abortError(signal: AbortSignal | undefined) {
  const reason = signal?.reason
  if (isAbortError(reason)) return reason
  return new DOMException(reason instanceof Error ? reason.message : "Aborted", "AbortError")
}

function closeMessage(message: string, code: number, reason: Buffer) {
  const details = [
    `code ${code}`,
    ...(code === MESSAGE_TOO_BIG_CLOSE_CODE ? ["message too big"] : []),
    ...(reason.length > 0 ? [reason.toString()] : []),
  ]
  return `${message} (${details.join(": ")})`
}

export * as OpenAIWebSocket from "./ws"
