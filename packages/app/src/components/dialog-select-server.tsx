import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { showToast } from "@/utils/toast"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createResource, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Data, Effect, Option, Predicate } from "effect"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { detectServerProtocol } from "@/utils/server-protocol"
import { type ServerHealth, useCheckServerHealth } from "@/utils/server-health"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"

const DEFAULT_USERNAME = "opencode"

// A form field counts as set when it is not empty.
const nonEmpty = (value: string) => (value ? Option.some(value) : Option.none<string>())

interface ServerFormProps {
  value: string
  name: string
  username: string
  password: string
  placeholder: string
  busy: boolean
  error: string
  status: Option.Option<boolean>
  onChange: (value: string) => void
  onNameChange: (value: string) => void
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: () => void
  onBack: () => void
}

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

/** A platform request of the server dialog failed. `cause` is the original throw or rejection. */
class ServerRequestError extends Data.TaggedError("App.ServerRequestError")<{ readonly cause: unknown }> {}

/**
 * Calls an optional platform method that answers with a promise.
 * A missing method gives Option.none(). A throw or a rejection fails with ServerRequestError.
 */
const optionalRequest = <A,>(call: () => PromiseLike<A> | undefined) =>
  Effect.try({ try: call, catch: (cause) => new ServerRequestError({ cause }) }).pipe(
    Effect.flatMap((pending) =>
      pending
        ? Effect.tryPromise({ try: () => pending, catch: (cause) => new ServerRequestError({ cause }) }).pipe(
            Effect.map(Option.some),
          )
        : Effect.succeedNone,
    ),
  )

function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const reportError = (error: ServerRequestError) => Effect.sync(() => showRequestError(language, error.cause))

  const [defaultKey, defaultKeyActions] = createResource(
    () =>
      Effect.runPromise(
        optionalRequest(() => platform.getDefaultServer?.()).pipe(
          Effect.map(Option.flatMap((key) => (key ? Option.some(key) : Option.none<ServerConnection.Key>()))),
          Effect.tapError(reportError),
          Effect.orElseSucceed(() => Option.none<ServerConnection.Key>()),
        ),
      ),
    { initialValue: Option.none<ServerConnection.Key>() },
  )

  const canDefault = createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer)
  // The platform takes null for "no default server".
  const writeDefault = (key: Option.Option<ServerConnection.Key>) =>
    Effect.try({
      try: () => platform.setDefaultServer?.(Option.getOrNull(key)),
      catch: (cause) => new ServerRequestError({ cause }),
    }).pipe(
      Effect.flatMap((pending) =>
        Predicate.isPromiseLike(pending)
          ? Effect.tryPromise({ try: () => pending, catch: (cause) => new ServerRequestError({ cause }) })
          : Effect.void,
      ),
      Effect.andThen(Effect.sync(() => defaultKeyActions.mutate(key))),
      Effect.catch(reportError),
    )

  return { defaultKey: () => defaultKey.latest, canDefault, writeDefault }
}

function useServerPreview() {
  const checkServerHealth = useCheckServerHealth()

  const looksComplete = (value: string) => {
    const normalized = normalizeServerUrl(value)
    if (!normalized) return false
    const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
    if (!host) return false
    if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
    return host.includes(".") || host.includes(":")
  }

  const previewStatus = (
    value: string,
    username: string,
    password: string,
    setStatus: (value: Option.Option<boolean>) => void,
  ) => {
    setStatus(Option.none())
    if (!looksComplete(value)) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) return
    const http: ServerConnection.HttpBase = { url: normalized }
    if (username) http.username = username
    if (password) http.password = password
    Effect.runFork(
      Effect.promise(() => checkServerHealth(http)).pipe(
        Effect.flatMap((result) => Effect.sync(() => setStatus(Option.some(result.healthy)))),
        Effect.tapDefect((defect) => Effect.logError(defect)),
      ),
    )
  }

  return { previewStatus }
}

