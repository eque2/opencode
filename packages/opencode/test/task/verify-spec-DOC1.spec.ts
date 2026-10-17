import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer, Option } from "effect"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { jobsOf, refusalOf, runTask, seed, SPEC } from "./lib/command"
import { exhaustLeaf, facts, loadPlan, obligationsOf, trustLeaf } from "./lib/machine"

// Scenario DOC1 (spec task-harness-feedback, AC 1, D10-D15; task T3.11): the blend format README answers questions 1,
// 3 and 4 in a Validation section.
//
//   Given the blend format README
//   When a reader opens its Validation section
//   Then it says what runs before any work starts and how a refusal appears
//   And it lists every rule R1 to R13 with the place that enforces it
//   And it says how the run machine holds the order and which graph faults are refused
//   And it names the six fault folders and the two live-check folders
//
// The test reads the real README (task-formats/blend/README.md) and holds each claim of its Validation section against
// the real code: the `/task` command (`TaskCommand.run`) in a git instance with committed copies of the spec folders,
// the loader (`Blend.load`), the run machine (`TaskEvents.fold` over the engine) and the source files the rule table
// names. Nothing is re-implemented: the expected texts come from the README, the actual ones from the code.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const ROOT = path.resolve(import.meta.dir, "../../../..")
const BLEND = "task-formats/blend"
const SOURCE = path.join(ROOT, "packages/opencode/src/task")
const readme = readFileSync(path.join(ROOT, BLEND, "README.md"), "utf8")

// The text from a heading line to the next heading of the same level (or the end).
const part = (text: string, heading: string) => {
  const level = heading.split(" ")[0] ?? ""
  const start = text.indexOf(`\n${heading}\n`)
  if (start < 0) return ""
  const next = text.indexOf(`\n${level} `, start + 1)
  return text.slice(start, next < 0 ? text.length : next)
}
// The cells of a Markdown table row.
const cells = (row: string) =>
  row
    .split(" | ")
    .map((cell) => cell.replace(/^\| ?/, "").replace(/ ?\|$/, "").trim())
    .filter((cell) => cell !== "")
// The fragments of a text written in `backticks` and in "double quotes".
const ticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "")
const quoted = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "")

const validation = part(readme, "## Validation")
const before = part(validation, "### Before any work starts")
const enforced = part(validation, "### Where each rule is enforced")
const refusal = part(validation, "### How a refusal appears")
const order = part(validation, "### How the run machine holds the order")
const examples = part(validation, "### The example folders")

// The README wraps its prose at a fixed width, so a prose check reads a section with each run of white space as one.
const flat = (text: string) => text.replace(/\s+/g, " ")
// A table row of a section, by its first cell.
const rowOf = (section: string, first: string) => section.split("\n").find((line) => line.startsWith(`| ${first} |`))

it.instance(
  "[DOC1] the Validation section says what runs before any work starts and how a refusal appears, as the real /task does",
  () =>
    Effect.gen(function* () {
      // Given the README, when a reader opens its Validation section (it replaces the old Validating section).
      expect(readme).not.toContain("\n## Validating\n")
      expect(validation).not.toBe("")
      // Then it says what runs before any work starts: the loader, in the command, before the git check and the job.
      expect(flat(before)).toContain(
        "`/task <path>` runs `TaskCommand.run` (`packages/opencode/src/task/core/command.ts`)",
      )
      expect(flat(before)).toContain("`Blend.load`")
      expect(flat(before)).toContain("the load comes before the git check, the plan, the claim and the job")
      expect(flat(before)).toContain("starts no work, opens no worktree and makes no model request")
      expect(existsSync(path.join(ROOT, "packages/opencode/src/task/core/command.ts"))).toBe(true)

      // And how a refusal appears: a header, one line for each failure, an optional hint; `run.reason` holds the lines.
      expect(flat(refusal)).toContain("a header, one line for each failure, and an optional hint")
      expect(flat(refusal)).toContain("`run.reason` holds only the failure lines, joined with a newline")
      const loaderRow = cells(rowOf(refusal, "Loader failures") ?? "")
      const plainRow = cells(rowOf(refusal, "A plain line (the git checks, a spec with no task)") ?? "")
      expect(loaderRow).toHaveLength(4)
      expect(plainRow).toHaveLength(4)
      const [loaderHeader] = quoted(loaderRow[1] ?? "")
      const [loaderHint] = quoted(loaderRow[3] ?? "")
      const [plainHeader] = quoted(plainRow[1] ?? "")
      expect(loaderHeader).toBe("Refused <path>: N failures. No work started.")
      expect(loaderRow[1]).toContain('("1 failure" for one)')
      expect(ticked(loaderRow[2] ?? "")).toEqual(["R<n> <path>: <message>"])
      expect(loaderHint).toBe("Fix each line, then type /task <path> again.")
      expect(plainHeader).toBe("Refused <path>. No work started.")
      expect(plainRow[3]).toBe("none")

      // The real command, in a checkout with an untracked file (which the git check refuses).
      const faults = `${BLEND}/example-format-faults.spec`
      const directory = yield* seed(faults, SPEC)
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(path.join(directory, "scratch.txt"), "not committed\n")

      // A spec that fails rules is refused by the loader, not by the git check: the load runs first.
      const loaded = yield* Blend.load(path.join(directory, faults))
      const lines = TaskCommand.loadFailures(loaded)
      expect(lines.length).toBeGreaterThan(1)
      for (const line of lines) expect(line).toMatch(/^R\d+ \S+: .+$/)
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const header = (loaderHeader ?? "").replace("<path>", faults).replace("N failures", `${lines.length} failures`)
      const hint = (loaderHint ?? "").replace("<path>", faults)
      expect(yield* runTask(harness, faults, jobs)).toEqual([[header, ...lines, hint].join("\n")])
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: faults, reason: lines.join("\n") })
      // No work started: no job, no lease.
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())

      // A valid spec in the same checkout passes the loader and is refused by the git check, with a plain line.
      const plain = yield* runTask(harness, SPEC, jobs)
      expect(plain).toHaveLength(1)
      const [plainHead, gitLine, ...rest] = (plain[0] ?? "").split("\n")
      expect(plainHead).toBe((plainHeader ?? "").replace("<path>", SPEC))
      expect(gitLine).toContain("scratch.txt")
      expect(rest).toEqual([])
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, reason: gitLine })
      expect(jobs.starts).toEqual([])
    }),
  { git: true },
  120_000,
)

