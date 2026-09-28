import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { RadioGroupV2, RadioItemV2 } from "@opencode-ai/ui/v2/radio-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Array as Arr, Effect, HashMap, Option } from "effect"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useWslAddServerProbes } from "./add-server-probes"
import { useWslServers } from "./context"
import { addServerViewModel, WslRequestError, wslRequest, wslRequestError, type AddServerText } from "./settings-model"
import "./dialog-add-wsl-server.css"

/**
 * Runs a dialog action in the background. A failure or defect goes to the
 * Effect logger, as an unhandled rejection went to the console before.
 */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

function isWslRuntimeMissing(error: Option.Option<string>) {
  return Option.match(error, {
    onNone: () => true,
    onSome: (text) => !text || /WSL is not installed|not been installed|wsl(?:\.exe)? --install/i.test(text),
  })
}

function translate(language: ReturnType<typeof useLanguage>, value: AddServerText) {
  if (value.params) return language.t(value.key, value.params)
  return language.t(value.key)
}

interface DialogWslServerProps {
  onAdded?: (distro: string) => void | Promise<void>
}

export function DialogAddWslServer(props: DialogWslServerProps = {}) {
  const language = useLanguage()
  const controller = useWslAddServerController(props)
  const model = controller.model
  const primaryButton = () => model().primaryButton
  const primaryButtonStyle = () => Option.getOrUndefined(Option.map(primaryButton().width, (width) => ({ width })))

  return (
    <Show
      when={!controller.wslServers.isPending && !controller.wslServers.isError}
      fallback={
        <Dialog fit class="settings-v2-wsl-dialog">
          <Show
            when={!controller.wslServers.isError}
            fallback={<div class="settings-v2-wsl-loading">{controller.loadError()}</div>}
          >
            <div class="settings-v2-wsl-loading">
              <LoaderV2 />
            </div>
          </Show>
        </Dialog>
      }
    >
      <Show
        when={model().runtimeState === "ready"}
        fallback={
          <Show
            when={model().runtimeState === "checking" || model().runtimeState === "loading"}
            fallback={
              <DialogWslSetup
                state={model().runtimeState}
                error={controller.runtimeError()}
                installable={isWslRuntimeMissing(controller.runtimeError())}
                busy={model().busy}
                onInstall={controller.installWsl}
              />
            }
          >
            <Dialog fit class="settings-v2-wsl-dialog">
              <div class="settings-v2-wsl-loading">
                <LoaderV2 />
              </div>
            </Dialog>
          </Show>
        }
      >
        <Dialog fit class="settings-v2-wsl-dialog">
          <DialogHeader hideClose={true}>
            <DialogTitle>
              {controller.view() === "main" ? language.t("wsl.server.add") : language.t("wsl.onboarding.installDistro")}
            </DialogTitle>
          </DialogHeader>
          <DividerV2 />
          <Show
            when={controller.view() === "main"}
            fallback={
              <>
                <DialogBody class="settings-v2-wsl-dialog-body settings-v2-wsl-catalog-picker">
                  <TextInputV2
                    class="settings-v2-wsl-catalog-search"
                    appearance="large"
                    placeholder={language.t("wsl.onboarding.searchDistros")}
                    value={controller.catalogSearch()}
                    disabled={model().busy}
                    onInput={(event) => controller.setCatalogSearch(event.currentTarget.value)}
                  />
                  <div class="settings-v2-wsl-catalog-list">
                    <RadioGroupV2
                      hideLabel
                      class="settings-v2-wsl-distro-group"
                      label={language.t("wsl.onboarding.installDistro")}
                      value={Option.getOrUndefined(model().catalogTarget)}
                      onChange={controller.setCatalogTarget}
                      disabled={model().busy}
                    >
                      <For each={model().filteredInstallableDistros}>
                        {(item) => (
                          <RadioItemV2
                            class="settings-v2-wsl-distro-row settings-v2-wsl-catalog-row"
                            value={item.name}
                            disabled={model().busy}
                            label={<span class="settings-v2-wsl-distro-label">{item.label}</span>}
                          />
                        )}
                      </For>
                    </RadioGroupV2>
                  </div>
                </DialogBody>
                <DialogFooter>
                  <ButtonV2 variant="neutral" disabled={model().busy} onClick={controller.closeCatalog}>
                    {language.t("common.cancel")}
                  </ButtonV2>
                  <ButtonV2
                    variant={model().installingCatalogDistro ? "loading" : "contrast"}
                    disabled={
                      !model().installingCatalogDistro && (model().busy || Option.isNone(model().catalogTarget))
                    }
                    style={{ width: "99px" }}
                    onClick={controller.installCatalogDistro}
                  >
                    <Show when={model().installingCatalogDistro} fallback={language.t("wsl.onboarding.installDistro")}>
                      <LoaderV2 />
                    </Show>
                  </ButtonV2>
                </DialogFooter>
              </>
            }
          >
            <DialogBody class="settings-v2-wsl-dialog-body">
              <div class="settings-v2-wsl-section-header">
                <span class="settings-v2-wsl-section-title">{language.t("wsl.onboarding.installedDistros")}</span>
                <ButtonV2
                  variant="ghost-muted"
                  size="small"
                  disabled={model().busy}
                  onClick={controller.refreshDistros}
                >
                  {language.t("wsl.onboarding.checkAgain")}
                </ButtonV2>
              </div>

              <Show
                when={model().addableInstalledDistros.length > 0}
                fallback={
                  <div class="settings-v2-wsl-distro-list">
                    <div class="settings-v2-wsl-distro-empty">
                      {model().visibleInstalledDistros.length
                        ? language.t("wsl.onboarding.allDistrosAdded")
                        : language.t("wsl.onboarding.noDistros")}
                    </div>
                  </div>
                }
              >
                <div class="settings-v2-wsl-distro-list">
                  <RadioGroupV2
                    hideLabel
                    class="settings-v2-wsl-distro-group"
                    label={language.t("wsl.onboarding.installedDistros")}
                    value={Option.getOrUndefined(model().selectedDistro)}
                    onChange={controller.setSelectedDistro}
                    disabled={model().busy}
                  >
                    <For each={model().addableInstalledDistros}>
                      {(item) => {
                        const status = () => Option.getOrUndefined(HashMap.get(model().distroStatuses, item.name))
                        return (
                          <RadioItemV2
                            class={`settings-v2-wsl-distro-row${item.version === 1 ? " settings-v2-wsl-distro-row--unsupported" : ""}`}
                            value={item.name}
                            disabled={item.version === 1 || model().busy}
                            label={<span class="settings-v2-wsl-distro-label">{item.name}</span>}
                            description={
                              <Show when={status()}>
                                {(value) => (
                                  <span class="settings-v2-wsl-distro-status" data-tone={value().tone}>
                                    {translate(language, value().label)}
                                  </span>
                                )}
                              </Show>
                            }
                          />
                        )
                      }}
                    </For>
                  </RadioGroupV2>
                </div>
              </Show>

              <Show when={model().installableDistros.length > 0}>
                <button
                  type="button"
                  class="settings-v2-wsl-catalog-card"
                  disabled={model().busy}
                  onClick={controller.openCatalog}
                >
                  <span class="settings-v2-wsl-catalog-icon" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path
                        d="M13.5564 10.4443V13.5554H4.22309C3.24087 13.5554 2.44531 13.5554 2.44531 13.5554V10.4443M11.112 5.99989L8.00087 9.111L4.88976 5.99989M8.00087 9.111L8.00087 2.44434"
                        stroke="currentColor"
                      />
                    </svg>
                  </span>
                  <span class="settings-v2-wsl-catalog-copy">
                    <span class="settings-v2-wsl-catalog-title">{language.t("wsl.onboarding.needAnotherDistro")}</span>
                    <span class="settings-v2-wsl-catalog-description">
                      {language.t("wsl.onboarding.needAnotherDistroHint")}
                    </span>
                  </span>
                  <span class="settings-v2-wsl-catalog-chevron" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M6 12L10 8L6 4" stroke="currentColor" />
                    </svg>
                  </span>
                </button>
              </Show>
            </DialogBody>

            <DialogFooter>
              <ButtonV2 variant="neutral" disabled={controller.adding()} onClick={controller.close}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2
                variant={primaryButton().loading ? "loading" : primaryButton().variant}
                disabled={!primaryButton().loading && primaryButton().disabled}
                style={primaryButtonStyle()}
                onClick={controller.runPrimary}
              >
                <Show when={primaryButton().loading} fallback={translate(language, primaryButton().label)}>
                  <LoaderV2 />
                </Show>
              </ButtonV2>
            </DialogFooter>
          </Show>
        </Dialog>
      </Show>
    </Show>
  )
}

