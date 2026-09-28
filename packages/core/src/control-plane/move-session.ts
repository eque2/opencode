export * as MoveSession from "./move-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Git } from "../git"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { SessionV2 } from "../session"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { AbsolutePath, RelativePath } from "../schema"
import path from "path"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export class DestinationProjectMismatchError extends Schema.TaggedError<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}

export class ApplyChangesError extends Schema.TaggedError<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedError<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedError<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type Error =
  | SessionV2.NotFoundError
  | DestinationProjectMismatchError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlPlaneMoveSession") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2.Service
    const project = yield* ProjectV2.Service
    const sessions = yield* SessionStore.Service

    const captureChanges = Effect.fn("MoveSession.captureChanges")(function* (directory: AbsolutePath) {
      const repository = yield* git.repo.discover(directory)
      if (!repository) return yield* new CaptureChangesError({ message: "Source is not a Git repository" })
      return yield* git.change
        .capture({ repository, path: directory })
        .pipe(Effect.mapError((error) => new CaptureChangesError({ message: error.message })))
    })

    const resetSourceChanges = Effect.fn("MoveSession.resetSourceChanges")(function* (directory: AbsolutePath) {
      const repository = yield* git.repo.discover(directory)
      if (!repository)
        return yield* new ResetSourceChangesError({
          directory,
          message: "Source is not a Git repository",
        })
      return yield* git.change
        .discard({
          repository,
          path: directory,
          index: "preserve",
          untracked: "remove",
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ResetSourceChangesError({
                directory,
                message: error.message,
                cause: error.cause,
              }),
          ),
        )
    })

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* sessions.get(input.sessionID)
      if (!current) return yield* new SessionV2.NotFoundError({ sessionID: input.sessionID })
      const directory = AbsolutePath.make(input.destination.directory)
      if (current.location.directory === directory) return yield* Effect.void

      const source = yield* project.resolve(current.location.directory)
      const destination = yield* project.resolve(directory)
      if (current.projectID !== destination.id) {
        return yield* new DestinationProjectMismatchError({ expected: current.projectID, actual: destination.id })
      }

      const moveChanges = input.moveChanges && source.directory !== destination.directory
      const patch = moveChanges ? yield* captureChanges(current.location.directory) : Git.ChangeSet.make("")
      if (patch) {
        const repository = yield* git.repo.discover(directory)
        if (!repository) return yield* new ApplyChangesError({ message: "Destination is not a Git repository" })
        yield* git.change
          .apply({ repository, path: directory, changes: patch })
          .pipe(Effect.mapError((error) => new ApplyChangesError({ message: error.message })))
      }

      yield* events.publish(SessionEvent.Moved, {
        sessionID: input.sessionID,
        location: Location.Ref.make({ directory }),
        subdirectory: RelativePath.make(path.relative(destination.directory, directory).replaceAll("\\", "/")),
        timestamp: yield* DateTime.now,
      })

      return yield* patch ? resetSourceChanges(current.location.directory) : Effect.void
    })

    return Service.of({ moveSession })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Git.node, EventV2.node, ProjectV2.node, SessionStore.node],
})
