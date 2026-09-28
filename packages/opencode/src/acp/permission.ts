import type {
  AgentSideConnection,
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { applyPatch } from "diff"
import { exists, readText } from "@/util/filesystem"
import type { ACPSession } from "./session"
import { pendingToolCall, toLocations, type ToolInput } from "./tool"
import { Array as Arr, Deferred, Effect, MutableHashMap, Option, Predicate, Schema } from "effect"

type PermissionEvent = Extract<Event, { type: "permission.asked" }>
type Reply = "once" | "always" | "reject"
type Connection = Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>
type HandlerInput = {
  sdk: OpencodeClient
  connection: Connection
  session: ACPSession.Interface
}

export class PermissionBridgeError extends Schema.TaggedError<PermissionBridgeError>()("ACPPermissionBridgeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const permissionOptions: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

export class Handler {
  // Each session's latest permission marks the tail of that session's queue.
  private readonly queues = MutableHashMap.empty<string, Deferred.Deferred<void>>()

  constructor(private readonly input: HandlerInput) {}

  handle(event: PermissionEvent) {
    const queues = this.queues
    const sessionID = event.properties.sessionID
    const previous = MutableHashMap.get(queues, sessionID)
    const done = Deferred.makeUnsafe<void>()
    MutableHashMap.set(queues, sessionID, done)
    Effect.runFork(
      Option.match(previous, { onNone: () => Effect.void, onSome: Deferred.await }).pipe(
        Effect.andThen(processPermission(this.input, event)),
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.andThen(
            Effect.sync(() => {
              if (Option.contains(MutableHashMap.get(queues, sessionID), done)) MutableHashMap.remove(queues, sessionID)
            }),
            Deferred.completeWith(done, Effect.void),
          ),
        ),
      ),
    )
  }
}

const processPermission = Effect.fn("ACPPermission.process")(function* (input: HandlerInput, event: PermissionEvent) {
  const permission = event.properties
  const session = yield* input.session.tryGet(permission.sessionID)
  if (!session) return

  const connection = input.connection
  if (!connection.requestPermission) {
    yield* reply(input.sdk, permission.id, "reject", session.cwd)
    return
  }
  const requestPermission = connection.requestPermission.bind(connection)

  const toolCall = yield* permissionToolCall({
    toolCallId: permission.tool?.callID ?? permission.id,
    toolName: permission.permission,
    input: permission.metadata,
  })
  const result = yield* Effect.tryPromise({
    try: () => requestPermission({ sessionId: permission.sessionID, toolCall, options: permissionOptions }),
    catch: (cause) => new PermissionBridgeError({ message: "ACP client permission request failed", cause }),
  }).pipe(Effect.option)

  const selected = Option.match(result, { onNone: (): Reply => "reject", onSome: selectedReply })
  if (selected === "reject") {
    yield* reply(input.sdk, permission.id, "reject", session.cwd)
    return
  }

  if (permission.permission === "edit") {
    yield* writeProposedEdit(connection, session.id, permission.metadata).pipe(Effect.ignore)
  }

  yield* reply(input.sdk, permission.id, selected, session.cwd)
})

const reply = Effect.fn("ACPPermission.reply")(function* (
  sdk: OpencodeClient,
  requestID: string,
  reply: Reply,
  directory: string,
) {
  yield* Effect.tryPromise({
    try: () => sdk.permission.reply({ requestID, reply, directory }),
    catch: (cause) => new PermissionBridgeError({ message: "permission reply failed", cause }),
  })
})

const writeProposedEdit = Effect.fn("ACPPermission.writeProposedEdit")(function* (
  connection: Connection,
  sessionId: string,
  metadata: ToolInput,
) {
  const filepath = nonEmpty(stringValue(metadata.filepath))
  const diff = nonEmpty(stringValue(metadata.diff))
  const writeTextFile = connection.writeTextFile?.bind(connection)
  if (Option.isNone(filepath) || Option.isNone(diff) || !writeTextFile) return

  const patched = yield* patchFile(filepath.value, diff.value)
  if (Option.isNone(patched)) return

  // The client write is fire-and-forget: the permission reply must not wait for it.
  yield* Effect.forkDetach(
    Effect.tryPromise({
      try: () => writeTextFile({ sessionId, path: filepath.value, content: patched.value.newText }),
      catch: (cause) => new PermissionBridgeError({ message: "ACP client write failed", cause }),
    }).pipe(Effect.ignore),
    { startImmediately: true },
  )
})

const permissionToolCall = Effect.fn("ACPPermission.permissionToolCall")(function* (input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: ToolInput
}) {
  const toolCall = pendingToolCall({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    state: {
      input: input.input,
      title: Option.getOrUndefined(permissionTitle(input.toolName, input.input)),
    },
  })
  const content = yield* permissionContent(input.toolName, input.input)
  const update: ToolCallUpdate = {
    ...toolCall,
    locations: permissionLocations(input.toolName, input.input),
    ...(content.length ? { content } : {}),
  }
  return update
})