function useWslAddServerController(props: DialogWslServerProps) {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const wslServers = useWslServers()
  const api = platform.wslServers!
  const [store, setStore] = createStore({
    view: "main" as "main" | "catalog",
    selectedDistro: Option.none<string>(),
    catalogSearch: "",
    catalogTarget: Option.none<string>(),
    adding: false,
  })
  const current = () => wslServers.data
  const viewModel = (probingAddable: boolean) =>
    addServerViewModel({
      state: current(),
      view: store.view,
      selectedDistro: store.selectedDistro,
      catalogSearch: store.catalogSearch,
      catalogTarget: store.catalogTarget,
      adding: store.adding,
      probingAddable,
    })
  const baseModel = createMemo(() => viewModel(false))
  const probes = useWslAddServerProbes({
    state: current,
    api,
    view: () => store.view,
    adding: () => store.adding,
    busy: () => baseModel().busy,
    selectedDistro: () => baseModel().selectedDistro,
    addableInstalledDistros: () => baseModel().addableInstalledDistros,
    onError: (error) => runDetached(requestError(language, error)),
  })
  const model = createMemo(() => viewModel(probes.probingAddable()))

  const openCatalog = () => {
    setStore({
      view: "catalog",
      catalogSearch: "",
      catalogTarget: Option.map(Arr.head(model().installableDistros), (item) => item.name),
    })
  }

  /** Reports a failed request with a log line and a toast. */
  const run = <A, E>(action: Effect.Effect<A, E>) => action.pipe(Effect.catch((error) => requestError(language, error)))

  const refreshDistros = () => {
    runDetached(
      run(
        Effect.gen(function* () {
          probes.resetProbeFailure()
          yield* wslRequest(() => api.refreshDistros())
        }),
      ),
    )
  }

  const installDistro = (name: string) => {
    runDetached(
      run(
        Effect.gen(function* () {
          probes.resetProbeFailure()
          yield* wslRequest(() => api.installDistro(name))
          setStore("view", "main")
        }),
      ),
    )
  }

  const installCatalogDistro = () => {
    if (model().installingCatalogDistro) return
    const name = model().catalogTarget
    if (Option.isNone(name)) return
    installDistro(name.value)
  }

  const closeCatalog = () => {
    probes.resetProbeFailure()
    setStore({ view: "main", catalogSearch: "", catalogTarget: Option.none() })
  }

  const addServer = (distro: string) =>
    Effect.gen(function* () {
      yield* wslRequest(() => api.addServer(distro))
      const onAdded = props.onAdded
      if (!onAdded) {
        dialog.close()
        return
      }
      const pending = yield* Effect.try({ try: () => onAdded(distro), catch: wslRequestError })
      if (pending instanceof Promise) yield* wslRequest(() => pending)
    })

  const runPrimary = () => {
    const button = model().primaryButton
    if (button.loading) return
    const target = Option.all({ distro: model().selectedDistro, action: button.action })
    if (Option.isNone(target)) return
    const { distro, action } = target.value
    if (action === "install-opencode") {
      runDetached(run(wslRequest(() => api.installOpencode(distro))))
      return
    }
    setStore("adding", true)
    runDetached(run(addServer(distro)).pipe(Effect.ensuring(Effect.sync(() => setStore("adding", false)))))
  }

  const loadError = () => {
    const error = wslServers.error
    if (!error) return language.t("wsl.onboarding.loadFailed")
    return error instanceof Error ? error.message : String(error)
  }

  return {
    wslServers,
    model,
    loadError,
    runtimeError: () => Option.fromNullishOr(current()?.runtime?.error),
    view: () => store.view,
    catalogSearch: () => store.catalogSearch,
    adding: () => store.adding,
    setCatalogSearch: (value: string) => setStore("catalogSearch", value),
    setCatalogTarget: (value: string) => setStore("catalogTarget", Option.some(value)),
    setSelectedDistro: (value: string) => setStore("selectedDistro", Option.some(value)),
    openCatalog,
    closeCatalog,
    refreshDistros,
    installCatalogDistro,
    installWsl: () => runDetached(run(wslRequest(() => api.installWsl()))),
    runPrimary,
    close: () => dialog.close(),
  }
}

