import { DateTime } from "effect"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { ProviderV2 } from "../provider"
import { AbsolutePath, RelativePath } from "../schema"
import { WorkspaceV2 } from "../workspace"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

export function fromRow(row: typeof SessionTable.$inferSelect): SessionSchema.Info {
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(row.id),
    projectID: ProjectV2.ID.make(row.project_id),
    title: row.title,
    ...(row.parent_id ? { parentID: SessionSchema.ID.make(row.parent_id) } : {}),
    ...(row.agent ? { agent: AgentV2.ID.make(row.agent) } : {}),
    ...(row.model
      ? {
          model: {
            id: ModelV2.ID.make(row.model.id),
            providerID: ProviderV2.ID.make(row.model.providerID),
            variant: ModelV2.VariantID.make(row.model.variant ?? "default"),
          },
        }
      : {}),
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    location: Location.Ref.make({
      directory: AbsolutePath.make(row.directory),
      ...(row.workspace_id ? { workspaceID: WorkspaceV2.ID.make(row.workspace_id) } : {}),
    }),
    ...(row.path ? { subpath: RelativePath.make(row.path) } : {}),
    // The column holds a Revert.State; Info.make validates its message ID brand.
    ...(row.revert ? { revert: row.revert } : {}),
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      ...(row.time_archived ? { archived: DateTime.makeUnsafe(row.time_archived) } : {}),
    },
  })
}
