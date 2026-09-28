export type ClientErrorReason = "Transport" | "UnexpectedStatus" | "UnsupportedContentType" | "MalformedResponse"

// eslint-disable-next-line effect/no-class-extends-error -- (c) public rejection class of the zero-Effect Promise root of @opencode-ai/client: consumers use instanceof, name, reason and cause, and promise.test.ts pins them
export class ClientError extends Error {
  override readonly name = "ClientError"
  readonly reason: ClientErrorReason

  constructor(reason: ClientErrorReason, options?: ErrorOptions) {
    super(reason, options)
    this.reason = reason
  }
}
