import { Schema } from "effect"

/**
 * A typed failure for test Effects, such as a timeout or an unexpected response status. It keeps
 * the message that the global Error carried and gives the failure channel a tag.
 */
export class TestFailure extends Schema.TaggedError<TestFailure>()("TestFailure", {
  message: Schema.String,
}) {}
