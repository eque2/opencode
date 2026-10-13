import { describe, expect, test } from "bun:test"
import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Effect, FileSystem, Layer, Option } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import type { Fact } from "@/task/core/model"
import { HarnessCommand } from "@/task/harness-plugin/command"
import { HarnessLog } from "@/task/harness-plugin/log"
import { HarnessMessages } from "@/task/harness-plugin/messages"
import { HarnessRegistry } from "@/task/harness-plugin/registry"
import { HarnessRunner } from "@/task/harness-plugin/runner"
import { TaskLimits } from "@/task/limits"

// The parts of option O3, the task harness as a plugin, that need no opencode server: its JSONL log and fold, its
// protocol texts, its role permissions, its repetition check, and how a run is claimed and learns of trust. The
// hooks and the lifecycle are covered by the conformance suite.

const fixture = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")

const load = async () => {
  const { spec } = await Effect.runPromise(Blend.load(fixture).pipe(Effect.provide(NodeServices.layer)))
  if (!spec) throw new Error("the fixture does not load")
  return spec
}

const SPEC_PATH = "task-formats/blend/release-notes.spec"

const planOf = (spec: BlendModel.Spec, root?: string) =>
  HarnessCommand.plan({
    spec,
    specPath: SPEC_PATH,
    path: root ? `${SPEC_PATH}/T1-release-notes.task/T1.1-commit-parser.task` : SPEC_PATH,
    root: Option.fromNullishOr(root),
  })

describe("the JSONL log", () => {
  const SPEC = SPEC_PATH
  const started: Fact = { type: "run.started", at: 1 }
  const trust: Fact = { type: "outside.trusted", at: 2, id: "T9" }
  const begun: Fact = {
    type: "task.started",
    at: 3,
    task: "T1.1",
    worktree: "/repo/.opencode/task/worktrees/T1.1",
    branch: "task/T1.1",
    base: "abc",
    session: "ses_1",
  }

  test("a line round-trips, and a line that does not decode is skipped", () => {
    const text = [
      HarnessLog.encode({ spec: HarnessLog.DIRECTORY, fact: trust }),
      HarnessLog.encode({ spec: SPEC, fact: started }),
      HarnessLog.encode({ spec: "x", fact: started }).slice(0, 30), // an entry a crash cut short
      HarnessLog.encode({ spec: SPEC, fact: begun }),
    ].join("")
    expect(HarnessLog.parse(text)).toEqual([
      { spec: HarnessLog.DIRECTORY, fact: trust },
      { spec: SPEC, fact: started },
      { spec: SPEC, fact: begun },
    ])
  })

  test("the latest run of a spec starts at its last run.started; directory trust is separate", () => {
    const entries: HarnessLog.Entry[] = [
      { spec: SPEC, fact: started },
      { spec: SPEC, fact: { type: "run.ended", at: 2, state: "done" } },
      { spec: HarnessLog.DIRECTORY, fact: trust },
      { spec: "other.spec", fact: { type: "run.started", at: 4 } },
      { spec: SPEC, fact: { type: "run.started", at: 5 } },
      { spec: SPEC, fact: begun },
    ]
    expect(HarnessLog.latestRun(entries, SPEC)).toEqual(Option.some([{ type: "run.started", at: 5 }, begun]))
    expect(HarnessLog.latestRun(entries, "none.spec")).toEqual(Option.none())
    expect(HarnessLog.directoryTrust(entries)).toEqual(["T9"])
  })

  test("the fold runs the facts through the transition table", async () => {
    const plan = planOf(await load(), "T1.1")
    const state = HarnessLog.fold(plan, [started, trust, begun, { type: "task.ready", at: 4, task: "T1.1", head: "def" }])
    expect(state.run.state).toBe("running")
    expect(state.tasks["T1.1"]).toMatchObject({ state: "proving", attempts: 1, session: "ses_1", head: "def" })
    expect(state.history.map((entry) => `${entry.unit}:${entry.to}`)).toEqual([
      "run:running",
      "T9:trusted",
      "T1.1:building",
      "T1.1:proving",
    ])
  })
})

describe("the plan", () => {
  test("a task folder plans its subtree and the scenarios it can satisfy with outside ids", async () => {
    const spec = await load()
    const leaf = planOf(spec, "T1.1")
    expect(leaf.tasks.map((task) => task.id)).toEqual(["T1.1"])
    expect(leaf.scenarios.every((scenario) => scenario.needs.every((id) => id === "T1.1" || id in spec.outside))).toBe(true)
    const all = planOf(spec)
    expect(all.tasks.map((task) => task.id)).toEqual(spec.tasks.map((task) => task.id))
    expect(all.budget("T1.1")).toBe(3)
  })
})

