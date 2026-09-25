import type {
  HealthGetOutput,
  LocationGetInput,
  LocationGetOutput,
  AgentsListInput,
  AgentsListOutput,
  SessionsListInput,
  SessionsListOutput,
  SessionsCreateInput,
  SessionsCreateOutput,
  SessionsActiveOutput,
  SessionsGetInput,
  SessionsGetOutput,
  SessionsSwitchAgentInput,
  SessionsSwitchAgentOutput,
  SessionsSwitchModelInput,
  SessionsSwitchModelOutput,
  SessionsPromptInput,
  SessionsPromptOutput,
  SessionsCompactInput,
  SessionsCompactOutput,
  SessionsWaitInput,
  SessionsWaitOutput,
  SessionsStageInput,
  SessionsStageOutput,
  SessionsClearInput,
  SessionsClearOutput,
  SessionsCommitInput,
  SessionsCommitOutput,
  SessionsContextInput,
  SessionsContextOutput,
  SessionsHistoryInput,
  SessionsHistoryOutput,
  SessionsEventsInput,
  SessionsEventsOutput,
  SessionsInterruptInput,
  SessionsInterruptOutput,
  SessionsMessageInput,
  SessionsMessageOutput,
  MessagesListInput,
  MessagesListOutput,
  ModelsListInput,
  ModelsListOutput,
  ProvidersListInput,
  ProvidersListOutput,
  ProvidersGetInput,
  ProvidersGetOutput,
  IntegrationsListInput,
  IntegrationsListOutput,
  IntegrationsGetInput,
  IntegrationsGetOutput,
  IntegrationsConnectKeyInput,
  IntegrationsConnectKeyOutput,
  IntegrationsConnectOauthInput,
  IntegrationsConnectOauthOutput,
  IntegrationsAttemptStatusInput,
  IntegrationsAttemptStatusOutput,
  IntegrationsAttemptCompleteInput,
  IntegrationsAttemptCompleteOutput,
  IntegrationsAttemptCancelInput,
  IntegrationsAttemptCancelOutput,
  CredentialsUpdateInput,
  CredentialsUpdateOutput,
  CredentialsRemoveInput,
  CredentialsRemoveOutput,
  PermissionsListRequestsInput,
  PermissionsListRequestsOutput,
  PermissionsListSavedInput,
  PermissionsListSavedOutput,
  PermissionsRemoveSavedInput,
  PermissionsRemoveSavedOutput,
  PermissionsCreateInput,
  PermissionsCreateOutput,
  PermissionsListInput,
  PermissionsListOutput,
  PermissionsGetInput,
  PermissionsGetOutput,
  PermissionsReplyInput,
  PermissionsReplyOutput,
  FilesListInput,
  FilesListOutput,
  FilesFindInput,
  FilesFindOutput,
  CommandsListInput,
  CommandsListOutput,
  SkillsListInput,
  SkillsListOutput,
  EventsSubscribeOutput,
  PtysListInput,
  PtysListOutput,
  PtysCreateInput,
  PtysCreateOutput,
  PtysGetInput,
  PtysGetOutput,
  PtysUpdateInput,
  PtysUpdateOutput,
  PtysRemoveInput,
  PtysRemoveOutput,
  QuestionsListRequestsInput,
  QuestionsListRequestsOutput,
  QuestionsListInput,
  QuestionsListOutput,
  QuestionsReplyInput,
  QuestionsReplyOutput,
  QuestionsRejectInput,
  QuestionsRejectOutput,
  ReferencesListInput,
  ReferencesListOutput,
  ProjectCopiesCreateInput,
  ProjectCopiesCreateOutput,
  ProjectCopiesRemoveInput,
  ProjectCopiesRemoveOutput,
  ProjectCopiesRefreshInput,
  ProjectCopiesRefreshOutput,
} from "./types"
import { ClientError } from "./client-error"

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: HeadersInit
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: HeadersInit
}

interface RequestDescriptor {
  readonly method: string
  readonly path: string
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
  readonly body?: unknown
  readonly successStatus: number
  readonly declaredStatuses: ReadonlyArray<number>
}

