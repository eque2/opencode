import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { MutableHashMap, Option } from "effect"
import type { WslServersController } from "./servers"
import { requireWslIpcString, requireWslIpcStrings } from "./policy"
import type { WslServersState } from "../../preload/types"
import { nativeT } from "../native-translations"

export function registerWslIpcHandlers(controller: WslServersController) {
  if (process.platform !== "win32") {
    registerUnavailableWslIpcHandlers()
    return
  }

  const subscriptions = MutableHashMap.empty<number, () => void>()
  const unsubscribe = (id: number) => {
    const off = MutableHashMap.get(subscriptions, id)
    if (Option.isNone(off)) return
    off.value()
    MutableHashMap.remove(subscriptions, id)
  }

  app.once("will-quit", () => {
    MutableHashMap.forEach(subscriptions, (off) => off())
    MutableHashMap.clear(subscriptions)
  })

  ipcMain.handle("wsl-servers-subscribe", (event) => {
    const id = event.sender.id
    if (MutableHashMap.has(subscriptions, id)) return
    MutableHashMap.set(
      subscriptions,
      id,
      controller.subscribe((payload) => {
        if (event.sender.isDestroyed()) {
          unsubscribe(id)
          return
        }
        event.sender.send("wsl-servers-event", payload)
      }),
    )
    event.sender.once("destroyed", () => unsubscribe(id))
  })
  ipcMain.handle("wsl-servers-unsubscribe", (event) => unsubscribe(event.sender.id))
  ipcMain.handle("wsl-servers-get-state", () => controller.getState())
  ipcMain.handle("wsl-servers-probe-runtime", () => controller.probeRuntime())
  ipcMain.handle("wsl-servers-refresh-distros", () => controller.refreshDistros())
  ipcMain.handle("wsl-servers-install-wsl", () => controller.installWsl())
  ipcMain.handle("wsl-servers-install-distro", (_event: IpcMainInvokeEvent, name: string) =>
    controller.installDistro(requireWslIpcString("distro", name)),
  )
  ipcMain.handle("wsl-servers-probe-addable", (_event: IpcMainInvokeEvent, distros: string[]) =>
    controller.probeAddable(requireWslIpcStrings("distro", distros)),
  )
  ipcMain.handle("wsl-servers-install-opencode", (_event: IpcMainInvokeEvent, name: string) =>
    controller.installOpencode(requireWslIpcString("distro", name)),
  )
  ipcMain.handle("wsl-servers-open-terminal", (_event: IpcMainInvokeEvent, name: string) =>
    controller.openTerminal(requireWslIpcString("distro", name)),
  )
  ipcMain.handle("wsl-servers-add", (_event: IpcMainInvokeEvent, distro: string) =>
    controller.addServer(requireWslIpcString("distro", distro)),
  )
  ipcMain.handle("wsl-servers-remove", (_event: IpcMainInvokeEvent, id: string) =>
    controller.removeServer(requireWslIpcString("server id", id)),
  )
  ipcMain.handle("wsl-servers-start", (_event: IpcMainInvokeEvent, id: string) =>
    controller.startServer(requireWslIpcString("server id", id)),
  )
}

function registerUnavailableWslIpcHandlers() {
  const unavailable = () => {
    throw new Error(nativeT("desktop.wsl.error.windowsOnly"))
  }
  const state = (): WslServersState => ({
    runtime: {
      available: false,
      version: null,
      error: nativeT("desktop.wsl.error.windowsOnly"),
    },
    installed: [],
    online: [],
    distroProbes: {},
    opencodeChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
  })

  ipcMain.handle("wsl-servers-subscribe", (event) => {
    event.sender.send("wsl-servers-event", { type: "state", state: state() })
  })
  ipcMain.handle("wsl-servers-unsubscribe", () => undefined)
  ipcMain.handle("wsl-servers-get-state", () => state())
  ipcMain.handle("wsl-servers-probe-runtime", unavailable)
  ipcMain.handle("wsl-servers-refresh-distros", unavailable)
  ipcMain.handle("wsl-servers-install-wsl", unavailable)
  ipcMain.handle("wsl-servers-install-distro", unavailable)
  ipcMain.handle("wsl-servers-probe-addable", unavailable)
  ipcMain.handle("wsl-servers-install-opencode", unavailable)
  ipcMain.handle("wsl-servers-open-terminal", unavailable)
  ipcMain.handle("wsl-servers-add", unavailable)
  ipcMain.handle("wsl-servers-remove", unavailable)
  ipcMain.handle("wsl-servers-start", unavailable)
}
