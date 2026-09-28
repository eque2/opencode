import { Context, Option } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"

export const InstanceRef = Context.Reference<Option.Option<InstanceContext>>("~opencode/InstanceRef", {
  defaultValue: () => Option.none(),
})

export const WorkspaceRef = Context.Reference<Option.Option<WorkspaceV2.ID>>("~opencode/WorkspaceRef", {
  defaultValue: () => Option.none(),
})
