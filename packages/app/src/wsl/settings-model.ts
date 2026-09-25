import fuzzysort from "fuzzysort"
import { Array as Arr, Data, Effect, HashMap, HashSet, Option } from "effect"
import type {
  WslInstalledDistro,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslServersPlatform,
  WslServerRuntime,
  WslServersState,
} from "./types"

export type AddServerText = {
  key: string
  params?: Record<string, string>
}

export type DistroStatusTone = "success" | "warning" | "muted"

export type DistroStatus = {
  label: AddServerText
  tone: DistroStatusTone
}

export type AddServerPrimaryButton = {
  variant: "neutral" | "contrast"
  label: AddServerText
  disabled: boolean
  action: Option.Option<"install-opencode" | "add">
  loading: boolean
  width: Option.Option<string>
}

export type AddServerRuntimeState = "loading" | "pendingRestart" | "checking" | "unavailable" | "ready"

export type AddableProbePlan = {
  key: string
  distros: string[]
}

export type AutoProbePlan = { key: "runtime"; action: "probeRuntime" } | { key: "distros"; action: "refreshDistros" }

export type AddServerProbePlan =
  | { kind: "auto"; key: string; plan: AutoProbePlan }
  | { kind: "addable"; key: string; plan: AddableProbePlan }

export type WslAddServerView = "main" | "catalog"

export type WslOpencodeAction = "wsl.onboarding.installOpencode" | "wsl.onboarding.updateOpencode"

function isHiddenDistro(name: string) {
  return /^docker-desktop(?:-data)?$/i.test(name)
}

export const wslRuntimeRetryable = (runtime: WslServerRuntime) =>
  runtime.kind === "failed" || runtime.kind === "stopped"

/** The OpenCode action that a distro needs, if any. */
export function wslOpencodeAction(check: Option.Option<WslOpencodeCheck>) {
  return Option.flatMap(check, (value): Option.Option<WslOpencodeAction> => {
    if (!value.resolvedPath) return Option.some("wsl.onboarding.installOpencode")
    if (value.matchesDesktop === false) return Option.some("wsl.onboarding.updateOpencode")
    return Option.none()
  })
}

export function wslDistroReady(state: WslServersState | undefined, name: string) {
  const installed = state?.installed.find((item) => item.name === name)
  const probe = state?.distroProbes[name]
  if (!probe || !installed) return false
  if (installed.version === 1) return false
  return probe.canExecute && probe.hasBash && probe.hasCurl
}

export function addServerViewModel(input: {
  state: WslServersState | undefined
  view: WslAddServerView
  selectedDistro: Option.Option<string>
  catalogSearch: string
  catalogTarget: Option.Option<string>
  adding: boolean
  probingAddable: boolean
}) {
  const state = input.state
  const visibleInstalledDistros = (state?.installed ?? []).filter((item) => !isHiddenDistro(item.name))
  const visibleOnlineDistros = (state?.online ?? []).filter((item) => !isHiddenDistro(item.name))
  const existingServerDistros = HashSet.fromIterable((state?.servers ?? []).map((item) => item.config.distro))
  const addableInstalledDistros = visibleInstalledDistros.filter(
    (item) => !HashSet.has(existingServerDistros, item.name),
  )
  const selectedDistro = addServerSelectedDistro(input.selectedDistro, visibleInstalledDistros, addableInstalledDistros)
  const opencodeCheck = Option.flatMap(selectedDistro, (name) => Option.fromNullishOr(state?.opencodeChecks[name]))
  const installableDistros = addServerInstallableDistros(visibleInstalledDistros, visibleOnlineDistros)
  const filteredInstallableDistros = addServerFilteredInstallableDistros(installableDistros, input.catalogSearch)
  const catalogTarget = addServerCatalogTarget(input.catalogTarget, filteredInstallableDistros)
  const busy = !!state?.job || input.adding || input.probingAddable

  return {
    busy,
    runtimeState: addServerRuntimeState(state),
    visibleInstalledDistros,
    visibleOnlineDistros,
    addableInstalledDistros,
    selectedDistro,
    opencodeCheck,
    wslReady: !!state?.runtime?.available && !state?.pendingRestart,
    distroStatuses: HashMap.fromIterable(
      addableInstalledDistros.flatMap((item) =>
        Option.toArray(
          Option.map(
            addServerDistroStatus({ state, name: item.name, probingAddable: input.probingAddable }),
            (status): readonly [string, DistroStatus] => [item.name, status],
          ),
        ),
      ),
    ),
    primaryButton: addServerPrimaryButton({
      state,
      selectedDistro,
      opencodeCheck,
      adding: input.adding,
      probingAddable: input.probingAddable,
    }),
    installableDistros,
    filteredInstallableDistros,
    catalogTarget,
    installingCatalogDistro: state?.job?.kind === "install-distro",
  }
}

