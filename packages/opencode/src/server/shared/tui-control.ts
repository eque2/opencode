import { AsyncQueue } from "@/util/queue"
import { Schema } from "effect"

export const TuiRequest = Schema.Struct({
  path: Schema.String,
  // eslint-disable-next-line effect/no-schema-any-unknown -- (b) foreign value domain: an opaque request body relayed to the TUI as is
  body: Schema.Unknown,
}).annotate({ description: "Request that the server sends to the TUI" })

export type TuiRequest = Schema.Schema.Type<typeof TuiRequest>

const request = new AsyncQueue<TuiRequest>()
const response = new AsyncQueue<unknown>()

export function nextTuiRequest() {
  return request.next()
}

export function submitTuiRequest(body: TuiRequest) {
  request.push(body)
}

export function submitTuiResponse(body: unknown) {
  response.push(body)
}

export function nextTuiResponse() {
  return response.next()
}