it.live("[DOC1] the Validation section lists every rule R1 to R13 with the place in the code that enforces it", () =>
  Effect.sync(() => {
    const rows = enforced.split("\n").filter((line) => /^\| R\d+ \|/.test(line))
    const RULES = Array.from({ length: 13 }, (_, index) => `R${index + 1}`)
    // Every rule, once, in order.
    expect(rows.map((row) => cells(row)[0])).toEqual(RULES)
    expect(enforced).toContain("The paths are relative to `packages/opencode/src/task`.")
    for (const row of rows) {
      const [rule = "", where = "", when = ""] = cells(row)
      const files = ticked(where).filter((name) => name.endsWith(".ts"))
      // Each place is a real source file, and one of them emits the rule's failure lines.
      expect({ rule, files: files.length > 0 }).toEqual({ rule, files: true })
      for (const file of files)
        expect({ rule, file, exists: existsSync(path.join(SOURCE, file)) }).toEqual({ rule, file, exists: true })
      const emits = new RegExp(`["\`]${rule}[" ]`)
      expect({
        rule,
        emitted: files.some((file) => emits.test(readFileSync(path.join(SOURCE, file), "utf8"))),
      }).toEqual({
        rule,
        emitted: true,
      })
      // When it runs: R12 at run time, every other rule at load.
      expect({ rule, when }).toEqual({ rule, when: rule === "R12" ? "runtime" : expect.stringMatching(/^load/) })
    }
    expect(enforced).toContain("R12 is a runtime check")
  }),
)