function addServerSelectedDistro(
  selected: Option.Option<string>,
  visibleInstalledDistros: WslInstalledDistro[],
  addableInstalledDistros: WslInstalledDistro[],
): Option.Option<string> {
  const kept = Option.filter(selected, (name) =>
    addableInstalledDistros.some((item) => item.name === name && item.version !== 1),
  )
  if (Option.isSome(kept)) return kept
  const defaultDistro = visibleInstalledDistros.find((item) => item.isDefault)
  if (
    defaultDistro &&
    defaultDistro.version !== 1 &&
    addableInstalledDistros.some((item) => item.name === defaultDistro.name)
  ) {
    return Option.some(defaultDistro.name)
  }
  return Option.map(
    Arr.findFirst(addableInstalledDistros, (item) => item.version !== 1),
    (item) => item.name,
  )
}

function addServerRuntimeState(state: WslServersState | undefined): AddServerRuntimeState {
  if (!state) return "loading"
  if (state.pendingRestart) return "pendingRestart"
  if (!state.runtime) return "checking"
  if (!state.runtime.available) return "unavailable"
  return "ready"
}

function addServerDistroStatus(input: {
  state: WslServersState | undefined
  name: string
  probingAddable: boolean
}): Option.Option<DistroStatus> {
  const installed = input.state?.installed.find((item) => item.name === input.name)
  if (installed?.version === 1) {
    return Option.some({ label: { key: "wsl.onboarding.distroStatus.unsupported" }, tone: "muted" })
  }
  const job = input.state?.job
  const probe = input.state?.distroProbes[input.name]
  if (!probe) {
    if (input.probingAddable || (job?.kind === "probe-addable" && job.distros.includes(input.name))) {
      return Option.some(checkingStatus())
    }
    return Option.none()
  }
  if (!probe.canExecute) {
    if (!installed) {
      return Option.some({
        label: { key: "wsl.onboarding.distroNotInstalled", params: { distro: input.name } },
        tone: "warning",
      })
    }
    return Option.some({
      label: { key: "wsl.onboarding.openDistroOnce", params: { distro: input.name } },
      tone: "warning",
    })
  }
  if (!probe.hasBash || !probe.hasCurl) {
    return Option.some({ label: { key: "wsl.onboarding.distroStatus.missingTools" }, tone: "warning" })
  }
  const check = input.state?.opencodeChecks[input.name]
  if (!check) {
    if (input.probingAddable || (job?.kind === "probe-addable" && job.distros.includes(input.name))) {
      return Option.some(checkingStatus())
    }
    return Option.none()
  }
  if (check.matchesDesktop === false) {
    return Option.some({ label: { key: "wsl.onboarding.updateOpencode" }, tone: "warning" })
  }
  if (!check.resolvedPath) {
    return Option.some({ label: { key: "wsl.onboarding.distroStatus.opencodeMissing" }, tone: "warning" })
  }
  if (check.error) return Option.some({ label: { key: "wsl.onboarding.installOpencode" }, tone: "warning" })
  return Option.some({ label: { key: "wsl.onboarding.distroStatus.ready" }, tone: "success" })
}