function ServerForm(props: ServerFormProps) {
  const language = useLanguage()
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      props.onBack()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    props.onSubmit()
  }

  return (
    <div>
      <div class="bg-surface-base rounded-md p-5 flex flex-col gap-3">
        <div class="flex-1 min-w-0 [&_[data-slot=input-wrapper]]:relative">
          <TextField
            type="text"
            label={language.t("dialog.server.add.url")}
            placeholder={props.placeholder}
            value={props.value}
            autofocus
            validationState={props.error ? "invalid" : "valid"}
            error={props.error}
            disabled={props.busy}
            onChange={props.onChange}
            onKeyDown={keyDown}
          />
        </div>
        <TextField
          type="text"
          label={language.t("dialog.server.add.name")}
          placeholder={language.t("dialog.server.add.namePlaceholder")}
          defaultValue={props.name}
          disabled={props.busy}
          onChange={props.onNameChange}
          onKeyDown={keyDown}
        />
        <div class="grid grid-cols-2 gap-2 min-w-0">
          <TextField
            type="text"
            label={language.t("dialog.server.add.username")}
            placeholder={language.t("dialog.server.add.usernamePlaceholder")}
            defaultValue={props.username}
            disabled={props.busy}
            onChange={props.onUsernameChange}
            onKeyDown={keyDown}
          />
          <TextField
            type="password"
            label={language.t("dialog.server.add.password")}
            placeholder={language.t("dialog.server.add.passwordPlaceholder")}
            defaultValue={props.password}
            disabled={props.busy}
            onChange={props.onPasswordChange}
            onKeyDown={keyDown}
          />
        </div>
      </div>
    </div>
  )
}

export function DialogSelectServer() {
  const dialog = useDialog()
  const controller = useServerManagementController({ onSelect: () => dialog.close() })

  return (
    <Dialog title={controller.formTitle()}>
      <div class="flex flex-1 min-h-0 flex-col px-5">
        <Show when={controller.isFormMode()} fallback={<ServerConnectionList controller={controller} />}>
          <ServerConnectionForm controller={controller} />
        </Show>
      </div>
    </Dialog>
  )
}

