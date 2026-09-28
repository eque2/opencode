import type { Page } from "@playwright/test"
import { Schema } from "effect"

export type SseConnectionRecord = {
  id: number
  url: string
  path: "/global/event" | "/event" | "/api/event"
  headers: Record<string, string>
  openedAt: number
  endedAt?: number
  endedBy?: "close" | "disconnect" | "error" | "abort"
  error?: string
}

export type SseDeliveryAcknowledgement = {
  deliveryID: number
  connectionID: number
  bytes: number
  chunkCount: number
  deliveredAt: number
  eventID?: string
}

export type SseEventOptions = {
  id?: string
  event?: string
  retry?: number
  marker?: string
}

export type SseTransport<T> = {
  server: string
  waitForConnection(options?: { after?: number; timeout?: number }): Promise<SseConnectionRecord>
  send(payload: T, options?: SseEventOptions): Promise<SseDeliveryAcknowledgement>
  burst(payloads: readonly T[], options?: readonly SseEventOptions[]): Promise<SseDeliveryAcknowledgement[]>
  split(payload: T, cuts: readonly number[], options?: SseEventOptions): Promise<SseDeliveryAcknowledgement>
  heartbeat(options?: SseEventOptions): Promise<SseDeliveryAcknowledgement>
  writeRaw(value: string | Uint8Array, cuts?: readonly number[], marker?: string): Promise<SseDeliveryAcknowledgement>
  close(): Promise<void>
  disconnect(message?: string): Promise<void>
  error(message?: string): Promise<void>
  connections(): Promise<SseConnectionRecord[]>
  acknowledgements(): Promise<SseDeliveryAcknowledgement[]>
}

type BrowserCommand<T> =
  | { type: "send"; deliveries: { payload: T; options?: SseEventOptions }[]; burst: boolean; cuts?: number[] }
  | { type: "raw"; bytes: number[]; cuts?: number[]; marker?: string }
  | { type: "end"; mode: "close" | "disconnect" | "error"; message?: string }
  | { type: "connections" }
  | { type: "acknowledgements" }

type BrowserTransport = Window & {
  __testSseTransport?: {
    command: (command: BrowserCommand<unknown>) => unknown
    connections: () => SseConnectionRecord[]
  }
}

// Page results cross the Playwright boundary as plain JSON, so the Node side decodes them.
const Acknowledgement = Schema.Struct({
  deliveryID: Schema.Number,
  connectionID: Schema.Number,
  bytes: Schema.Number,
  chunkCount: Schema.Number,
  deliveredAt: Schema.Number,
  eventID: Schema.optionalKey(Schema.String),
})

const ConnectionRecord = Schema.Struct({
  id: Schema.Number,
  url: Schema.String,
  path: Schema.Literals(["/global/event", "/event", "/api/event"]),
  headers: Schema.Record(Schema.String, Schema.String),
  openedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  endedBy: Schema.optionalKey(Schema.Literals(["close", "disconnect", "error", "abort"])),
  error: Schema.optionalKey(Schema.String),
})

const decodeAcknowledgement = Schema.decodeUnknownPromise(Acknowledgement)
const decodeAcknowledgements = Schema.decodeUnknownPromise(Schema.mutable(Schema.Array(Acknowledgement)))
const decodeConnections = Schema.decodeUnknownPromise(Schema.mutable(Schema.Array(ConnectionRecord)))