function checkingStatus(): DistroStatus {
  return { label: { key: "wsl.onboarding.distroStatus.checking" }, tone: "muted" }
}

function addServerPrimaryButton(input: {
  state: WslServersState | undefined
  selectedDistro: Option.Option<string>
  opencodeCheck: Option.Option<WslOpencodeCheck>
  adding: boolean
  probingAddable: boolean
}): AddServerPrimaryButton {
  const ready = Option.exists(input.selectedDistro, (name) => wslDistroReady(input.state, name))
  const probingSelected = input.probingAddable && !addServerSelectedDistroSettled(input.state, input.selectedDistro)
  const job = input.state?.job
  const probingOpencode =
    probingSelected ||
    (ready &&
      (Option.isNone(input.opencodeCheck) ||
        (job?.kind === "probe-addable" && Option.exists(input.selectedDistro, (name) => job.distros.includes(name)))))
  const installingOpencode = job?.kind === "install-opencode" && Option.contains(input.selectedDistro, job.distro)
  if (!ready || probingOpencode) {
    return {
      variant: "contrast",
      label: probingSelected ? { key: "wsl.onboarding.distroStatus.checking" } : { key: "wsl.server.add" },
      disabled: true,
      action: Option.none(),
      loading: probingSelected,
      width: Option.none(),
    }
  }
  if (!addServerOpencodeReady(input.opencodeCheck)) {
    const update = Option.exists(input.opencodeCheck, (check) => !!check.resolvedPath && check.matchesDesktop === false)
    return {
      variant: "neutral",
      label: installingOpencode
        ? { key: "wsl.onboarding.updatingOpencode" }
        : update
          ? { key: "wsl.onboarding.updateOpencode" }
          : { key: "wsl.onboarding.installOpencode" },
      disabled: !!input.state?.job || input.adding,
      action: Option.some("install-opencode"),
      loading: installingOpencode,
      width: Option.some(update ? "138px" : "129px"),
    }
  }
  return {
    variant: "contrast",
    label: input.adding ? { key: "wsl.onboarding.adding" } : { key: "wsl.server.add" },
    disabled: input.adding || !!input.state?.job,
    action: Option.some("add"),
    loading: input.adding,
    width: Option.none(),
  }
}

function addServerOpencodeReady(check: Option.Option<WslOpencodeCheck>) {
  return Option.exists(check, (value) => !!value.resolvedPath && value.matchesDesktop !== false && !value.error)
}

function addServerSelectedDistroSettled(state: WslServersState | undefined, selectedDistro: Option.Option<string>) {
  return Option.exists(selectedDistro, (name) => addServerDistroSettled(state, name))
}

function addServerDistroSettled(state: WslServersState | undefined, name: string) {
  const installed = state?.installed.find((item) => item.name === name)
  if (installed?.version === 1) return false
  if (!state?.distroProbes[name]) return false
  if (!wslDistroReady(state, name)) return true
  return !!state.opencodeChecks[name]
}

function addServerInstallableDistros(installedDistros: WslInstalledDistro[], onlineDistros: WslOnlineDistro[]) {
  const installed = HashSet.fromIterable(installedDistros.map((item) => item.name))
  const hasVersionedUbuntu = onlineDistros.some((item) => /^Ubuntu-\d/.test(item.name))
  return onlineDistros
    .filter((item) => !HashSet.has(installed, item.name))
    .filter((item) => item.name !== "Ubuntu" || !hasVersionedUbuntu)
}

function addServerFilteredInstallableDistros(installableDistros: WslOnlineDistro[], search: string) {
  const query = search.trim()
  if (!query) return installableDistros
  return fuzzysort.go(query, installableDistros, { keys: ["label", "name"] }).map((item) => item.obj)
}

