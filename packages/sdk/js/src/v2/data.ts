import type { Part, UserMessage } from "./client.js"

/**
 * Omits keys from each member of a union, so every member keeps its own fields.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export const message = {
  user(
    input: Omit<UserMessage, "role" | "time" | "id"> & {
      parts: DistributiveOmit<Part, "id" | "sessionID" | "messageID">[]
    },
  ): {
    info: UserMessage
    parts: Part[]
  } {
    const { parts: _parts, ...rest } = input

    const info: UserMessage = {
      ...rest,
      id: "asdasd",
      time: {
        created: Date.now(),
      },
      role: "user",
    }

    return {
      info,
      parts: input.parts.map(
        (part): Part => ({
          ...part,
          id: "asdasd",
          messageID: info.id,
          sessionID: info.sessionID,
        }),
      ),
    }
  },
}
