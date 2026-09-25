import { describe, expect, test } from "bun:test"
import { HashMap, Option } from "effect"
import {
  addableProbePlan,
  addServerProbePlan,
  addServerViewModel,
  autoProbePlan,
  createProbeFailureGate,
  runAddableProbePlan,
  wslOpencodeAction,
  wslRuntimeRetryable,
} from "./settings-model"
import type {
  WslDistroProbe,
  WslJob,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerRuntime,
  WslServersState,
} from "./types"

/*
 * The WSL types mirror the desktop bridge payload, which reports an absent
 * value as null. The fixture builders take optional keys for absent values
 * and convert each one to that wire null here, at the bridge type.
 */

function runtimeCheck(input: { available: boolean; version?: string; error?: string }): WslRuntimeCheck {
  return {
    available: input.available,
    version: Option.getOrNull(Option.fromNullishOr(input.version)),
    error: Option.getOrNull(Option.fromNullishOr(input.error)),
  }
}

function readyRuntime(input: { url: string; username?: string; password?: string }): WslServerRuntime {
  return {
    kind: "ready",
    url: input.url,
    username: Option.getOrNull(Option.fromNullishOr(input.username)),
    password: Option.getOrNull(Option.fromNullishOr(input.password)),
  }
}

function distroProbe(input: {
  name: string
  canExecute: boolean
  hasBash: boolean
  hasCurl: boolean
  error?: string
}): WslDistroProbe {
  return { ...input, error: Option.getOrNull(Option.fromNullishOr(input.error)) }
}

function opencodeCheck(input: {
  distro: string
  resolvedPath?: string
  version?: string
  expectedVersion: string
  matchesDesktop?: boolean
  error?: string
}): WslOpencodeCheck {
  return {
    distro: input.distro,
    resolvedPath: Option.getOrNull(Option.fromNullishOr(input.resolvedPath)),
    version: Option.getOrNull(Option.fromNullishOr(input.version)),
    expectedVersion: input.expectedVersion,
    matchesDesktop: Option.getOrNull(Option.fromNullishOr(input.matchesDesktop)),
    error: Option.getOrNull(Option.fromNullishOr(input.error)),
  }
}

function wslState(
  input: Partial<Omit<WslServersState, "runtime" | "job">> & { runtime?: WslRuntimeCheck; job?: WslJob },
): WslServersState {
  return {
    installed: input.installed ?? [],
    online: input.online ?? [],
    distroProbes: input.distroProbes ?? {},
    opencodeChecks: input.opencodeChecks ?? {},
    pendingRestart: input.pendingRestart ?? false,
    servers: input.servers ?? [],
    runtime: Option.getOrNull(Option.fromNullishOr(input.runtime)),
    job: Option.getOrNull(Option.fromNullishOr(input.job)),
  }
}

function readyState(input: Partial<Omit<WslServersState, "runtime" | "job">> = {}): WslServersState {
  return wslState({ ...input, runtime: runtimeCheck({ available: true, version: "2.4.13.0" }) })
}

const readyWslState = readyState()

/** A state whose runtime has not been probed yet. */
const unprobedWslState = wslState({})