export function useServerManagementController(options: { onSelect?: () => void; navigateOnAdd?: boolean } = {}) {
  const navigate = useNavigate()
  const server = useServer()
  const tabs = useTabs()
  const global = useGlobal()
  const platform = usePlatform()
  const language = useLanguage()
  const { defaultKey, canDefault, writeDefault } = useDefaultServer()
  const { previewStatus } = useServerPreview()
  const checkServerHealth = useCheckServerHealth()
  const [store, setStore] = createStore({
    addServer: {
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: Option.none<boolean>(),
    },
    editServer: {
      id: Option.none<string>(),
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: Option.none<boolean>(),
    },
  })

  const resetAdd = () => {
    setStore("addServer", {
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: Option.none(),
    })
  }
  const resetEdit = () => {
    setStore("editServer", {
      id: Option.none(),
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: Option.none(),
    })
  }

  // A health or protocol request that rejects still rejects the mutation with the same error.
  const addMutation = useMutation(() => ({
    mutationFn: (value: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const normalized = normalizeServerUrl(value)
          if (!normalized) {
            resetAdd()
            return
          }

          const conn: ServerConnection.Http = {
            type: "http",
            http: { url: normalized },
          }
          if (store.addServer.name.trim()) conn.displayName = store.addServer.name.trim()
          if (store.addServer.password) conn.http.password = store.addServer.password
          if (store.addServer.password && store.addServer.username) conn.http.username = store.addServer.username
          const result = yield* Effect.promise(() => checkServerHealth(conn.http))
          if (!result.healthy) {
            setStore("addServer", { error: language.t("dialog.server.add.error") })
            return
          }
          if (!settings.general.newLayoutDesigns()) {
            const protocol = yield* Effect.promise(() =>
              detectServerProtocol(conn.http, platform.fetch ?? globalThis.fetch),
            )
            if (protocol === "v2") {
              setStore("addServer", { error: language.t("dialog.server.add.error") })
              return
            }
          }

          resetAdd()
          if (options.navigateOnAdd === false) {
            server.add(conn)
            options.onSelect?.()
            return
          }
          select(conn, true)
        }),
      ),
  }))

  const editMutation = useMutation(() => ({
    mutationFn: (input: { original: ServerConnection.Any; value: string }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (input.original.type !== "http") return
          const normalized = normalizeServerUrl(input.value)
          if (!normalized) {
            resetEdit()
            return
          }

          const name = nonEmpty(store.editServer.name.trim())
          const username = nonEmpty(store.editServer.username)
          const password = nonEmpty(store.editServer.password)
          if (
            normalized === input.original.http.url &&
            Option.getOrUndefined(name) === input.original.displayName &&
            Option.getOrUndefined(username) === input.original.http.username &&
            Option.getOrUndefined(password) === input.original.http.password
          ) {
            resetEdit()
            return
          }

          // An empty field keeps its key with no value, so the store merge in server.add clears the saved value.
          const conn: ServerConnection.Http = {
            type: "http",
            displayName: Option.getOrUndefined(name),
            http: {
              url: normalized,
              username: Option.getOrUndefined(username),
              password: Option.getOrUndefined(password),
            },
          }
          const result = yield* Effect.promise(() => checkServerHealth(conn.http))
          if (!result.healthy) {
            setStore("editServer", { error: language.t("dialog.server.add.error") })
            return
          }
          if (!settings.general.newLayoutDesigns()) {
            const protocol = yield* Effect.promise(() =>
              detectServerProtocol(conn.http, platform.fetch ?? globalThis.fetch),
            )
            if (protocol === "v2") {
              setStore("editServer", { error: language.t("dialog.server.add.error") })
              return
            }
          }
          if (normalized === input.original.http.url) {
            server.add(conn)
          } else {
            replaceServer(input.original, conn)
          }

          resetEdit()
        }),
      ),
  }))

  const replaceServer = (original: ServerConnection.Http, next: ServerConnection.Http) => {
    const originalKey = ServerConnection.key(original)
    const active = server.key
    tabs.removeServer(originalKey)
    const newConn = server.add(next)
    if (!newConn) return
    const nextActive = active === originalKey ? ServerConnection.key(newConn) : active
    if (nextActive) server.setActive(nextActive)
    server.remove(originalKey)
  }

  const items = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const settings = useSettings()
  const current = createMemo<Option.Option<ServerConnection.Any>>(() =>
    settings.general.newLayoutDesigns()
      ? Option.none()
      : Option.fromNullishOr(items().find((x) => ServerConnection.key(x) === server.key) ?? items()[0]),
  )

  const sortedItems = createMemo(() => {
    const raw = items()
    const list = settings.general.newLayoutDesigns()
      ? raw
      : raw.filter((x) => global.ensureServerCtx(x).sdk.protocolKind() !== "v2")
    if (!list.length) return list
    const active = current()
    const rank = (value?: ServerHealth) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    // Each row carries its list index, so equal ranks keep the list order.
    return list
      .map((conn, index) => ({ conn, index }))
      .sort((a, b) => {
        if (Option.exists(active, (conn) => conn === a.conn)) return -1
        if (Option.exists(active, (conn) => conn === b.conn)) return 1
        const diff =
          rank(global.servers.health[ServerConnection.key(a.conn)]) -
          rank(global.servers.health[ServerConnection.key(b.conn)])
        if (diff !== 0) return diff
        return a.index - b.index
      })
      .map((row) => row.conn)
  })

  function select(conn: ServerConnection.Any, persist?: boolean) {
    if (!persist && global.servers.health[ServerConnection.key(conn)]?.healthy === false) return
    options.onSelect?.()
    if (persist && conn.type === "http") {
      server.add(conn)
      navigate("/")
      return
    }
    navigate("/")
    queueMicrotask(() => server.setActive(ServerConnection.key(conn)))
  }

  const handleAddChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { url: value, error: "" })
    previewStatus(value, store.addServer.username, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddNameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { name: value, error: "" })
  }

  const handleAddUsernameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { username: value, error: "" })
    previewStatus(store.addServer.url, value, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddPasswordChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { password: value, error: "" })
    previewStatus(store.addServer.url, store.addServer.username, value, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleEditChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { value, error: "" })
    previewStatus(value, store.editServer.username, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditNameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { name: value, error: "" })
  }

  const handleEditUsernameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { username: value, error: "" })
    previewStatus(store.editServer.value, value, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditPasswordChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { password: value, error: "" })
    previewStatus(store.editServer.value, store.editServer.username, value, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const mode = createMemo<"list" | "add" | "edit">(() => {
    if (Option.isSome(store.editServer.id)) return "edit"
    if (store.addServer.showForm) return "add"
    return "list"
  })

  const editing = createMemo(() =>
    Option.flatMap(store.editServer.id, (id) =>
      Option.fromNullishOr(items().find((x) => x.type === "http" && x.http.url === id)),
    ),
  )

  const resetForm = () => {
    resetAdd()
    resetEdit()
  }

  const startAdd = () => {
    resetEdit()
    setStore("addServer", {
      showForm: true,
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      status: Option.none(),
    })
  }

  const startEdit = (conn: ServerConnection.Http) => {
    resetAdd()
    setStore("editServer", {
      id: Option.some(conn.http.url),
      value: conn.http.url,
      name: conn.displayName ?? "",
      username: conn.http.username ?? "",
      password: conn.http.password ?? "",
      error: "",
      status: Option.fromNullishOr(global.servers.health[ServerConnection.key(conn)]?.healthy),
    })
  }

  const submitForm = () => {
    if (mode() === "add") {
      if (addMutation.isPending) return
      setStore("addServer", { error: "" })
      addMutation.mutate(store.addServer.url)
      return
    }
    const original = editing()
    if (Option.isNone(original)) return
    if (editMutation.isPending) return
    setStore("editServer", { error: "" })
    editMutation.mutate({ original: original.value, value: store.editServer.value })
  }

  const isFormMode = createMemo(() => mode() !== "list")
  const isAddMode = createMemo(() => mode() === "add")
  const formBusy = createMemo(() => (isAddMode() ? addMutation.isPending : editMutation.isPending))

  const formTitle = createMemo(() => {
    if (!isFormMode()) return language.t("dialog.server.title")
    return (
      <div class="flex items-center gap-2 -ml-2">
        <IconButton icon="arrow-left" variant="ghost" onClick={resetForm} aria-label={language.t("common.goBack")} />
        <span>{isAddMode() ? language.t("dialog.server.add.title") : language.t("dialog.server.edit.title")}</span>
      </div>
    )
  })

  createEffect(() => {
    if (Option.isNone(store.editServer.id)) return
    if (Option.isSome(editing())) return
    resetEdit()
  })

  const handleRemove = (key: ServerConnection.Key) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (key.startsWith("wsl:")) yield* optionalRequest(() => platform.wslServers?.removeServer(key))
        yield* Effect.try({
          try: () => {
            tabs.removeServer(key)
            server.remove(key)
          },
          catch: (cause) => new ServerRequestError({ cause }),
        })
        const current = yield* optionalRequest(() => platform.getDefaultServer?.())
        if (Option.exists(current, (value) => value === key)) yield* writeDefault(Option.none())
      }).pipe(Effect.catch((error) => Effect.sync(() => showRequestError(language, error.cause)))),
    )

  return {
    // Other screens compare this with a key, and the platform uses null for "no default server".
    defaultKey: () => Option.getOrNull(defaultKey()),
    canDefault,
    current,
    sortedItems,
    status: () => global.servers.health,
    isFormMode,
    isAddMode,
    formTitle,
    formBusy,
    formValue: () => (isAddMode() ? store.addServer.url : store.editServer.value),
    formName: () => (isAddMode() ? store.addServer.name : store.editServer.name),
    formUsername: () => (isAddMode() ? store.addServer.username : store.editServer.username),
    formPassword: () => (isAddMode() ? store.addServer.password : store.editServer.password),
    formError: () => (isAddMode() ? store.addServer.error : store.editServer.error),
    formStatus: () => (isAddMode() ? store.addServer.status : store.editServer.status),
    select,
    setDefault: (key: ServerConnection.Key | null) => Effect.runPromise(writeDefault(Option.fromNullishOr(key))),
    clearDefault: () => Effect.runPromise(writeDefault(Option.none())),
    startAdd,
    startEdit,
    resetForm,
    submitForm,
    handleRemove,
    handleFormChange: () => (isAddMode() ? handleAddChange : handleEditChange),
    handleFormNameChange: () => (isAddMode() ? handleAddNameChange : handleEditNameChange),
    handleFormUsernameChange: () => (isAddMode() ? handleAddUsernameChange : handleEditUsernameChange),
    handleFormPasswordChange: () => (isAddMode() ? handleAddPasswordChange : handleEditPasswordChange),
  }
}

