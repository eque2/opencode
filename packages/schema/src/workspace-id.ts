import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

export const WorkspaceID = Schema.String.check(Schema.isStartsWith("wrk")).pipe(
  Schema.brand("WorkspaceV2.ID"),
  statics((schema) => {
    const create = () => schema.make("wrk_" + ascending())
    return {
      // schema.make enforces the "wrk" prefix check and fails on any other ID.
      ascending: (id?: string) => (id ? schema.make(id) : create()),
      create,
    }
  }),
)
export type WorkspaceID = typeof WorkspaceID.Type
