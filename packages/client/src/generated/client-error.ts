export type ClientErrorReason = "Transport" | "UnexpectedStatus" | "UnsupportedContentType" | "MalformedResponse"

export class ClientError extends Error {
  override readonly name = "ClientError"
  readonly reason: ClientErrorReason

  constructor(reason: ClientErrorReason, options?: ErrorOptions) {
    super(reason, options)
    this.reason = reason
  }
}