describe("the protocol messages", () => {
  const JUDGE = /^[ \t]*(?:[-*][ \t]+)?judge[ \t]+([A-Za-z0-9._-]+)/gm

  test("a builder's first attempt carries the marker; a later one the attempt and one reopen line per id", async () => {
    const spec = await load()
    const task = spec.tasks.find((each) => each.id === "T1.1")
    if (!task) throw new Error("no task T1.1")
    const first = HarnessMessages.builderMessage({ first: true, attempt: 1, reopen: [], task, spec, trusted: () => false })
    expect(first.split("\n").slice(0, 2)).toEqual(["task-harness role=builder task=T1.1", "task-harness attempt=1"])
    const second = HarnessMessages.builderMessage({
      first: false,
      attempt: 2,
      reopen: [{ id: "T1.1.c3", reason: "the refs test\ndoes not cover Refs #" }],
      task,
      spec,
      trusted: () => false,
    })
    expect(second.split("\n").slice(0, 2)).toEqual([
      "task-harness attempt=2",
      "reopen T1.1.c3: the refs test | does not cover Refs #",
    ])
    // The scenarios T1.1 completes alone: their [S<n>] tests are its builder's.
    expect([...first.matchAll(/^- (S\d+): /gm)].map((match) => match[1])).toEqual(["S2", "S7"])
  })

  test("a judge round carries the marker and one judge line per id; the follow-up only the judge lines", () => {
    const text = HarnessMessages.judgeMessage({
      role: "reviewer",
      kind: "task",
      unit: "T1",
      judge: [{ id: "T1.e1", text: "one\ntwo" }],
      about: ["You review task T1."],
    })
    expect(text.split("\n")[0]).toBe("task-harness role=reviewer task=T1")
    expect([...text.matchAll(JUDGE)].map((match) => match[1])).toEqual(["T1.e1"])
    const again = HarnessMessages.judgeMissingMessage([{ id: "S3", text: "three" }])
    expect(again).not.toContain("task-harness role=")
    expect([...again.matchAll(JUDGE)].map((match) => match[1])).toEqual(["S3"])
  })
})

describe("the role permissions", () => {
  // opencode reads a permission config in key order and the last matching rule wins.
  const last = (permission: Record<string, "allow" | "deny">, tool: string) =>
    HarnessMessages.ruleset(permission).findLast((rule) => rule.permission === tool || rule.permission === "*")?.action

  test("each role denies everything first, then allows only its own tools", () => {
    expect(Object.keys(HarnessMessages.builderPermission)[0]).toBe("*")
    expect(last(HarnessMessages.builderPermission, "task_ready")).toBe("allow")
    expect(last(HarnessMessages.builderPermission, "verdict")).toBe("deny")
    expect(last(HarnessMessages.verifierPermission, "verdict")).toBe("allow")
    expect(last(HarnessMessages.verifierPermission, "task_ready")).toBe("deny")
    expect(last(HarnessMessages.verifierPermission, "edit")).toBe("deny")
    expect(last(HarnessMessages.notePermission, "read")).toBe("deny")
  })
})

describe("the repetition check", () => {
  test("the 3rd identical call in a row trips it; another input or a new turn starts the count again", () => {
    const session = "ses_repetition"
    HarnessRegistry.watch(session, 3)
    const read = { filePath: "package.json" }
    expect(HarnessRegistry.noteCall(session, "read", read)).toEqual(Option.none())
    expect(HarnessRegistry.noteCall(session, "read", { filePath: "other" })).toEqual(Option.none())
    expect(HarnessRegistry.noteCall(session, "read", read)).toEqual(Option.none())
    expect(HarnessRegistry.noteCall(session, "read", read)).toEqual(Option.none())
    HarnessRegistry.startTurn(session)
    expect(HarnessRegistry.noteCall(session, "read", read)).toEqual(Option.none())
    expect(HarnessRegistry.noteCall(session, "read", read)).toEqual(Option.none())
    const reason = "repetition: 3 identical read calls in a row"
    expect(HarnessRegistry.noteCall(session, "read", read)).toEqual(Option.some(reason))
    expect(HarnessRegistry.takeRepeated(session)).toEqual(Option.some(reason))
    expect(HarnessRegistry.takeRepeated(session)).toEqual(Option.none())
  })

  test("a session that is not a watched builder is never stopped", () => {
    const read = { filePath: "package.json" }
    for (const _ of [1, 2, 3, 4]) expect(HarnessRegistry.noteCall("ses_verifier", "read", read)).toEqual(Option.none())
  })

  test("the tools' records are taken once", () => {
    HarnessRegistry.recordVerdicts("ses_judge", [{ id: "T1.1.c1", verdict: "trusted" }])
    HarnessRegistry.recordVerdicts("ses_judge", [{ id: "T1.1.c2", verdict: "rejected", reason: "no test" }])
    expect(HarnessRegistry.takeVerdicts("ses_judge").map((verdict) => verdict.id)).toEqual(["T1.1.c1", "T1.1.c2"])
    expect(HarnessRegistry.takeVerdicts("ses_judge")).toEqual([])
    HarnessRegistry.recordReady("ses_builder", { summary: "done" })
    HarnessRegistry.startTurn("ses_builder")
    expect(HarnessRegistry.takeReady("ses_builder")).toEqual(Option.none())
  })
})

