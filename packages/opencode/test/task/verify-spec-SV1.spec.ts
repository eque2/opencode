import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Duration, Effect, Layer, Option, Predicate } from "effect"
import fs from "fs"
import path from "path"
import ts from "typescript"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { TaskOps } from "@/task/core/ops"
import { RunSupervisor } from "@/task/core/supervise/run"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { SESSION, seed, SPEC } from "./lib/command"
import { boundary, eventually } from "./lib/supervise"

// Scenario SV1 (spec task-harness-feedback, D6, D9, AD-8, AD-17; task T2.12): the runner holds no hand-written
// lifecycle state.
//
//   Given the harness source after phase 2
//   When it is inspected
//   Then it holds no polled loop, tick counter, stale cadence counter, failure map, failure limit, stopping flag,
//     children list, worker FiberMap, judged-state list or process-wide run registry
//   And a live run is found through the actor system by its run id
//
// The inspection parses every source file under `packages/opencode/src/task/` with the TypeScript compiler and looks
// for each construct by its kind, not only by its old name in the deleted polled runner (T2.12 names `loop`, `tick`,
// `TICK`, `STALE_EVERY`, `checkDone`, `failures`, `MAX_FAILURES`, `stopping`, `children`, `active`, `trustActive` and
// the worker `FiberMap`). Where the spine keeps a construct on purpose, the test names it from the spec (AD-17: the
// proof-log `appender` and the OS teardown poll `awaitGroupGone` in `proof/process.ts`; `CLASS`, `DEAD`, the five
// `*StateSchema` and the `FactSchema` members; the AD-1 tag vocabulary), never from what the scan found. A negative
// control runs the same scan over a planted source that holds each construct, so a scan that sees nothing fails. The
// live part runs the real `/task` command with the real background job registry and finds the run in the harness
// actor system as `run:<runID>`.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SOURCE = path.resolve(import.meta.dir, "../../src/task")

// --- the scan -------------------------------------------------------------------------------------------------------

interface Parsed {
  readonly file: string
  readonly source: ts.SourceFile
}

const parse = (file: string, text: string): Parsed => ({
  file,
  source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
})

const filesUnder = (directory: string): ReadonlyArray<string> =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesUnder(path.join(directory, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [path.join(directory, entry.name)]
          : [],
    )

const nameText = (name: ts.Node | undefined): string | undefined =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined

// The module-level statement around a node, by its declared name: the owner a finding is reported under.
const topOf = (node: ts.Node): string => {
  let current: ts.Node = node
  while (current.parent !== undefined && !ts.isSourceFile(current.parent)) current = current.parent
  if (ts.isVariableStatement(current)) return nameText(current.declarationList.declarations[0]?.name) ?? "<anonymous>"
  if (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current))
    return nameText(current.name) ?? "<anonymous>"
  return "<module>"
}

// The nearest variable or function declaration around a node.
const ownerOf = (node: ts.Node): string => {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current)) {
      const name = nameText(current.name)
      if (name !== undefined) return name
    }
  }
  return "<module>"
}

const insideFunction = (node: ts.Node) => {
  for (let current = node.parent; current !== undefined; current = current.parent)
    if (ts.isFunctionLike(current)) return true
  return false
}

const contains = (outer: ts.Node, inner: ts.Node) => inner.pos >= outer.pos && inner.end <= outer.end && inner !== outer

// The block or function a local declaration is visible in.
const scopeOf = (declaration: ts.Node): ts.Node => {
  for (let current = declaration.parent; current !== undefined; current = current.parent)
    if (ts.isBlock(current) || ts.isFunctionLike(current) || ts.isSourceFile(current)) return current
  return declaration
}

// `<object>.<member>` with both names, or undefined.
const member = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
    ? { object: node.expression.text, name: node.name.text }
    : undefined

const isTrue = (node: ts.Node | undefined) => node !== undefined && node.kind === ts.SyntaxKind.TrueKeyword

const containsCall = (node: ts.Node, object: string, name: string): boolean => {
  const found = member(node)
  if (found !== undefined && found.object === object && found.name === name) return true
  return node.forEachChild((child) => (containsCall(child, object, name) ? true : undefined)) ?? false
}

const unique = (items: ReadonlyArray<string>) => [...new Set(items)].toSorted()

const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])
const MUTATORS = ["set", "push", "add", "delete", "splice", "unshift", "pop", "shift", "clear"]

