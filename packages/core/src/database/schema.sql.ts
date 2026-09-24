import { DateTime } from "effect"
import { integer } from "drizzle-orm/sqlite-core"

export const Timestamps = {
  time_created: integer()
    .notNull()
    .$default(() => DateTime.toEpochMillis(DateTime.nowUnsafe())),
  time_updated: integer()
    .notNull()
    .$onUpdate(() => DateTime.toEpochMillis(DateTime.nowUnsafe())),
}
