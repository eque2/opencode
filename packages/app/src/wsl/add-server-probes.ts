import { useMutation } from "@tanstack/solid-query"
import { Option } from "effect"
import { createEffect } from "solid-js"
import type { Accessor } from "solid-js"
import {
  addServerProbePlan,
  createProbeFailureGate,
  runAddableProbePlan,
  type AddServerProbePlan,
  type WslAddServerView,
} from "./settings-model"
import type { WslInstalledDistro, WslServersPlatform, WslServersState } from "./types"

export function useWslAddServerProbes(input: {
  state: Accessor<WslServersState | undefined>
  api: WslServersPlatform
  view: Accessor<WslAddServerView>
  adding: Accessor<boolean>
  busy: Accessor<boolean>
  selectedDistro: Accessor<Option.Option<string>>
  addableInstalledDistros: Accessor<WslInstalledDistro[]>
  onError: (error: unknown) => void
}) {
  const gate = createProbeFailureGate()
  const probe = useMutation(() => ({
    mutationFn: async (command: AddServerProbePlan) => {
      if (command.kind === "addable") {
        await runAddableProbePlan({ plan: command.plan, api: input.api })
        return
      }
      if (command.plan.action === "probeRuntime") await input.api.probeRuntime()
      if (command.plan.action === "refreshDistros") await input.api.refreshDistros()
    },
    onError: input.onError,
    onSettled: (_result, error, command) => {
      if (command) gate.settle(command.key, error)
    },
  }))

  createEffect(() => {
    if (probe.isPending) return
    const command = addServerProbePlan({
      state: input.state(),
      view: input.view(),
      adding: input.adding(),
      busy: input.busy(),
      selectedDistro: input.selectedDistro(),
      addableInstalledDistros: input.addableInstalledDistros(),
    }).pipe(Option.filter((plan) => gate.accepts(plan.key)))
    if (Option.isSome(command)) probe.mutate(command.value)
  })

  return {
    probingAddable: () => probe.isPending && probe.variables?.kind === "addable",
    resetProbeFailure: () => gate.reset(),
  }
}
