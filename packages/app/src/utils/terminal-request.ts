import { Data, Effect } from "effect"

/** A PTY request to the server rejected. `cause` holds the original rejection. */
export class TerminalRequestError extends Data.TaggedError("App.TerminalRequestError")<{ readonly cause: unknown }> {}

/** Runs one SDK PTY request and keeps its rejection as a TerminalRequestError. */
export const terminalRequest = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new TerminalRequestError({ cause }) })