export function ServerConnectionList(props: { controller: ReturnType<typeof useServerManagementController> }) {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <div class="flex flex-1 min-h-0 flex-col gap-4">
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-search-wrapper]]:w-full [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:overflow-y-auto [&_[data-slot=list-items]]:bg-surface-base [&_[data-slot=list-items]]:rounded-md [&_[data-slot=list-item]]:min-h-14 [&_[data-slot=list-item]]:p-3 [&_[data-slot=list-item]]:!bg-transparent"
        search={{
          placeholder: language.t("dialog.server.search.placeholder"),
          autofocus: false,
        }}
        noInitialSelection
        emptyMessage={language.t("dialog.server.empty")}
        items={props.controller.sortedItems}
        key={(x) => x.http.url}
        onSelect={(x) => {
          if (x && !settings.general.newLayoutDesigns()) props.controller.select(x)
        }}
        divider={true}
      >
        {(i) => {
          const key = ServerConnection.key(i)
          return (
            <div class="flex items-center gap-3 min-w-0 flex-1 w-full group/item">
              <div class="flex flex-col h-full items-center w-5">
                <ServerHealthIndicator health={props.controller.status()[key]} />
              </div>
              <ServerRow
                conn={i}
                dimmed={props.controller.status()[key]?.healthy === false}
                status={props.controller.status()[key]}
                class="flex items-center gap-3 min-w-0 flex-1"
                badge={
                  <Show when={props.controller.defaultKey() === ServerConnection.key(i)}>
                    <span class="text-text-base bg-surface-base text-14-regular px-1.5 rounded-xs">
                      {language.t("dialog.server.status.default")}
                    </span>
                  </Show>
                }
                showCredentials
              />
              <div class="flex items-center justify-center gap-4 pl-4">
                <Show when={Option.exists(props.controller.current(), (conn) => ServerConnection.key(conn) === key)}>
                  <Icon name="check" class="h-6" />
                </Show>

                <Show when={i.type === "http"}>
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      class="shrink-0 size-8 hover:bg-surface-base-hover data-[expanded]:bg-surface-base-active"
                      onClick={(e: MouseEvent) => e.stopPropagation()}
                      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => {
                            if (i.type !== "http") return
                            props.controller.startEdit(i)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() !== key}>
                          <DropdownMenu.Item onSelect={() => props.controller.setDefault(key)}>
                            <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.default")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() === key}>
                          <DropdownMenu.Item onSelect={() => props.controller.clearDefault()}>
                            <DropdownMenu.ItemLabel>
                              {language.t("dialog.server.menu.defaultRemove")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          onSelect={() => props.controller.handleRemove(ServerConnection.key(i))}
                          class="text-text-on-critical-base hover:bg-surface-critical-weak"
                        >
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.delete")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </Show>
              </div>
            </div>
          )
        }}
      </List>

      <div class="shrink-0 pb-5">
        <Button
          variant="secondary"
          icon="plus-small"
          size="large"
          onClick={props.controller.startAdd}
          class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
        >
          {language.t("dialog.server.add.button")}
        </Button>
      </div>
    </div>
  )
}