describe("WSL server settings presentation", () => {
  test("retries only settled unsuccessful runtimes", () => {
    expect(wslRuntimeRetryable({ kind: "starting" })).toBe(false)
    expect(wslRuntimeRetryable(readyRuntime({ url: "http://127.0.0.1:4096" }))).toBe(false)
    expect(wslRuntimeRetryable({ kind: "failed", message: "boom" })).toBe(true)
    expect(wslRuntimeRetryable({ kind: "stopped" })).toBe(true)
  })

  test("offers install and update only when OpenCode needs attention", () => {
    expect(wslOpencodeAction(Option.none())).toEqual(Option.none())
    expect(wslOpencodeAction(Option.some(opencodeCheck({ distro: "Debian", expectedVersion: "1.2.3" })))).toEqual(
      Option.some("wsl.onboarding.installOpencode"),
    )
    expect(
      wslOpencodeAction(
        Option.some(
          opencodeCheck({
            distro: "Debian",
            resolvedPath: "/usr/local/bin/opencode",
            version: "1.2.2",
            expectedVersion: "1.2.3",
            matchesDesktop: false,
          }),
        ),
      ),
    ).toEqual(Option.some("wsl.onboarding.updateOpencode"))
    expect(
      wslOpencodeAction(
        Option.some(
          opencodeCheck({
            distro: "Debian",
            resolvedPath: "/usr/local/bin/opencode",
            version: "1.2.3",
            expectedVersion: "1.2.3",
            matchesDesktop: true,
          }),
        ),
      ),
    ).toEqual(Option.none())
  })

  test("plans addable distro probes with the selected distro first", () => {
    const plan = addableProbePlan({
      state: readyWslState,
      view: "main",
      adding: false,
      selectedDistro: Option.some("Ubuntu"),
      addableInstalledDistros: [
        { name: "Debian", version: 2, isDefault: true },
        { name: "Ubuntu", version: 2, isDefault: false },
      ],
    })

    expect(Option.map(plan, (value) => value.key)).toEqual(Option.some("distro:Ubuntu|distro:Debian"))
    expect(Option.map(plan, (value) => value.distros)).toEqual(Option.some(["Ubuntu", "Debian"]))
  })

  test("plans bootstrap probes for missing runtime and initial distro lists", () => {
    expect(autoProbePlan({ busy: false })).toEqual(Option.none())
    expect(autoProbePlan({ state: unprobedWslState, busy: false })).toEqual(
      Option.some({
        key: "runtime",
        action: "probeRuntime",
      }),
    )
    expect(autoProbePlan({ state: readyWslState, busy: false })).toEqual(
      Option.some({
        key: "distros",
        action: "refreshDistros",
      }),
    )
  })

  test("uses one command plan for bootstrap before addable distro probing", () => {
    expect(
      addServerProbePlan({
        state: unprobedWslState,
        view: "main",
        adding: false,
        busy: false,
        selectedDistro: Option.none(),
        addableInstalledDistros: [{ name: "Debian", version: 2, isDefault: true }],
      }),
    ).toEqual(Option.some({ kind: "auto", key: "auto:runtime", plan: { key: "runtime", action: "probeRuntime" } }))

    expect(
      addServerProbePlan({
        state: readyState({
          installed: [{ name: "Debian", version: 2, isDefault: true }],
          online: [{ name: "Ubuntu", label: "Ubuntu" }],
        }),
        view: "main",
        adding: false,
        busy: false,
        selectedDistro: Option.some("Debian"),
        addableInstalledDistros: [{ name: "Debian", version: 2, isDefault: true }],
      }),
    ).toEqual(
      Option.some({
        kind: "addable",
        key: "addable:distro:Debian",
        plan: { key: "distro:Debian", distros: ["Debian"] },
      }),
    )
  })

  test("does not accept the same failed probe command until reset", () => {
    const gate = createProbeFailureGate()

    expect(gate.accepts("addable:distro:Debian")).toBe(true)
    gate.settle("addable:distro:Debian", new Error("wsl failed"))
    expect(gate.accepts("addable:distro:Debian")).toBe(false)
    expect(gate.accepts("addable:distro:Ubuntu")).toBe(true)
    gate.reset()
    expect(gate.accepts("addable:distro:Debian")).toBe(true)
  })

  test("keeps default distro selection stable while probes resolve", () => {
    const model = addServerViewModel({
      state: readyState({
        installed: [
          { name: "Debian", version: 2, isDefault: true },
          { name: "Ubuntu", version: 2, isDefault: false },
        ],
        online: [{ name: "Alpine", label: "Alpine Linux" }],
        distroProbes: {
          Ubuntu: distroProbe({ name: "Ubuntu", canExecute: true, hasBash: true, hasCurl: true }),
        },
      }),
      view: "main",
      selectedDistro: Option.none(),
      catalogSearch: "",
      catalogTarget: Option.none(),
      adding: false,
      probingAddable: false,
    })

    expect(model.selectedDistro).toEqual(Option.some("Debian"))
  })

  test("keeps the dialog busy across serial addable probe job gaps", () => {
    const model = addServerViewModel({
      state: readyState({
        installed: [{ name: "Debian", version: 2, isDefault: true }],
        online: [{ name: "Ubuntu", label: "Ubuntu" }],
      }),
      view: "main",
      selectedDistro: Option.none(),
      catalogSearch: "",
      catalogTarget: Option.none(),
      adding: false,
      probingAddable: true,
    })

    expect(model.busy).toBe(true)
  })

  test("does not report ready when OpenCode is present but cannot run", () => {
    const model = addServerViewModel({
      state: readyState({
        installed: [{ name: "Debian", version: 2, isDefault: true }],
        online: [{ name: "Ubuntu", label: "Ubuntu" }],
        distroProbes: {
          Debian: distroProbe({ name: "Debian", canExecute: true, hasBash: true, hasCurl: true }),
        },
        opencodeChecks: {
          Debian: opencodeCheck({
            distro: "Debian",
            resolvedPath: "/home/me/.opencode/bin/opencode",
            expectedVersion: "1.2.3",
            error: "opencode is installed but could not run",
          }),
        },
      }),
      view: "main",
      selectedDistro: Option.none(),
      catalogSearch: "",
      catalogTarget: Option.none(),
      adding: false,
      probingAddable: false,
    })

    expect(HashMap.get(model.distroStatuses, "Debian")).toEqual(
      Option.some({
        label: { key: "wsl.onboarding.installOpencode" },
        tone: "warning",
      }),
    )
    expect(model.primaryButton.action).toEqual(Option.some("install-opencode"))
  })

  test("delegates addable probe plans to one batch command", async () => {
    const calls: string[][] = []

    await runAddableProbePlan({
      plan: { key: "distro:Debian|distro:Ubuntu", distros: ["Debian", "Ubuntu"] },
      api: {
        probeAddable: async (distros) => {
          calls.push(distros)
        },
      },
    })

    expect(calls).toEqual([["Debian", "Ubuntu"]])
  })
})