export async function installSseTransport<T>(
  page: Page,
  options: { server: string; retry?: number },
): Promise<SseTransport<T>> {
  const server = new URL(options.server).origin
  await page.addInitScript(
    ({ server, retry }) => {
      type Connection = SseConnectionRecord & { controller: ReadableStreamDefaultController<Uint8Array> }
      type ProbeWindow = Window & {
        __visualStabilityProbe?: { startedAt: number; markers: { at: number; label: string }[] }
      }
      const originalFetch = window.fetch.bind(window)
      const connections: Connection[] = []
      const acknowledgements: SseDeliveryAcknowledgement[] = []
      const encoder = new TextEncoder()
      let nextConnectionID = 0
      let nextDeliveryID = 0

      const current = () => connections.findLast((connection) => connection.endedAt === undefined)
      const records = () => connections.map(({ controller: _controller, ...connection }) => connection)
      const isEventPath = (path: string): path is SseConnectionRecord["path"] =>
        path === "/global/event" || path === "/event" || path === "/api/event"
      const chunks = (bytes: Uint8Array, cuts?: readonly number[]) => {
        const boundaries = [...new Set(cuts ?? [])]
          .filter((cut) => Number.isInteger(cut) && cut > 0 && cut < bytes.byteLength)
          .sort((a, b) => a - b)
        return [0, ...boundaries].map((start, index) => bytes.slice(start, boundaries[index] ?? bytes.byteLength))
      }
      const marker = (label?: string) => {
        if (!label) return
        const probe = (window as ProbeWindow).__visualStabilityProbe
        if (!probe) return
        probe.markers.push({ at: performance.now() - probe.startedAt, label })
      }
      const frame = (payload: unknown, eventOptions: SseEventOptions = {}) =>
        [
          eventOptions.event === undefined ? "" : `event: ${eventOptions.event}\n`,
          eventOptions.id === undefined ? "" : `id: ${eventOptions.id}\n`,
          eventOptions.retry === undefined ? "" : `retry: ${eventOptions.retry}\n`,
          `data: ${JSON.stringify(payload)}\n\n`,
        ].join("")
      const currentEvent = (input: unknown) => {
        if (!input || typeof input !== "object" || !("payload" in input)) return input
        const envelope = input as { directory?: string; payload?: unknown }
        if (!envelope.payload || typeof envelope.payload !== "object") return input
        const payload = envelope.payload as { id?: string; type?: string; properties?: unknown }
        if (!payload.type) return input
        return {
          id: payload.id ?? `evt_mock_${Date.now()}`,
          created: Date.now(),
          type: payload.type,
          data: payload.properties ?? {},
          location:
            envelope.directory && envelope.directory !== "global" ? { directory: envelope.directory } : undefined,
        }
      }
      const acknowledge = (
        connection: Connection,
        bytes: number,
        chunkCount: number,
        eventID?: string,
      ): SseDeliveryAcknowledgement => {
        const acknowledgement = {
          deliveryID: ++nextDeliveryID,
          connectionID: connection.id,
          bytes,
          chunkCount,
          deliveredAt: performance.now(),
          ...(eventID === undefined ? {} : { eventID }),
        }
        acknowledgements.push(acknowledgement)
        return acknowledgement
      }
      const end = (mode: "close" | "disconnect" | "error", message?: string) => {
        const connection = current()
        if (!connection) throw new Error("SSE transport has no active connection")
        connection.endedAt = performance.now()
        connection.endedBy = mode
        if (message) connection.error = message
        if (mode === "close") {
          connection.controller.close()
          return
        }
        const error = new DOMException(
          message ?? "SSE connection disconnected",
          mode === "error" ? "Error" : "NetworkError",
        )
        connection.controller.error(error)
      }

      const command = (input: BrowserCommand<unknown>) => {
        if (input.type === "connections") return records()
        if (input.type === "acknowledgements") return acknowledgements
        if (input.type === "end") return end(input.mode, input.message)
        const connection = current()
        if (!connection) throw new Error("SSE transport has no active connection")
        if (input.type === "raw") {
          marker(input.marker)
          const output = chunks(new Uint8Array(input.bytes), input.cuts)
          output.forEach((chunk) => connection.controller.enqueue(chunk))
          return acknowledge(connection, input.bytes.length, output.length)
        }
        const encoded = input.deliveries.map((delivery) => {
          const payload = connection.path === "/api/event" ? currentEvent(delivery.payload) : delivery.payload
          return { delivery, payload, bytes: encoder.encode(frame(payload, delivery.options)) }
        })
        encoded.forEach((item) => marker(item.delivery.options?.marker))
        if (input.burst) {
          const bytes = encoder.encode(encoded.map((item) => frame(item.payload, item.delivery.options)).join(""))
          connection.controller.enqueue(bytes)
          return encoded.map((item) => acknowledge(connection, item.bytes.byteLength, 1, item.delivery.options?.id))
        }
        const output = chunks(encoded[0].bytes, input.cuts)
        output.forEach((chunk) => connection.controller.enqueue(chunk))
        return acknowledge(connection, encoded[0].bytes.byteLength, output.length, encoded[0].delivery.options?.id)
      }

      ;(window as BrowserTransport).__testSseTransport = { command, connections: records }
      const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        const path = url.pathname
        if (url.origin !== server || !isEventPath(path)) return originalFetch(request)

        const id = ++nextConnectionID
        const headers = Object.fromEntries(request.headers.entries())
        const openedAt = performance.now()
        // ReadableStream calls start() synchronously, so cancel() always sees the record.
        let record: Connection | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const connection: Connection = { id, url: url.href, path, headers, openedAt, controller }
            record = connection
            connections.push(connection)
            if (retry !== undefined) controller.enqueue(encoder.encode(`retry: ${retry}\n\n`))
            if (url.pathname === "/api/event")
              controller.enqueue(
                encoder.encode(frame({ id: `evt_mock_connected_${id}`, type: "server.connected", data: {} })),
              )
            if (url.pathname === "/global/event")
              controller.enqueue(
                encoder.encode(
                  frame({
                    payload: { id: `evt_mock_connected_${id}`, type: "server.connected", properties: {} },
                  }),
                ),
              )
            request.signal.addEventListener(
              "abort",
              () => {
                if (connection.endedAt !== undefined) return
                connection.endedAt = performance.now()
                connection.endedBy = "abort"
                controller.error(request.signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
              },
              { once: true },
            )
          },
          cancel() {
            if (!record || record.endedAt !== undefined) return
            record.endedAt = performance.now()
            record.endedBy = "disconnect"
          },
        })
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: {
              "cache-control": "no-cache",
              "content-type": "text/event-stream",
            },
          }),
        )
      }
      Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: fetch })
    },
    { server, retry: options.retry },
  )

  const command = (input: BrowserCommand<unknown>) =>
    page.evaluate((input) => {
      const transport = (window as BrowserTransport).__testSseTransport
      if (!transport) throw new Error("SSE transport was not installed before page load")
      return transport.command(input)
    }, input)

  return {
    server,
    async waitForConnection(input = {}) {
      const connection = await page.waitForFunction(
        (after) => {
          const transport = (window as BrowserTransport).__testSseTransport
          const connections = transport?.connections()
          return connections?.findLast((connection) => connection.id > after && connection.endedAt === undefined)
        },
        input.after ?? 0,
        { timeout: input.timeout },
      )
      let result: SseConnectionRecord | undefined
      try {
        result = await connection.jsonValue()
      } finally {
        await connection.dispose()
      }
      if (!result) throw new Error("SSE transport connection disappeared while waiting")
      return result
    },
    send(payload, eventOptions) {
      return command({ type: "send", deliveries: [{ payload, options: eventOptions }], burst: false }).then(
        decodeAcknowledgement,
      )
    },
    burst(payloads, eventOptions = []) {
      return command({
        type: "send",
        deliveries: payloads.map((payload, index) => ({ payload, options: eventOptions[index] })),
        burst: true,
      }).then(decodeAcknowledgements)
    },
    split(payload, cuts, eventOptions) {
      return command({
        type: "send",
        deliveries: [{ payload, options: eventOptions }],
        burst: false,
        cuts: [...cuts],
      }).then(decodeAcknowledgement)
    },
    heartbeat(eventOptions) {
      return command({
        type: "send",
        deliveries: [
          {
            payload: { directory: "global", payload: { type: "server.heartbeat", properties: {} } },
            options: eventOptions,
          },
        ],
        burst: false,
      }).then(decodeAcknowledgement)
    },
    writeRaw(value, cuts, marker) {
      return command({
        type: "raw",
        bytes: Array.from(typeof value === "string" ? new TextEncoder().encode(value) : value),
        cuts: cuts ? [...cuts] : undefined,
        marker,
      }).then(decodeAcknowledgement)
    },
    async close() {
      await command({ type: "end", mode: "close" })
    },
    async disconnect(message) {
      await command({ type: "end", mode: "disconnect", message })
    },
    async error(message) {
      await command({ type: "end", mode: "error", message })
    },
    connections() {
      return command({ type: "connections" }).then(decodeConnections)
    },
    acknowledgements() {
      return command({ type: "acknowledgements" }).then(decodeAcknowledgements)
    },
  }
}