function DialogWslSetup(props: {
  state: string
  error: Option.Option<string>
  installable: boolean
  busy: boolean
  onInstall: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const title = () =>
    props.state === "pendingRestart"
      ? language.t("wsl.onboarding.restartRequired")
      : props.installable
        ? language.t("wsl.onboarding.wslNotInstalled.title")
        : language.t("wsl.onboarding.wslUnavailable.title")
  const visibleError = () =>
    props.installable ? Option.none<string>() : Option.filter(props.error, (text) => text.length > 0)
  const description = () => {
    if (props.state === "pendingRestart") return language.t("wsl.onboarding.windowsRestartRequired")
    if (!props.installable) return language.t("wsl.onboarding.wslUnavailable.description")
    return language.t("wsl.onboarding.wslNotInstalled.description")
  }

  return (
    <Dialog fit class="settings-v2-wsl-not-installed-dialog">
      <div class="settings-v2-wsl-not-installed-content">
        <div class="settings-v2-wsl-not-installed-message">
          <svg
            class="settings-v2-wsl-not-installed-icon"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <g clip-path="url(#settings-v2-wsl-warning-clip)">
              <path
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M12 -0.00244141L23.6926 20.2498H0.308594L12 -0.00244141ZM12.7954 6.32932C12.5844 6.11834 12.2982 5.99982 11.9999 5.99982C11.7015 5.99982 11.4154 6.11834 11.2044 6.32932C10.9934 6.5403 10.8749 6.82645 10.8749 7.12482V11.6248C10.8749 11.9232 10.9934 12.2093 11.2044 12.4203C11.4154 12.6313 11.7015 12.7498 11.9999 12.7498C12.2982 12.7498 12.5844 12.6313 12.7954 12.4203C13.0064 12.2093 13.1249 11.9232 13.1249 11.6248V7.12482C13.1249 6.82645 13.0064 6.5403 12.7954 6.32932ZM13.0605 17.5605C12.7792 17.8418 12.3977 17.9998 11.9999 17.9998C11.6021 17.9998 11.2205 17.8418 10.9392 17.5605C10.6579 17.2792 10.4999 16.8976 10.4999 16.4998C10.4999 16.102 10.6579 15.7205 10.9392 15.4392C11.2205 15.1579 11.6021 14.9998 11.9999 14.9998C12.3977 14.9998 12.7792 15.1579 13.0605 15.4392C13.3418 15.7205 13.4999 16.102 13.4999 16.4998C13.4999 16.8976 13.3418 17.2792 13.0605 17.5605Z"
                fill="#DBDBDB"
              />
            </g>
            <defs>
              <clipPath id="settings-v2-wsl-warning-clip">
                <rect width="24" height="24" fill="white" />
              </clipPath>
            </defs>
          </svg>
          <h2 class="settings-v2-wsl-not-installed-title">{title()}</h2>
          <p class="settings-v2-wsl-not-installed-description">{description()}</p>
          <Show when={Option.getOrUndefined(visibleError())}>
            {(error) => <p class="settings-v2-wsl-unavailable-error">{error()}</p>}
          </Show>
        </div>
        <Show when={props.state === "unavailable" && props.installable}>
          <ButtonV2 variant="neutral" disabled={props.busy} onClick={props.onInstall}>
            {language.t("wsl.onboarding.installWsl")}
          </ButtonV2>
        </Show>
        <Show when={props.state !== "unavailable"}>
          <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </ButtonV2>
        </Show>
      </div>
    </Dialog>
  )
}

/**
 * Logs a failed WSL request and shows its message in a toast. For a
 * WslRequestError, the log and the toast report the failure it wraps.
 */
function requestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  const failure = err instanceof WslRequestError ? err.cause : err
  return Effect.logError(
    "WSL servers request failed",
    failure instanceof Error ? (failure.stack ?? failure.message) : String(failure),
  ).pipe(
    Effect.andThen(
      Effect.sync(() =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: failure instanceof Error ? failure.message : String(failure),
        }),
      ),
    ),
  )
}
