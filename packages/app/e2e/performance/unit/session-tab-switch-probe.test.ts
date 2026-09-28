import { expect, test } from "bun:test"
import {
  measureSessionSwitch,
  type SessionSwitchPage,
  type SessionSwitchProbeInput,
} from "../timeline/session-tab-switch-probe"

type ProbeInstall = [pageFunction: (input: SessionSwitchProbeInput) => void, input: SessionSwitchProbeInput]

function testPage(waitFailure?: Error) {
  const stops: unknown[] = []
  function evaluate(...args: ProbeInstall): Promise<void>
  function evaluate<R>(pageFunction: () => R): Promise<R>
  async function evaluate<R>(...args: ProbeInstall | [pageFunction: () => R]) {
    if (args.length === 2) return
    stops.push(undefined)
    return args[0]()
  }
  const page: SessionSwitchPage = {
    evaluate,
    waitForFunction: async () => {
      if (waitFailure) throw waitFailure
    },
  }
  return { page, stops }
}

function input(run: () => Promise<void>) {
  return {
    destinationIDs: ["destination"],
    sourceIDs: ["source"],
    lastID: "destination",
    href: "/session/destination",
    switch: run,
  }
}

test("stops sampling when the session switch fails", async () => {
  const failure = new Error("switch failed")
  const context = testPage()

  const error = await measureSessionSwitch(
    context.page,
    input(async () => Promise.reject(failure)),
  ).then(
    () => "resolved",
    (reason: unknown) => reason,
  )

  expect(error).toBe(failure)

  expect(context.stops).toHaveLength(1)
})

test("stops sampling when the stable wait fails", async () => {
  const failure = new Error("stable wait failed")
  const context = testPage(failure)

  const error = await measureSessionSwitch(
    context.page,
    input(async () => {}),
  ).then(
    () => "resolved",
    (reason: unknown) => reason,
  )

  expect(error).toBe(failure)

  expect(context.stops).toHaveLength(1)
})