/** Every state name of the status contract, of any unit kind (spine AD-13). */
const STATES = new Set([
  "waiting",
  "ready",
  "building",
  "proving",
  "verifying",
  "judging",
  "trusted",
  "needs_human",
  "budget_exhausted",
  "failed",
  "cancelled",
  "blocked",
  "pending",
  "stale",
  "passed",
  "rejected",
  "parked",
  "running",
  "done",
  "refused",
  "untrusted",
])
/** The class tags that name no state: a list that holds one is the AD-1 tag vocabulary, not a list of states. */
const TAG_ONLY = ["active", "ended", "stopped", "dead"]

interface Declaration {
  readonly at: string
  readonly name: string
  readonly kind: "let" | "var" | "const" | "function" | "class" | "property"
  readonly moduleLevel: boolean
  readonly node: ts.Node
}

/** What the inspection finds in a set of source files. Each finding is `<file>#<identifier>`. */
const scan = (files: ReadonlyArray<Parsed>) => {
  const everyNode = files.flatMap((item) => {
    const all: Array<{ file: string; node: ts.Node }> = []
    const visit = (node: ts.Node) => {
      all.push({ file: item.file, node })
      node.forEachChild(visit)
    }
    visit(item.source)
    return all
  })
  const declarations = everyNode.flatMap(({ file, node }): ReadonlyArray<Declaration> => {
    if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isIdentifier(node.name)) {
      const flags = node.parent.flags
      const kind = flags & ts.NodeFlags.Let ? "let" : flags & ts.NodeFlags.Const ? "const" : "var"
      const statement = node.parent.parent
      const moduleLevel = ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent)
      return [{ at: `${file}#${node.name.text}`, name: node.name.text, kind, moduleLevel, node }]
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
      return [
        {
          at: `${file}#${node.name.text}`,
          name: node.name.text,
          kind: ts.isFunctionDeclaration(node) ? "function" : "class",
          moduleLevel: ts.isSourceFile(node.parent),
          node,
        },
      ]
    if (ts.isPropertyDeclaration(node)) {
      const name = nameText(node.name)
      return name === undefined ? [] : [{ at: `${file}#${name}`, name, kind: "property", moduleLevel: false, node }]
    }
    return []
  })
  const named = (pattern: RegExp, keep: (item: Declaration) => boolean = () => true) =>
    unique(declarations.filter((item) => pattern.test(item.name) && keep(item)).map((item) => item.at))
  const accesses = (object: string, names: (name: string) => boolean) =>
    everyNode.filter(({ node }) => {
      const found = member(node)
      return found !== undefined && found.object === object && names(found.name)
    })
  const identifiers = (names: ReadonlyArray<string>) =>
    everyNode.filter(
      ({ node }) =>
        ts.isIdentifier(node) &&
        names.includes(node.text) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node),
    )

  // A polled loop: an endless loop, a loop that sleeps, a repeat or schedule, a tick stream, a timer.
  const polls = unique(
    everyNode.flatMap(({ file, node }) => {
      const endless =
        (ts.isWhileStatement(node) && isTrue(node.expression)) ||
        (ts.isDoStatement(node) && isTrue(node.expression)) ||
        (ts.isForStatement(node) && node.condition === undefined)
      const sleeping =
        (ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node) || ts.isForOfStatement(node)) &&
        containsCall(node.statement, "Effect", "sleep")
      const found = member(node)
      const scheduled =
        found !== undefined &&
        ((found.object === "Effect" &&
          ["repeat", "repeatN", "repeatOrElse", "forever", "schedule", "scheduleFrom"].includes(found.name)) ||
          (found.object === "Schedule" && ["spaced", "fixed"].includes(found.name)) ||
          (found.object === "Stream" && found.name === "tick"))
      const timer =
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["setInterval", "setTimeout"].includes(node.expression.text)
      return endless || sleeping || scheduled || timer ? [`${file}#${ownerOf(node)}`] : []
    }),
  )

  // Mutable cells and keyed collections: what a failure map, a stopping flag or a children list would be held in.
  const cells = unique(
    [
      ...accesses("MutableHashMap", () => true),
      ...accesses("HashMap", () => true),
      ...accesses("MutableHashSet", () => true),
      ...accesses("Ref", () => true),
      ...accesses("SynchronizedRef", () => true),
      ...accesses("SubscriptionRef", () => true),
      ...accesses("MutableRef", () => true),
      ...accesses("MutableList", () => true),
      ...everyNode.filter(
        ({ node }) =>
          ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["Map", "Set"].includes(node.expression.text),
      ),
    ].map(({ file, node }) => `${file}#${ownerOf(node)}`),
  )

  // Each `FAILURE_LIMIT` use: whether it sits in a `guards` block and compares a count read from the context.
  const limitUses = identifiers(["FAILURE_LIMIT"])
    .filter(({ node }) => !ts.isVariableDeclaration(node.parent))
    .map(({ file, node }) => {
      let inGuards = false
      for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent)
        if (ts.isPropertyAssignment(current) && nameText(current.name) === "guards") inGuards = true
      const comparison = node.parent
      const readsContext =
        ts.isBinaryExpression(comparison) &&
        comparison.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
        /^context\.[a-zA-Z]*[fF]ailures \+ 1$/.test(comparison.left.getText())
      return { file, inGuards, readsContext }
    })
    .toSorted((a, b) => a.file.localeCompare(b.file))

  // The fork sites, by their module-level owner, and any fork whose fiber goes into a collection.
  const forks = unique(
    accesses("Effect", (name) => name.startsWith("fork") || name === "runFork").map(
      ({ file, node }) => `${file}#${topOf(node)}`,
    ),
  )
  const forksKept = unique(
    everyNode.flatMap(({ file, node }) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return []
      if (!["push", "set", "add", "unshift"].includes(node.expression.name.text)) return []
      return node.arguments.some((argument) => /\b(fork[A-Za-z]*|runFork)\b/.test(argument.getText()))
        ? [`${file}#${ownerOf(node)}`]
        : []
    }),
  )
  const fiberCollections = unique(
    identifiers(["FiberMap", "FiberSet", "FiberHandle"]).map(({ file, node }) => `${file}#${ownerOf(node)}`),
  )

  // A list of two or more lifecycle state names, by its module-level owner.
  const stateLists = unique(
    everyNode.flatMap(({ file, node }) => {
      if (!ts.isArrayLiteralExpression(node)) return []
      const names = node.elements.flatMap((element) =>
        ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element) ? [element.text] : [],
      )
      if (names.some((name) => TAG_ONLY.includes(name))) return []
      return names.filter((name) => STATES.has(name)).length >= 2 ? [`${file}#${topOf(node)}`] : []
    }),
  )

  // Module-level collections, with their key type, and every write to a module-level binding.
  const moduleNames = new Map<string, Set<string>>()
  for (const item of declarations.filter((each) => each.moduleLevel)) {
    const file = item.at.slice(0, item.at.indexOf("#"))
    moduleNames.set(file, (moduleNames.get(file) ?? new Set<string>()).add(item.name))
  }
  const moduleCollections = unique(
    everyNode.flatMap(({ file, node }) => {
      if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression)) return []
      if (!["Map", "Set", "WeakMap", "WeakSet", "Array"].includes(node.expression.text)) return []
      if (insideFunction(node)) return []
      return [`${file}#${topOf(node)}:${node.expression.text}<${node.typeArguments?.[0]?.getText() ?? "?"}>`]
    }),
  )
  const root = (expression: ts.Expression): ts.Expression =>
    ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
      ? root(expression.expression)
      : expression
  const moduleWrites = unique(
    everyNode.flatMap(({ file, node }) => {
      const names = moduleNames.get(file) ?? new Set<string>()
      const write = (() => {
        if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind))
          return { target: root(node.left), how: " =" }
        if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        )
          return { target: root(node.operand), how: " ++" }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          MUTATORS.includes(node.expression.name.text)
        )
          return { target: root(node.expression.expression), how: `.${node.expression.name.text}` }
        return undefined
      })()
      if (write === undefined || !ts.isIdentifier(write.target) || !names.has(write.target.text)) return []
      const name = write.target.text
      // A local binding of the same name shadows the module's.
      const shadowed = declarations.some(
        (item) =>
          item.name === name &&
          item.at === `${file}#${name}` &&
          !item.moduleLevel &&
          contains(scopeOf(item.node), node),
      )
      return shadowed ? [] : [`${file}#${name}${write.how}`]
    }),
  )

  return {
    files: files.map((item) => item.file),
    polls,
    /** Module-level `let` and `var`: a counter or a flag that outlives a call. */
    moduleMutables: named(/.*/, (item) => item.moduleLevel && (item.kind === "let" || item.kind === "var")),
    /** Every `let` that is not inside a function. */
    letsOutsideFunctions: named(/.*/, (item) => item.kind === "let" && !insideFunction(item.node)),
    runnerNames: named(
      /^(loop|checkDone|tick|ticks|TICK|STALE_EVERY|staleEvery|MAX_FAILURES|maxFailures|stopping|isStopping|trustActive|JUDGED|ACTIVE|ENDED)$/,
    ),
    /** A stop flag or a children list or a registry: by name, when mutable, module-level or a field. */
    heldNames: named(
      /^(stopped|stop|halted|children|failures|active|registry|runs)$/,
      (item) => item.moduleLevel || item.kind === "let" || item.kind === "var" || item.kind === "property",
    ),
    cells,
    limitUses,
    forks,
    forksKept,
    fiberCollections,
    stateLists,
    moduleCollections,
    moduleWrites,
  }
}