export function ServerConnectionForm(props: { controller: ReturnType<typeof useServerManagementController> }) {
  const language = useLanguage()

  return (
    <div class="flex flex-1 min-h-0 flex-col gap-4">
      <ServerForm
        value={props.controller.formValue()}
        name={props.controller.formName()}
        username={props.controller.formUsername()}
        password={props.controller.formPassword()}
        placeholder={language.t("dialog.server.add.placeholder")}
        busy={props.controller.formBusy()}
        error={props.controller.formError()}
        status={props.controller.formStatus()}
        onChange={props.controller.handleFormChange()}
        onNameChange={props.controller.handleFormNameChange()}
        onUsernameChange={props.controller.handleFormUsernameChange()}
        onPasswordChange={props.controller.handleFormPasswordChange()}
        onSubmit={props.controller.submitForm}
        onBack={props.controller.resetForm}
      />
      <div class="shrink-0 pb-5">
        <Button
          variant="primary"
          size="large"
          onClick={props.controller.submitForm}
          disabled={props.controller.formBusy()}
          class="px-3 py-1.5"
        >
          {props.controller.formBusy()
            ? language.t("dialog.server.add.checking")
            : props.controller.isAddMode()
              ? language.t("dialog.server.add.button")
              : language.t("common.save")}
        </Button>
      </div>
    </div>
  )
}