it.live(
  "[DOC1] the Validation section says how the run machine holds the order and which graph faults are refused, as the engine and the loader do",
  () =>
    Effect.gen(function* () {
      // How the run machine holds the order: readiness and the blocked cascade live in the run machine.
      expect(order).toContain("`packages/opencode/src/task/engine-xstate/machine.ts`")
      expect(existsSync(path.join(ROOT, "packages/opencode/src/task/engine-xstate/machine.ts"))).toBe(true)
      const prose = flat(order)
      expect(prose).toContain(
        "A task is ready only when every task of its effective `after` (its own and each ancestor's) is trusted",
      )
      expect(prose).toContain("moves to `blocked`")
      expect(prose).toContain("A parent waits for its children")
      const [blockedReason] = quoted(order)
      expect(blockedReason).toBe("blocked by T1.1: budget exhausted")

      // The engine on the cascade folder's plan: T1.2 is after T1.1, T1.3 is independent, T1.1's budget is 1.
      const plan = yield* loadPlan("example-cascade.spec")
      expect(plan.budget("T1.1")).toBe(1)
      const fold = (list: ReadonlyArray<Fact>) => TaskEvents.fold(TaskEngineXState.XStateEngine, plan, list)
      const f = facts()
      const started = [f.runStarted()]
      const atStart = fold(started)
      expect(atStart.hasTag("T1.1:ready")).toBe(true)
      expect(atStart.hasTag("T1.3:ready")).toBe(true)
      expect(atStart.hasTag("T1.2:ready")).toBe(false)
      expect(TaskEngineXState.unitState(atStart, "T1.2")).toBe("waiting")
      // T1.2 is ready once T1.1 is trusted.
      expect(fold([...started, ...trustLeaf(plan, f, "T1.1")]).hasTag("T1.2:ready")).toBe(true)
      // T1.1 ends dead: T1.2 and the parent T1 move to blocked with the README's reason; T1.3 is still ready.
      const dead = fold([...started, ...exhaustLeaf(facts(10), "T1.1", obligationsOf(plan, "T1.1")[0] ?? "", 1)])
      expect(TaskEngineXState.unitState(dead, "T1.1")).toBe("budget_exhausted")
      expect(TaskEngineXState.unitState(dead, "T1.2")).toBe("blocked")
      expect(TaskEngineXState.view(dead).tasks["T1.2"]?.reason).toBe(blockedReason)
      expect(TaskEngineXState.unitState(dead, "T1")).toBe("blocked")
      expect(dead.hasTag("T1.3:ready")).toBe(true)

      // Which graph faults are refused, each with the rule the README names; the loader builds no spec for them.
      const faults = order.slice(order.indexOf("The loader refuses these graph faults"))
      const bullets = faults.split("\n- ").slice(1)
      expect(bullets).toHaveLength(4)
      expect(bullets[0]).toContain("a cycle in `after`, including a task after itself (`T1.1 → T1.1`) (R7)")
      expect(bullets[1]).toContain("a task after its own ancestor or descendant (R7)")
      expect(bullets[2]).toContain("an unknown reference")
      expect(bullets[2]).toContain("(R6)")
      expect(bullets[3]).toContain("outside this run that is not trusted (R12, refused by the command)")
      const load = (name: string) => Blend.load(path.join(ROOT, BLEND, name))
      const cycle = yield* load("example-cycle.spec")
      expect(cycle.spec).toBeUndefined()
      expect(cycle.failures.map((failure) => [failure.rule, failure.message])).toEqual([
        ["R7", expect.stringContaining("order has a cycle")],
      ])
      const self = yield* load("example-self-after.spec")
      expect(self.spec).toBeUndefined()
      expect(self.failures.map((failure) => [failure.rule, failure.message])).toEqual([
        ["R7", expect.stringContaining("T1.1 → T1.1")],
      ])
      const unknown = yield* load("example-unknown-after.spec")
      expect(unknown.spec).toBeUndefined()
      expect(unknown.failures.map((failure) => failure.rule)).toEqual(["R6"])

      // A task after its own ancestor, and a task after its own descendant: copies of the self-after folder.
      const fs = yield* FileSystem.FileSystem
      const copy = Effect.fnUntraced(function* (edits: ReadonlyArray<readonly [string, string, string]>) {
        const target = path.join(yield* fs.makeTempDirectoryScoped(), "example-graph.spec")
        yield* fs.copy(path.join(ROOT, BLEND, "example-self-after.spec"), target)
        for (const [rel, from, to] of edits) {
          const text = yield* fs.readFileString(path.join(target, rel))
          expect(text).toContain(from)
          yield* fs.writeFileString(path.join(target, rel), text.replace(from, to))
        }
        return yield* Blend.load(target)
      })
      const leaf = "T1-words.task/T1.1-upper.task/TASK.md"
      const ancestor = yield* copy([[leaf, "after: [T1.1]\n", "after: [T1]\n"]])
      expect(ancestor.spec).toBeUndefined()
      expect(ancestor.failures).toContainEqual(
        expect.objectContaining({ rule: "R7", message: "T1.1 is after its own ancestor T1" }),
      )
      const descendant = yield* copy([
        [leaf, "after: [T1.1]\n", ""],
        ["T1-words.task/TASK.md", "---\n---\n", "---\nafter: [T1.1]\n---\n"],
      ])
      expect(descendant.spec).toBeUndefined()
      expect(descendant.failures).toContainEqual(
        expect.objectContaining({ rule: "R7", message: "T1 is after its own descendant T1.1" }),
      )
    }),
)