const real = scan(filesUnder(SOURCE).map((file) => parse(path.relative(SOURCE, file), fs.readFileSync(file, "utf8"))))

// --- the live part: `/task` on the real command, the real background job registry and the real harness root --------

// What the command's session side saw: replies in the root session and prompts of the run's child sessions.
interface Seen {
  readonly replies: Array<string>
  readonly prompts: Array<string>
}

// The ops `SessionPrompt` hands the command: a reply in the root session ends at once; a turn of a child session (a
// builder or a judge) runs until the run stops it, so the run stays live while the test looks at it.
const opsOf = (seen: Seen): TaskOps.Ops => ({
  prompt: (input) =>
    input.sessionID === SESSION
      ? Effect.sync(() => {
          seen.replies.push(input.parts.map((part) => part.text).join("\n"))
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command never reads the reply message
          return {} as SessionV1.WithParts
        })
      : Effect.sync(() => seen.prompts.push(input.sessionID)).pipe(Effect.andThen(Effect.never)),
  cancel: () => Effect.void,
  currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
  say: () => Effect.void,
})

// The services `/task` resolves for a run: the scripted session boundary and the real job registry.
const servicesOf = (registry: BackgroundJob.Interface) => {
  const { env } = boundary([])
  return Layer.mergeAll(
    Layer.succeed(Session.Service, env.sessions),
    Layer.succeed(SessionStatus.Service, env.status),
    Layer.succeed(InstanceStore.Service, env.instances),
    Layer.succeed(BackgroundJob.Service, registry),
  )
}