function permissionTitle(toolName: string, input: ToolInput): Option.Option<string> {
  const tool = toolName.toLocaleLowerCase()
  switch (tool) {
    case "external_directory":
      return Option.firstSomeOf([
        stringValue(input.description),
        stringValue(input.command),
        stringValue(input.parentDir),
      ])

    case "webfetch":
      return stringValue(input.url)

    case "websearch":
      return stringValue(input.query)

    case "grep":
    case "glob":
      return stringValue(input.pattern)

    case "read":
    case "edit":
    case "write":
      return editTitle(input)

    default:
      return Option.none()
  }
}

function editTitle(input: ToolInput): Option.Option<string> {
  const files = fileMetadata(input)
  const [first] = files
  if (files.length === 1 && first) return Option.some(Option.getOrElse(first.relativePath, () => first.filePath))
  if (files.length > 1) return Option.some(`${files.length} files`)
  return Option.firstSomeOf([stringValue(input.filePath), stringValue(input.filepath), stringValue(input.path)])
}

function permissionLocations(toolName: string, input: ToolInput): ToolCallLocation[] {
  const files = fileMetadata(input)
  if (files.length) {
    return Arr.dedupe(
      files.flatMap((file) => [file.filePath, ...Option.toArray(file.movePath)].filter((path) => path.length > 0)),
    ).map((path) => ({ path }))
  }
  return toLocations(toolName, input)
}

const permissionContent = Effect.fn("ACPPermission.permissionContent")(function* (toolName: string, input: ToolInput) {
  if (toolName.toLocaleLowerCase() !== "edit") return []

  const files = fileMetadata(input)
  if (files.length) return yield* diffContentForFiles(files)

  const filepath = nonEmpty(Option.orElse(stringValue(input.filepath), () => stringValue(input.filePath)))
  const diff = nonEmpty(stringValue(input.diff))
  if (Option.isNone(filepath) || Option.isNone(diff)) return []
  return Option.toArray(yield* patchFile(filepath.value, diff.value))
})

function diffContentForFiles(files: PermissionFileMetadata[]) {
  return Effect.forEach(
    files,
    (file) =>
      Option.match(nonEmpty(file.patch), {
        onNone: () => Effect.succeed(Option.none<DiffContent>()),
        onSome: (patch) =>
          patchFile(
            file.filePath,
            patch,
            Option.getOrElse(file.movePath, () => file.filePath),
          ),
      }),
    { concurrency: "unbounded" },
  ).pipe(Effect.map(Arr.getSomes))
}

type DiffContent = Extract<ToolCallContent, { type: "diff" }>

const patchFile = Effect.fn("ACPPermission.patchFile")(function* (
  filepath: string,
  diff: string,
  displayPath: string = filepath,
) {
  const present = yield* Effect.tryPromise({
    try: () => exists(filepath),
    catch: (cause) => new PermissionBridgeError({ message: `failed to check ${filepath}`, cause }),
  })
  const content = present
    ? yield* Effect.tryPromise({
        try: () => readText(filepath),
        catch: (cause) => new PermissionBridgeError({ message: `failed to read ${filepath}`, cause }),
      })
    : ""
  const next = yield* Effect.try({
    try: () => applyPatch(content, diff),
    catch: (cause) => new PermissionBridgeError({ message: `failed to apply patch to ${filepath}`, cause }),
  })
  if (next === false) return Option.none<DiffContent>()
  return Option.some<DiffContent>({
    type: "diff",
    path: displayPath,
    oldText: content,
    newText: next,
  })
})

function selectedReply(result: RequestPermissionResponse): Reply {
  if (result.outcome.outcome !== "selected") return "reject"
  if (result.outcome.optionId === "once" || result.outcome.optionId === "always") return result.outcome.optionId
  return "reject"
}

function stringValue(value: unknown): Option.Option<string> {
  return Option.liftPredicate(value, Predicate.isString)
}

function nonEmpty(value: Option.Option<string>) {
  return Option.filter(value, (text) => text.length > 0)
}

type PermissionFileMetadata = {
  readonly filePath: string
  readonly relativePath: Option.Option<string>
  readonly movePath: Option.Option<string>
  readonly patch: Option.Option<string>
}

function stringField(value: unknown, key: string): Option.Option<string> {
  return Predicate.hasProperty(value, key) ? stringValue(value[key]) : Option.none()
}

function fileMetadata(input: ToolInput): PermissionFileMetadata[] {
  if (!Array.isArray(input.files)) return []
  return input.files.flatMap((file: unknown): PermissionFileMetadata[] =>
    Option.match(nonEmpty(stringField(file, "filePath")), {
      onNone: () => [],
      onSome: (filePath) => [
        {
          filePath,
          relativePath: stringField(file, "relativePath"),
          movePath: stringField(file, "movePath"),
          patch: stringField(file, "patch"),
        },
      ],
    }),
  )
}

export * as ACPPermission from "./permission"