// --- runs without a server ---------------------------------------------------------------------------------------

// T2 of provider-ordering-admin waits on `outside` ids, so its run makes no SDK call: the client is never reached.
const T2_SPEC = "task-formats/blend/provider-ordering-admin.spec"
const T2_TASK = `${T2_SPEC}/T2-services.task`
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:9" })

// A directory that holds a copy of the T2 spec.
const scratch = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-harness-o3-"))
  fs.cpSync(path.resolve(import.meta.dir, "../../../..", T2_SPEC), path.join(directory, T2_SPEC), { recursive: true })
  return directory
}

const registered = async (directory: string) => {
  for (let i = 0; i < 100 && HarnessRegistry.runsIn(directory).length === 0; i++) await Bun.sleep(50)
  return HarnessRegistry.runsIn(directory)
}

// Halts the directory's runs, then removes it.
const close = async (directory: string) => {
  const runs = await registered(directory)
  await Effect.runPromise(Effect.forEach(runs, (run) => run.halt, { discard: true }))
  fs.rmSync(directory, { recursive: true, force: true })
}

describe("the run claim", () => {
  test("of two /task calls for one spec at once, one starts the run and the other is refused", async () => {
    const directory = scratch()
    try {
      const handle = HarnessCommand.handle({ client, directory, session: "ses_root", arguments: T2_TASK }).pipe(
        Effect.flip,
        Effect.map((stop) => stop.message),
      )
      const messages = await Effect.runPromise(
        Effect.all([handle, handle], { concurrency: "unbounded" }).pipe(Effect.provide(NodeServices.layer)),
      )
      expect(messages.filter((message) => message.includes("running"))).toHaveLength(1)
      expect(messages.filter((message) => message.includes("already going on"))).toHaveLength(1)
    } finally {
      await close(directory)
    }
  })
})

describe("the trust a run learns of", () => {
  test("a /task trust that lands between the run's log read and its register still reaches the run", async () => {
    const directory = scratch()
    const log = path.join(directory, ".opencode", "task", "events.jsonl")
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, "")
    const trust = HarnessLog.encode({ spec: HarnessLog.DIRECTORY, fact: { type: "outside.trusted", at: 1, id: "T99" } })
    // The run's first read of the log returns it as it was; then the trust lands, in the log only.
    const landing = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        let first = true
        return FileSystem.FileSystem.of({
          ...fileSystem,
          readFileString: (file, encoding) =>
            fileSystem.readFileString(file, encoding).pipe(
              Effect.tap(() => {
                if (!first || file !== log) return Effect.void
                first = false
                return fileSystem.writeFileString(log, trust, { flag: "a" })
              }),
            ),
        })
      }),
    ).pipe(Layer.provide(NodeFileSystem.layer))
    const { spec } = await Effect.runPromise(
      Blend.load(path.join(directory, T2_SPEC)).pipe(Effect.provide(NodeServices.layer)),
    )
    if (!spec) throw new Error("the T2 copy does not load")
    const start: HarnessRunner.Start = {
      client,
      directory,
      specDir: path.join(directory, T2_SPEC),
      plan: HarnessCommand.plan({ spec, specPath: T2_SPEC, path: T2_TASK, root: Option.some("T2") }),
      root: "ses_root",
      limits: TaskLimits.scripted,
    }
    Effect.runFork(HarnessRunner.run(start).pipe(Effect.provide(Layer.mergeAll(landing, NodePath.layer))))
    try {
      const reached = () =>
        HarnessLog.parse(fs.readFileSync(log, "utf8")).some(
          (entry) => entry.spec === T2_SPEC && entry.fact.type === "outside.trusted" && entry.fact.id === "T99",
        )
      for (let i = 0; i < 100 && !reached(); i++) await Bun.sleep(50)
      expect(reached()).toBe(true)
    } finally {
      await close(directory)
    }
  })
})