// The scripted bounds for the run that `/task` starts (`TaskLimits.load` reads the variable), restored afterwards.
const scriptedLimits = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[TaskLimits.variable]
      process.env[TaskLimits.variable] = "scripted"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[TaskLimits.variable]
        else process.env[TaskLimits.variable] = previous
      }),
  )

const pathOf = (value: unknown, keys: ReadonlyArray<string>): unknown => {
  let current = value
  for (const key of keys) {
    if (!Predicate.hasProperty(current, key)) return undefined
    current = current[key]
  }
  return current
}

// --- the tests --------------------------------------------------------------------------------------------------------

it.live("[SV1] the inspection finds each named construct in a planted source (negative control)", () =>
  Effect.gen(function* () {
    const planted = scan([
      parse(
        "planted/runner.ts",
        [
          'import { Effect, FiberMap, MutableHashMap, Ref } from "effect"',
          "let tick = 0",
          "const STALE_EVERY = 10",
          "const MAX_FAILURES = 3",
          "let stopping = false",
          "const failures = MutableHashMap.empty<string, number>()",
          "const children: Array<unknown> = []",
          'const JUDGED = ["trusted", "rejected", "failed"]',
          "const ACTIVE = new Map<string, unknown>()",
          "export const register = (id: string, run: unknown) => ACTIVE.set(id, run)",
          "export const keep = (work: Effect.Effect<void>) => children.push(Effect.runFork(work))",
          "export const workers = FiberMap.make<string>()",
          "export const flag = Ref.make(false)",
          "export const loop = Effect.gen(function* () {",
          "  while (true) {",
          "    tick++",
          "    yield* Effect.sleep(250)",
          "  }",
          "})",
          "export const cadence = Effect.repeat(Effect.void, { times: 1 })",
          "setInterval(() => undefined, 1000)",
        ].join("\n"),
      ),
    ])
    expect(planted.polls).toEqual(["planted/runner.ts#<module>", "planted/runner.ts#cadence", "planted/runner.ts#loop"])
    expect(planted.moduleMutables).toEqual(["planted/runner.ts#stopping", "planted/runner.ts#tick"])
    expect(planted.runnerNames).toEqual([
      "planted/runner.ts#ACTIVE",
      "planted/runner.ts#JUDGED",
      "planted/runner.ts#MAX_FAILURES",
      "planted/runner.ts#STALE_EVERY",
      "planted/runner.ts#loop",
      "planted/runner.ts#stopping",
      "planted/runner.ts#tick",
    ])
    expect(planted.heldNames).toEqual(["planted/runner.ts#children", "planted/runner.ts#failures"])
    expect(planted.cells).toEqual(["planted/runner.ts#ACTIVE", "planted/runner.ts#failures", "planted/runner.ts#flag"])
    expect(planted.fiberCollections).toEqual(["planted/runner.ts#<module>", "planted/runner.ts#workers"])
    expect(planted.forksKept).toEqual(["planted/runner.ts#keep"])
    expect(planted.stateLists).toEqual(["planted/runner.ts#JUDGED"])
    expect(planted.moduleCollections).toEqual(["planted/runner.ts#ACTIVE:Map<string>"])
    expect(planted.moduleWrites).toEqual([
      "planted/runner.ts#ACTIVE.set",
      "planted/runner.ts#children.push",
      "planted/runner.ts#tick ++",
    ])
  }),
)

