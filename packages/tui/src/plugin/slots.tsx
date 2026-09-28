import type { TuiPluginApi, TuiSlotContext, TuiSlotMap, TuiSlotProps } from "@opencode-ai/plugin/tui"
import type { SlotRegistry } from "@opentui/core"
import { createSlot, createSolidSlotRegistry, type JSX, type SolidPlugin } from "@opentui/solid"
import { Effect } from "effect"
import { createSignal } from "solid-js"
import { isRecord } from "../util/record"

type RuntimeSlotMap = TuiSlotMap<Record<string, object>>
type SlotView = <Name extends string>(props: TuiSlotProps<Name>) => JSX.Element | null

export type HostSlotPlugin<Slots extends Record<string, object> = {}> = SolidPlugin<TuiSlotMap<Slots>, TuiSlotContext>
export type HostPluginApi = TuiPluginApi
export type HostSlots = {
  register: {
    (plugin: HostSlotPlugin): () => void
    <Slots extends Record<string, object>>(plugin: HostSlotPlugin<Slots>): () => void
  }
  dispose: () => void
}

function isHostSlotPlugin(value: unknown): value is HostSlotPlugin<Record<string, object>> {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string") return false
  return isRecord(value.slots)
}

// Renders nothing until setup() installs a slot registry: Solid renders an undefined JSX.Element as no output.
function empty(): JSX.Element {
  return undefined
}

export function createSlots() {
  const [view, setView] = createSignal<SlotView>(empty)
  const Slot: SlotView = (props) => view()(props)

  return {
    Slot,
    setup(api: HostPluginApi): HostSlots {
      const registry: SlotRegistry<JSX.Element, RuntimeSlotMap, TuiSlotContext> = createSolidSlotRegistry(
        api.renderer,
        { theme: api.theme },
        {
          onPluginError(event) {
            Effect.runFork(
              Effect.logError("[tui.slot] plugin error", {
                plugin: event.pluginId,
                slot: event.slot,
                phase: event.phase,
                source: event.source,
                message: event.error.message,
              }),
            )
          },
        },
      )
      const slot = createSlot<RuntimeSlotMap, TuiSlotContext>(registry)
      setView(() => (props: TuiSlotProps) => slot(props))

      return {
        register(plugin: HostSlotPlugin) {
          if (!isHostSlotPlugin(plugin)) return () => {}
          return registry.register(plugin)
        },
        dispose() {
          setView(() => empty)
        },
      }
    },
    clear() {
      setView(() => empty)
    },
  }
}