it.instance(
  "[DOC1] the Validation section names the six fault folders and the two live-check folders, and each row is what the real /task answers",
  () =>
    Effect.gen(function* () {
      const rows = examples.split("\n").filter((line) => line.startsWith("| `example-"))
      const named = rows.map((row) => ticked(cells(row)[0] ?? "")[0] ?? "")
      // Every example folder of the format, each once: six fault folders and two live-check folders.
      const onDisk = readdirSync(path.join(ROOT, BLEND)).filter((name) => /^example-.*\.spec$/.test(name))
      expect(named.toSorted()).toEqual(onDisk.toSorted())
      expect(named).toHaveLength(8)
      const live = rows.filter((row) => (cells(row)[1] ?? "").startsWith("A live check"))
      expect(live.map((row) => ticked(row)[0])).toEqual(["example-scenarios.spec", "example-cascade.spec"])
      const refused = rows.filter((row) => (cells(row)[1] ?? "").startsWith("Refused, "))
      expect(refused).toHaveLength(5)
      const response = (name: string) => cells(rowOf(examples, `\`${name}\``) ?? "")[1] ?? ""

      // The five refused folders: the real /task refuses each with the count, the rules and the messages of its row.
      const names = refused.map((row) => ticked(row)[0] ?? "")
      const outside = `${BLEND}/example-outside-run.spec`
      const directory = yield* seed(...names.map((name) => `${BLEND}/${name}`), outside)
      for (const name of names) {
        const row = response(name)
        const spec = `${BLEND}/${name}`
        const jobs = jobsOf()
        const [reply = ""] = yield* runTask(yield* TaskHarness.make, spec, jobs)
        const [header = "", ...lines] = reply.split("\n")
        const count = /^Refused, (\d+) failures?:/.exec(row)?.[1]
        expect({ name, header }).toEqual({
          name,
          header: `Refused ${spec}: ${count} ${count === "1" ? "failure" : "failures"}. No work started.`,
        })
        const failures = lines.filter((line) => /^R\d+ /.test(line))
        expect({ name, failures: failures.length }).toEqual({ name, failures: Number(count) })
        expect({ name, rules: failures.map((line) => line.split(" ")[0]).toSorted() }).toEqual({
          name,
          rules: [...row.matchAll(/\bR\d+\b/g)].map((match) => match[0]).toSorted(),
        })
        for (const fragment of [...quoted(row), ...ticked(row)])
          expect({ name, fragment, found: failures.some((line) => line.includes(fragment)) }).toEqual({
            name,
            fragment,
            found: true,
          })
        expect(jobs.starts).toEqual([])
      }

      // The outside-run folder: refused as the T1.2 subtree with the R12 line for T1.2 and T1.1; a whole-spec run starts.
      const row = response("example-outside-run.spec")
      expect(row).toContain("Loads with no failure and runs as a whole spec")
      expect(row).toContain("as the T1.2 subtree it is refused with the R12 line for T1.2 and T1.1")
      const parent = readdirSync(path.join(ROOT, outside)).find((name) => name.startsWith("T1-")) ?? ""
      const child = readdirSync(path.join(ROOT, outside, parent)).find((name) => name.startsWith("T1.2-")) ?? ""
      const subtree = `${outside}/${parent}/${child}`
      const subtreeJobs = jobsOf()
      const [subtreeReply = ""] = yield* runTask(yield* TaskHarness.make, subtree, subtreeJobs)
      const [subtreeHeader, r12, ...after] = subtreeReply.split("\n")
      expect(subtreeHeader).toBe(`Refused ${subtree}: 1 failure. No work started.`)
      expect(r12).toStartWith("R12 ")
      expect(r12).toContain("T1.2 is after T1.1")
      expect(after).toHaveLength(1)
      expect(subtreeJobs.starts).toEqual([])
      expect((yield* refusalOf(directory)).reason).toBe(r12)
      const wholeJobs = jobsOf()
      const [whole = ""] = yield* runTask(yield* TaskHarness.make, outside, wholeJobs)
      expect(whole).not.toStartWith("Refused")
      expect(wholeJobs.starts).toHaveLength(1)

      // The two live-check folders load with no failure, with the units their rows name.
      const scenarios = yield* Blend.load(path.join(ROOT, BLEND, "example-scenarios.spec"))
      expect(scenarios.failures).toEqual([])
      expect(scenarios.spec?.tasks.map((task) => task.id).toSorted()).toEqual(["T1", "T1.1"])
      expect(scenarios.spec?.scenarios.map((scenario) => scenario.id)).toEqual(["S1"])
      expect(response("example-scenarios.spec")).toContain("scenario S1 trusted, run `done`")
      const cascade = yield* Blend.load(path.join(ROOT, BLEND, "example-cascade.spec"))
      expect(cascade.failures).toEqual([])
      const after12 = cascade.spec?.tasks.find((task) => task.id === "T1.2")?.afterEffective ?? []
      const after13 = cascade.spec?.tasks.find((task) => task.id === "T1.3")?.afterEffective ?? []
      expect(after12).toContain("T1.1")
      expect(after13).not.toContain("T1.1")
      expect(response("example-cascade.spec")).toContain("T1.2 and T1 `blocked` by T1.1, T1.3 trusted")
    }),
  { git: true },
  120_000,
)