it.live("[SV1] the harness source is the phase-2 tree: no polled runner module, and the scan covers every file", () =>
  Effect.gen(function* () {
    expect(fs.existsSync(path.join(SOURCE, "core", "runner.ts"))).toBe(false)
    expect(real.files).toEqual(
      expect.arrayContaining([
        "core/command.ts",
        "core/harness.ts",
        "core/recorder.ts",
        "core/workers.ts",
        "core/hooks.ts",
        "core/sessions.ts",
        "core/supervise/run.ts",
        "core/supervise/task.ts",
        "core/supervise/scenario.ts",
        "engine-xstate/machine.ts",
      ]),
    )
    // No module imports a runner, and no module declares the runner's names.
    const imports = filesUnder(SOURCE).filter((file) => /from "[^"]*\/runner"/.test(fs.readFileSync(file, "utf8")))
    expect(imports).toEqual([])
    expect(real.runnerNames).toEqual([])
  }),
)

it.live("[SV1] holds no polled loop and no tick counter: the only polls are the two AD-17 process entries", () =>
  Effect.gen(function* () {
    // AD-17 keeps exactly these: the proof-log flush of one proof process, and the bounded wait for a killed process
    // group to exit. Neither reads or moves a unit, a run or a lifecycle state.
    expect(real.polls).toEqual(["proof/process.ts#appender", "proof/process.ts#awaitGroupGone"])
    // A tick counter is a mutable binding that outlives a call: no module-level let or var, and every let is local
    // to one function call.
    expect(real.moduleMutables).toEqual([])
    expect(real.letsOutsideFunctions).toEqual([])
  }),
)

it.live("[SV1] holds no stale cadence counter: the cadence is a delayed transition of the run supervisor", () =>
  Effect.gen(function* () {
    expect(Duration.toMillis(RunSupervisor.STALE_CADENCE)).toBe(1_000)
    // The staleCadence region waits on its `stale` delay, then checks: an xstate `after` row, not a counter.
    const config: unknown = RunSupervisor.machine.config
    expect(pathOf(config, ["states", "running", "states", "staleCadence", "states", "waiting", "after"])).toEqual({
      stale: "checking",
    })
    expect(pathOf(RunSupervisor.machine.implementations, ["delays", "stale"])).toBe(1_000)
  }),
)

it.live(
  "[SV1] holds no failure map and no runner failure limit: each FAILURE_LIMIT is a guard over a context count",
  () =>
    Effect.gen(function* () {
      // A failure map needs a mutable keyed collection or a reference cell: none is built anywhere in the harness.
      expect(real.cells).toEqual([])
      expect(real.heldNames.filter((item) => item.endsWith("#failures"))).toEqual([])
      // The supervisors' FAILURE_LIMIT is a guard parameter: each use compares a count held in the machine's context.
      expect(real.limitUses).toEqual([
        { file: "core/supervise/run.ts", inGuards: true, readsContext: true },
        { file: "core/supervise/scenario.ts", inGuards: true, readsContext: true },
        { file: "core/supervise/task.ts", inGuards: true, readsContext: true },
      ])
    }),
)