export function make(options: ClientOptions) {
  const fetch = options.fetch ?? globalThis.fetch

  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    const url = new URL(descriptor.path, options.baseUrl)
    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)
    const headers = new Headers(options.headers)
    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
      if (isPrimitive(value)) headers.set(key, String(value))
    }
    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)
    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    return {
      url,
      init: {
        method: descriptor.method,
        signal: requestOptions?.signal,
        headers,
        ...(descriptor.body === undefined ? {} : { body: JSON.stringify(descriptor.body) }),
      } satisfies RequestInit,
    }
  }

  // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    try {
      const prepared = prepare(descriptor, requestOptions)
      // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
      return await fetch(prepared.url, prepared.init)
    } catch (cause) {
      // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
      throw new ClientError("Transport", { cause })
    }
  }

  // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {
    // eslint-disable-next-line effect/no-throw-use-effect, effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    if (descriptor.declaredStatuses.includes(response.status)) throw await json(response)
    // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    try {
      // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
      await response.body?.cancel()
    } catch {}
    // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  }

  // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {
    // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    const response = await execute(descriptor, requestOptions)
    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)
    // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    const body = await json(response)
    return body as A
  }

  // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
  const requestEmpty = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<void> => {
    // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    const response = await execute(descriptor, requestOptions)
    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)
    // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    try {
      // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
      await response.body?.cancel()
    } catch {}
  }

  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({
    // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    async *[Symbol.asyncIterator]() {
      // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
      const response = await execute(descriptor, requestOptions)
      // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)
      if (!isContentType(response, "text/event-stream")) {
        // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
        try {
          // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
          await response.body?.cancel()
        } catch {}
        // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
        throw new ClientError("UnsupportedContentType")
      }
      if (response.body === null) {
        // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
        throw new ClientError("MalformedResponse")
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
      try {
        while (true) {
          let next
          // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
          try {
            // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
            next = await reader.read()
          } catch (cause) {
            // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
            throw new ClientError("Transport", { cause })
          }
          buffer += decoder.decode(next.value, { stream: !next.done })
          // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
          if (buffer.length > 1_048_576) throw new ClientError("MalformedResponse")
          const trailingCarriageReturn = !next.done && buffer.endsWith("\r")
          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)
          buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
          if (trailingCarriageReturn) buffer += "\r"
          if (next.done && buffer !== "") buffer += "\n\n"
          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = block
              .split("\n")
              .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
              .join("\n")
            if (data !== "") {
              // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
              try {
                yield JSON.parse(data) as A
              } catch (cause) {
                // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
                throw new ClientError("MalformedResponse", { cause })
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
          if (next.done) return
        }
      } finally {
        // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
        try {
          // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
          await reader.cancel()
        } catch {}
        reader.releaseLock()
      }
    },
  })

  return {
    health: {
      get: (requestOptions?: RequestOptions) =>
        request<HealthGetOutput>(
          { method: "GET", path: `/api/health`, successStatus: 200, declaredStatuses: [401, 400] },
          requestOptions,
        ),
    },
    location: {
      get: (input?: LocationGetInput, requestOptions?: RequestOptions) =>
        request<LocationGetOutput>(
          {
            method: "GET",
            path: `/api/location`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
    },
    agents: {
      list: (input?: AgentsListInput, requestOptions?: RequestOptions) =>
        request<AgentsListOutput>(
          {
            method: "GET",
            path: `/api/agent`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
    },
    sessions: {
      list: (input?: SessionsListInput, requestOptions?: RequestOptions) =>
        request<SessionsListOutput>(
          {
            method: "GET",
            path: `/api/session`,
            query: {
              workspace: input?.["workspace"],
              limit: input?.["limit"],
              order: input?.["order"],
              search: input?.["search"],
              directory: input?.["directory"],
              project: input?.["project"],
              subpath: input?.["subpath"],
              cursor: input?.["cursor"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
          },
          requestOptions,
        ),
      create: (input?: SessionsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session`,
            body: {
              id: input?.["id"],
              agent: input?.["agent"],
              model: input?.["model"],
              location: input?.["location"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ).then((value) => value.data),
      active: (requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsActiveOutput }>(
          { method: "GET", path: `/api/session/active`, successStatus: 200, declaredStatuses: [401, 400] },
          requestOptions,
        ).then((value) => value.data),
      get: (input: SessionsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ).then((value) => value.data),
      switchAgent: (
        input: SessionsSwitchAgentInput,
        requestOptions?: RequestOptions,
      ): Promise<SessionsSwitchAgentOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/agent`,
            body: { agent: input["agent"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ),
      switchModel: (
        input: SessionsSwitchModelInput,
        requestOptions?: RequestOptions,
      ): Promise<SessionsSwitchModelOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/model`,
            body: { model: input["model"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ),
      prompt: (input: SessionsPromptInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsPromptOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/prompt`,
            body: { id: input["id"], prompt: input["prompt"], delivery: input["delivery"], resume: input["resume"] },
            successStatus: 200,
            declaredStatuses: [409, 404, 400, 401],
          },
          requestOptions,
        ).then((value) => value.data),
      compact: (input: SessionsCompactInput, requestOptions?: RequestOptions): Promise<SessionsCompactOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/compact`,
            successStatus: 204,
            declaredStatuses: [404, 503, 400, 401],
          },
          requestOptions,
        ),
      wait: (input: SessionsWaitInput, requestOptions?: RequestOptions): Promise<SessionsWaitOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/wait`,
            successStatus: 204,
            declaredStatuses: [404, 503, 400, 401],
          },
          requestOptions,
        ),
      stage: (input: SessionsStageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsStageOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/stage`,
            body: { messageID: input["messageID"], files: input["files"] },
            successStatus: 200,
            declaredStatuses: [404, 500, 400, 401],
          },
          requestOptions,
        ).then((value) => value.data),
      clear: (input: SessionsClearInput, requestOptions?: RequestOptions): Promise<SessionsClearOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/clear`,
            successStatus: 204,
            declaredStatuses: [404, 500, 400, 401],
          },
          requestOptions,
        ),
      commit: (input: SessionsCommitInput, requestOptions?: RequestOptions): Promise<SessionsCommitOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/commit`,
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ),
      context: (input: SessionsContextInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsContextOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/context`,
            successStatus: 200,
            declaredStatuses: [404, 500, 400, 401],
          },
          requestOptions,
        ).then((value) => value.data),
      history: (input: SessionsHistoryInput, requestOptions?: RequestOptions) =>
        request<SessionsHistoryOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/history`,
            query: { limit: input["limit"], after: input["after"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ),
      events: (input: SessionsEventsInput, requestOptions?: RequestOptions): AsyncIterable<SessionsEventsOutput> =>
        sse<SessionsEventsOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/event`,
            query: { after: input["after"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ),
      interrupt: (input: SessionsInterruptInput, requestOptions?: RequestOptions): Promise<SessionsInterruptOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/interrupt`,
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ),
      message: (input: SessionsMessageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsMessageOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ).then((value) => value.data),
    },
    messages: {
      list: (input: MessagesListInput, requestOptions?: RequestOptions) =>
        request<MessagesListOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message`,
            query: { limit: input["limit"], order: input["order"], cursor: input["cursor"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 500, 401],
          },
          requestOptions,
        ),
    },
    models: {
      list: (input?: ModelsListInput, requestOptions?: RequestOptions) =>
        request<ModelsListOutput>(
          {
            method: "GET",
            path: `/api/model`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
          },
          requestOptions,
        ),
    },
    providers: {
      list: (input?: ProvidersListInput, requestOptions?: RequestOptions) =>
        request<ProvidersListOutput>(
          {
            method: "GET",
            path: `/api/provider`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
          },
          requestOptions,
        ),
      get: (input: ProvidersGetInput, requestOptions?: RequestOptions) =>
        request<ProvidersGetOutput>(
          {
            method: "GET",
            path: `/api/provider/${encodeURIComponent(input.providerID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 503, 401, 400],
          },
          requestOptions,
        ),
    },
    integrations: {
      list: (input?: IntegrationsListInput, requestOptions?: RequestOptions) =>
        request<IntegrationsListOutput>(
          {
            method: "GET",
            path: `/api/integration`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      get: (input: IntegrationsGetInput, requestOptions?: RequestOptions) =>
        request<IntegrationsGetOutput>(
          {
            method: "GET",
            path: `/api/integration/${encodeURIComponent(input.integrationID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      connectKey: (
        input: IntegrationsConnectKeyInput,
        requestOptions?: RequestOptions,
      ): Promise<IntegrationsConnectKeyOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/key`,
            query: { location: input["location"] },
            body: { key: input["key"], label: input["label"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
          },
          requestOptions,
        ),
      connectOauth: (input: IntegrationsConnectOauthInput, requestOptions?: RequestOptions) =>
        request<IntegrationsConnectOauthOutput>(
          {
            method: "POST",
            path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth`,
            query: { location: input["location"] },
            body: { methodID: input["methodID"], inputs: input["inputs"], label: input["label"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
          },
          requestOptions,
        ),
      attemptStatus: (input: IntegrationsAttemptStatusInput, requestOptions?: RequestOptions) =>
        request<IntegrationsAttemptStatusOutput>(
          {
            method: "GET",
            path: `/api/integration/attempt/${encodeURIComponent(input.attemptID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      attemptComplete: (
        input: IntegrationsAttemptCompleteInput,
        requestOptions?: RequestOptions,
      ): Promise<IntegrationsAttemptCompleteOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/integration/attempt/${encodeURIComponent(input.attemptID)}/complete`,
            query: { location: input["location"] },
            body: { code: input["code"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
          },
          requestOptions,
        ),
      attemptCancel: (
        input: IntegrationsAttemptCancelInput,
        requestOptions?: RequestOptions,
      ): Promise<IntegrationsAttemptCancelOutput> =>
        requestEmpty(
          {
            method: "DELETE",
            path: `/api/integration/attempt/${encodeURIComponent(input.attemptID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
    },
    credentials: {
      update: (input: CredentialsUpdateInput, requestOptions?: RequestOptions): Promise<CredentialsUpdateOutput> =>
        requestEmpty(
          {
            method: "PATCH",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}`,
            query: { location: input["location"] },
            body: { label: input["label"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      remove: (input: CredentialsRemoveInput, requestOptions?: RequestOptions): Promise<CredentialsRemoveOutput> =>
        requestEmpty(
          {
            method: "DELETE",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
    },
    permissions: {
      listRequests: (input?: PermissionsListRequestsInput, requestOptions?: RequestOptions) =>
        request<PermissionsListRequestsOutput>(
          {
            method: "GET",
            path: `/api/permission/request`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      listSaved: (input?: PermissionsListSavedInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsListSavedOutput }>(
          {
            method: "GET",
            path: `/api/permission/saved`,
            query: { projectID: input?.["projectID"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ).then((value) => value.data),
      removeSaved: (
        input: PermissionsRemoveSavedInput,
        requestOptions?: RequestOptions,
      ): Promise<PermissionsRemoveSavedOutput> =>
        requestEmpty(
          {
            method: "DELETE",
            path: `/api/permission/saved/${encodeURIComponent(input.id)}`,
            successStatus: 204,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      create: (input: PermissionsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            body: {
              id: input["id"],
              action: input["action"],
              resources: input["resources"],
              save: input["save"],
              metadata: input["metadata"],
              source: input["source"],
              agent: input["agent"],
            },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: PermissionsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: PermissionsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: PermissionsReplyInput, requestOptions?: RequestOptions): Promise<PermissionsReplyOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}/reply`,
            body: { reply: input["reply"], message: input["message"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ),
    },
    files: {
      list: (input?: FilesListInput, requestOptions?: RequestOptions) =>
        request<FilesListOutput>(
          {
            method: "GET",
            path: `/api/fs/list`,
            query: { location: input?.["location"], path: input?.["path"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      find: (input: FilesFindInput, requestOptions?: RequestOptions) =>
        request<FilesFindOutput>(
          {
            method: "GET",
            path: `/api/fs/find`,
            query: { location: input["location"], query: input["query"], type: input["type"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
    },
    commands: {
      list: (input?: CommandsListInput, requestOptions?: RequestOptions) =>
        request<CommandsListOutput>(
          {
            method: "GET",
            path: `/api/command`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
    },
    skills: {
      list: (input?: SkillsListInput, requestOptions?: RequestOptions) =>
        request<SkillsListOutput>(
          {
            method: "GET",
            path: `/api/skill`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
    },
    events: {
      subscribe: (requestOptions?: RequestOptions): AsyncIterable<EventsSubscribeOutput> =>
        sse<EventsSubscribeOutput>(
          { method: "GET", path: `/api/event`, successStatus: 200, declaredStatuses: [401, 400] },
          requestOptions,
        ),
    },
    ptys: {
      list: (input?: PtysListInput, requestOptions?: RequestOptions) =>
        request<PtysListOutput>(
          {
            method: "GET",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      create: (input?: PtysCreateInput, requestOptions?: RequestOptions) =>
        request<PtysCreateOutput>(
          {
            method: "POST",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            body: {
              command: input?.["command"],
              args: input?.["args"],
              cwd: input?.["cwd"],
              title: input?.["title"],
              env: input?.["env"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      get: (input: PtysGetInput, requestOptions?: RequestOptions) =>
        request<PtysGetOutput>(
          {
            method: "GET",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
          },
          requestOptions,
        ),
      update: (input: PtysUpdateInput, requestOptions?: RequestOptions) =>
        request<PtysUpdateOutput>(
          {
            method: "PUT",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            body: { title: input["title"], size: input["size"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
          },
          requestOptions,
        ),
      remove: (input: PtysRemoveInput, requestOptions?: RequestOptions): Promise<PtysRemoveOutput> =>
        requestEmpty(
          {
            method: "DELETE",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
          },
          requestOptions,
        ),
    },
    questions: {
      listRequests: (input?: QuestionsListRequestsInput, requestOptions?: RequestOptions) =>
        request<QuestionsListRequestsOutput>(
          {
            method: "GET",
            path: `/api/question/request`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
      list: (input: QuestionsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: QuestionsListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/question`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: QuestionsReplyInput, requestOptions?: RequestOptions): Promise<QuestionsReplyOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}/reply`,
            body: { answers: input["answers"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ),
      reject: (input: QuestionsRejectInput, requestOptions?: RequestOptions): Promise<QuestionsRejectOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}/reject`,
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
          },
          requestOptions,
        ),
    },
    references: {
      list: (input?: ReferencesListInput, requestOptions?: RequestOptions) =>
        request<ReferencesListOutput>(
          {
            method: "GET",
            path: `/api/reference`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
          },
          requestOptions,
        ),
    },
    projectCopies: {
      create: (input: ProjectCopiesCreateInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesCreateOutput>(
          {
            method: "POST",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy`,
            query: { location: input["location"] },
            body: { strategy: input["strategy"], directory: input["directory"], name: input["name"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
          },
          requestOptions,
        ),
      remove: (input: ProjectCopiesRemoveInput, requestOptions?: RequestOptions): Promise<ProjectCopiesRemoveOutput> =>
        requestEmpty(
          {
            method: "DELETE",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy`,
            query: { location: input["location"] },
            body: { directory: input["directory"], force: input["force"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
          },
          requestOptions,
        ),
      refresh: (
        input: ProjectCopiesRefreshInput,
        requestOptions?: RequestOptions,
      ): Promise<ProjectCopiesRefreshOutput> =>
        requestEmpty(
          {
            method: "POST",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy/refresh`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
          },
          requestOptions,
        ),
    },
  }
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item)
    return
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item)
    return
  }
  if (isPrimitive(value)) params.append(key, String(value))
}

function isPrimitive(value: unknown): value is string | number | boolean | bigint {
  return (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
  )
}

// eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
async function json(response: Response): Promise<unknown> {
  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {
    // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    try {
      // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
      await response.body?.cancel()
    } catch {}
    // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    throw new ClientError("UnsupportedContentType")
  }
  let text: string
  // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
  try {
    // eslint-disable-next-line effect/no-async-await-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    text = await response.text()
  } catch (cause) {
    // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    throw new ClientError("Transport", { cause })
  }
  // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
  if (text === "") throw new ClientError("MalformedResponse")
  // eslint-disable-next-line effect/no-try-catch-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
  try {
    return JSON.parse(text)
  } catch (cause) {
    // eslint-disable-next-line effect/no-throw-use-effect -- (c) zero-Effect Promise root of @opencode-ai/client: public Promise API pinned by promise.test.ts; import-boundaries.test.ts forbids effect in this bundle
    throw new ClientError("MalformedResponse", { cause })
  }
}

function isContentType(response: Response, expected: string) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected
}
