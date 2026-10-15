// Scripted end-to-end runs of a live-check folder (D15, SD-11): the folder and the demo seed committed in a fresh git
// repository, a real `opencode serve` of this tree, and a scripted model that answers every builder, verifier,
// reviewer and scenario judge turn of the harness. No paid model. The pattern of the conformance suite: the seed and
// its shared modules come from `test/task-harness/arms/workspace.ts`, the server and the status reader from
// `test/task-harness/arms`, and each request is read with the conformance `parse`.
import fs from "node:fs"
import path from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { reply, TestLLMServer, type Hit, type Item, type Reply } from "../../lib/llm-server"
import * as Arms from "../../task-harness/arms"
import * as Status from "../../task-harness/arms/status"
import * as Workspace from "../../task-harness/arms/workspace"
import { parse, type Request } from "../../task-harness/scripts"

const repoRoot = path.resolve(import.meta.dir, "../../../../..")
// Beside the conformance runs, so the seed's installed modules are shared with them.
const runDir = path.join(repoRoot, ".task-conformance", "conformance", "live-check")
const POLL_MS = 200
const HOLD_MS = 120_000

/** The files a leaf's scripted builder writes, by path in the repository, before it calls `task_ready`. */
export type Leaves = Readonly<Record<string, Readonly<Record<string, string>>>>

export interface Options {
  /** The folder under task-formats/blend, for example `example-scenarios.spec`. */
  readonly folder: string
  readonly leaves: Leaves
  /** A unit whose first builder request waits, unanswered, until `until` holds for the status (or two minutes). */
  readonly hold?: { readonly unit: string; readonly until: (status: Status.Status | undefined) => boolean }
}

export interface Run extends AsyncDisposable {
  readonly repo: string
  /** Every harness request the scripted model received, in arrival order. */
  readonly requests: ReadonlyArray<Request>
  /** The status of the run, sampled every 200 ms until `probe` gives a value; fails after `ms`. */
  until<T>(what: string, ms: number, probe: (status: Status.Status | undefined) => T | undefined): Promise<T>
}

// The scripted answer to one request: a builder writes its leaf's files, one per step, then calls `task_ready`; a
// verifier, reviewer or judge trusts every id it was asked to judge, then ends its turn.
const answer = (leaves: Leaves, request: Request): Reply | undefined => {
  if (!request.role || !request.unit) return undefined
  if (request.role !== "builder") {
    if (request.step > 0) return reply().text("Verdicts recorded.").stop()
    return reply().tool("verdict", { verdicts: request.judges.map((id) => ({ id, verdict: "trusted" })) })
  }
  const actions = [
    ...Object.entries(leaves[request.unit] ?? {}).map(([filePath, content]) => ({
      name: "write",
      input: { filePath, content },
    })),
    { name: "task_ready", input: { summary: `${request.unit}: the files are written.` } },
  ]
  const action = actions[request.step]
  if (!action) return reply().text(`${request.unit}: done.`).stop()
  return reply().tool(action.name, action.input)
}

/** Starts a scripted run of `/task task-formats/blend/<folder>`. */
export async function start(options: Options): Promise<Run> {
  const ws = Workspace.create(runDir, `${options.folder}-${process.pid}-${Date.now()}`)
  fs.cpSync(
    path.join(repoRoot, "task-formats/blend", options.folder),
    path.join(ws.repo, "task-formats/blend", options.folder),
    {
      recursive: true,
    },
  )
  Workspace.git(ws.repo, "add", "-A")
  Workspace.git(ws.repo, "commit", "-q", "-m", `add ${options.folder}`)

  const requests: Request[] = []
  let held = false
  const runtime = ManagedRuntime.make(TestLLMServer.layer)
  const llm = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* TestLLMServer
    }),
  )
  await runtime.runPromise(
    llm.respond(async (hit: Hit): Promise<Item | Reply | undefined> => {
      const request = parse(hit)
      requests.push(request)
      const hold = options.hold
      if (hold && !held && request.role === "builder" && request.unit === hold.unit && request.step === 0) {
        held = true
        const deadline = Date.now() + HOLD_MS
        while (!hold.until(Status.read(ws.repo)) && Date.now() < deadline) await Bun.sleep(POLL_MS)
      }
      return answer(options.leaves, request)
    }),
  )
  const patterns = [ws.dir]
  const adapter = await Arms.open({ arm: "o2", workspace: ws, model: { kind: "scripted", url: llm.url } }).catch(
    async (error: unknown) => {
      await Promise.race([runtime.dispose(), Bun.sleep(5_000)])
      Arms.sweep(patterns)
      throw error
    },
  )
  await adapter.start(`task-formats/blend/${options.folder}`)

  return {
    repo: ws.repo,
    requests,
    async until(what, ms, probe) {
      const deadline = Date.now() + ms
      for (;;) {
        const status = adapter.status()
        const value = probe(status)
        if (value !== undefined) return value
        if (Date.now() > deadline)
          throw new Error(`${what}: not reached within ${ms / 1000} s; ${Status.summary(status)}`)
        await Bun.sleep(POLL_MS)
      }
    },
    async [Symbol.asyncDispose]() {
      await adapter.close()
      await Promise.race([runtime.dispose(), Bun.sleep(5_000)])
      Arms.sweep(patterns)
    },
  }
}

/** The run states that end a run. */
export const ENDS: ReadonlyArray<Status.RunState> = ["done", "cancelled", "needs_human", "budget_exhausted", "failed"]

export * as Scripted from "./scripted"