it.live("[SV1] holds no stopping flag, children list, worker FiberMap or judged-state list", () =>
  Effect.gen(function* () {
    // No stop flag, children list or registry held in a mutable binding, a module binding or a field.
    expect(real.heldNames).toEqual([])
    expect(real.fiberCollections).toEqual([])
    // The only places that fork a fiber: one proof process's log appender, the Recorder's status writer, and the two
    // relays that live inside an xstate callback actor (the session events and the run actor's snapshots). No fork's
    // fiber goes into a collection; workers run as invoked xstate actors.
    expect(real.forks).toEqual([
      "core/recorder.ts#make",
      "core/supervise/run.ts#watch",
      "core/workers.ts#sessionEvents",
      "proof/process.ts#acquire",
    ])
    expect(real.forksKept).toEqual([])
    // A list of two or more lifecycle state names exists only in the AD-17 entries: the five status schemas, the
    // machine's CLASS and DEAD, and the fact schema's members.
    const allowed = [
      "core/status.ts#RunStateSchema",
      "core/status.ts#TaskStateSchema",
      "core/status.ts#ObligationStateSchema",
      "core/status.ts#ScenarioStateSchema",
      "core/status.ts#OutsideStateSchema",
      "engine-xstate/machine.ts#CLASS",
      "engine-xstate/machine.ts#DEAD",
      "core/events.ts#FactSchema",
      "core/events.ts#Verdict",
      "core/events.ts#Result_",
    ]
    expect(real.stateLists.filter((item) => !allowed.includes(item))).toEqual([])
    expect(real.stateLists).toEqual(expect.arrayContaining(["core/status.ts#TaskStateSchema"]))
  }),
)

it.live("[SV1] holds no process-wide run registry: no module-level mutable binding or collection keyed by a run", () =>
  Effect.gen(function* () {
    // The module-level collections are the two identity memos keyed by a Plan object (the generated machine and its
    // initial snapshot of each plan); a run id keys nothing at module level.
    expect(real.moduleCollections).toEqual([
      "engine-xstate/index.ts#initials:WeakMap<Plan>",
      "engine-xstate/machine.ts#machines:WeakMap<Plan>",
    ])
    // No code writes a module-level binding or mutates one, except each memo's own `set`.
    expect(real.moduleWrites).toEqual(["engine-xstate/index.ts#initials.set", "engine-xstate/machine.ts#machines.set"])
  }),
)

it.instance(
  "[SV1] a live run that /task started is found through the harness actor system by its run id, and only there",
  () =>
    scriptedLimits(
      Effect.gen(function* () {
        const directory = yield* seed(SPEC)
        const harness = yield* TaskHarness.make
        const registry = yield* CoreBackgroundJob.make
        const id = TaskEvents.runID(directory, SPEC)
        const runRef = TaskHarness.systemId.run(id)
        expect(runRef).toBe(`run:${id}`)
        expect(yield* harness.running(id)).toBe(false)
        expect(Option.isNone(yield* harness.system.get(runRef))).toBe(true)

        const seen: Seen = { replies: [], prompts: [] }
        yield* TaskCommand.run({ sessionID: SESSION, arguments: SPEC }, opsOf(seen), harness).pipe(
          Effect.provide(servicesOf(registry)),
        )
        expect(seen.replies[0]).toStartWith("Implementing spec **Release notes from conventional commits**")

        // The run is live: its supervisor is registered in the harness system under run:<runID>.
        yield* eventually(harness.running(id), "the run supervisor in the actor system")
        const ref = yield* harness.system.get(runRef)
        if (Option.isNone(ref)) throw new Error("no run supervisor in the system")
        expect(pathOf(yield* ref.value.getSnapshot, ["context", "run", "id"])).toBe(id)
        expect((yield* registry.get(id))?.status).toBe("running")
        // Its unit supervisors are found the same way, by run id and unit id.
        yield* eventually(
          Effect.map(harness.system.get(TaskHarness.systemId.task(id, "T1.1")), Option.isSome),
          "the T1.1 supervisor in the actor system",
        )

        // No process-wide registry: another harness root, with its own actor system, does not know the run.
        const other = yield* TaskHarness.make
        expect(yield* other.running(id)).toBe(false)
        expect(Option.isNone(yield* other.system.get(runRef))).toBe(true)
        // A lease without a spawned supervisor is not a live run.
        yield* other.claim({ directory, runID: id, spec: SPEC, path: SPEC })
        expect(yield* other.running(id)).toBe(false)

        // Once the job is cancelled and its scope closed, the system no longer holds the run or its supervisors.
        yield* registry.cancel(id)
        expect(yield* harness.running(id)).toBe(false)
        expect(Option.isNone(yield* harness.system.get(runRef))).toBe(true)
        expect(Option.isNone(yield* harness.system.get(TaskHarness.systemId.task(id, "T1.1")))).toBe(true)
      }),
    ),
  { git: true },
  60_000,
)