function addServerCatalogTarget(target: Option.Option<string>, distros: WslOnlineDistro[]) {
  return Option.filter(target, (name) => distros.some((item) => item.name === name)).pipe(
    Option.orElse(() => Option.map(Arr.head(distros), (item) => item.name)),
  )
}

export function addableProbePlan(input: {
  state: WslServersState | undefined
  view: WslAddServerView
  adding: boolean
  selectedDistro: Option.Option<string>
  addableInstalledDistros: WslInstalledDistro[]
}): Option.Option<AddableProbePlan> {
  const state = input.state
  if (!state?.runtime?.available || state.pendingRestart || input.view !== "main" || input.adding) {
    return Option.none()
  }
  if (state.job) return Option.none()
  const ordered = Option.match(input.selectedDistro, {
    onNone: () => input.addableInstalledDistros,
    onSome: (selected) => [
      ...input.addableInstalledDistros.filter((item) => item.name === selected),
      ...input.addableInstalledDistros.filter((item) => item.name !== selected),
    ],
  })
  const pending = ordered.flatMap((item) => {
    if (item.version === 1) return []
    if (!state.distroProbes[item.name]) return [`distro:${item.name}`]
    if (wslDistroReady(state, item.name) && !state.opencodeChecks[item.name]) return [`opencode:${item.name}`]
    return []
  })
  if (!pending.length) return Option.none()
  return Option.some({
    key: pending.join("|"),
    distros: ordered.filter((item) => item.version !== 1).map((item) => item.name),
  })
}

export function autoProbePlan(input: { state?: WslServersState; busy: boolean }): Option.Option<AutoProbePlan> {
  if (!input.state || input.busy || input.state.pendingRestart) return Option.none()
  if (!input.state.runtime) return Option.some({ key: "runtime", action: "probeRuntime" })
  if (!input.state.runtime.available) return Option.none()
  if (input.state.installed.length || input.state.online.length) return Option.none()
  return Option.some({ key: "distros", action: "refreshDistros" })
}

export function addServerProbePlan(input: {
  state: WslServersState | undefined
  view: WslAddServerView
  adding: boolean
  busy: boolean
  selectedDistro: Option.Option<string>
  addableInstalledDistros: WslInstalledDistro[]
}): Option.Option<AddServerProbePlan> {
  const auto = autoProbePlan({ state: input.state, busy: input.busy })
  if (Option.isSome(auto)) return Option.some({ kind: "auto", key: `auto:${auto.value.key}`, plan: auto.value })
  return Option.map(
    addableProbePlan(input),
    (addable): AddServerProbePlan => ({ kind: "addable", key: `addable:${addable.key}`, plan: addable }),
  )
}

export function createProbeFailureGate() {
  let failed = Option.none<string>()
  return {
    accepts(key: string) {
      return !Option.contains(failed, key)
    },
    settle(key: string, error?: unknown) {
      if (error) failed = Option.some(key)
    },
    reset() {
      failed = Option.none()
    },
  }
}

/**
 * A WSL server request that failed: a desktop bridge call that rejected, or
 * the dialog's onAdded callback. The message is the failure's own message,
 * and `cause` holds the original value.
 */
export class WslRequestError extends Data.TaggedError("App.WslRequestError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export const wslRequestError = (cause: unknown) =>
  new WslRequestError({ message: cause instanceof Error ? cause.message : String(cause), cause })

/** Runs one desktop WSL bridge call. A rejection becomes a WslRequestError. */
export const wslRequest = <A>(request: () => Promise<A>) => Effect.tryPromise({ try: request, catch: wslRequestError })

export function runAddableProbePlan(input: { plan: AddableProbePlan; api: Pick<WslServersPlatform, "probeAddable"> }) {
  return wslRequest(() => input.api.probeAddable(input.plan.distros))
}
