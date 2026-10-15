import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import ts from "typescript"

// The D9 state audit (spine AD-17, SD-8): the harness and its UI keep lifecycle state only in xstate context and
// state. The audit parses every source file of `packages/opencode/src/task/` and `packages/tui/src/task-ui/` and
// reports each construct that holds state outside the machines, polls, or classifies units by a list of state
// names. Each finding names its file and its identifier: the nearest declaration around the construct (a variable,
// a function, a type), or the list name for `ACTIVE`, `ENDED` and `JUDGED`. A finding passes only when the
// allowlist names its file and identifier with a reason; an entry that matches no finding fails, so the list never
// keeps a stale entry. Entries marked `until` are interim: each names the task that removes it.

const ROOT = path.resolve(import.meta.dir, "../../../..")
const SCOPES = ["packages/opencode/src/task", "packages/tui/src/task-ui"]
const UI = "packages/tui/src/task-ui/"

/** Every state name of the status contract, of any unit kind (spine AD-13). */
const VOCABULARY = new Set([
  "waiting",
  "ready",
  "building",
  "proving",
  "verifying",
  "judging",
  "trusted",
  "stalled",
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

// The constructs of each rule. A call `<object>.<member>` matches when its object and member are listed.
const STATE: Record<string, ReadonlyArray<string>> = {
  Ref: ["make", "unsafeMake"],
  SynchronizedRef: ["make", "unsafeMake"],
  SubscriptionRef: ["make"],
  MutableRef: ["make"],
  MutableHashMap: ["empty", "make", "fromIterable"],
  MutableHashSet: ["empty", "make", "fromIterable"],
  MutableList: ["make", "empty"],
}
const POLL: Record<string, ReadonlyArray<string>> = {
  Effect: ["repeat", "repeatN", "repeatOrElse", "forever", "schedule", "scheduleFrom"],
  Schedule: ["spaced", "fixed"],
  Stream: ["tick"],
}
const LISTS = ["ACTIVE", "ENDED", "JUDGED"]
const TAG_ONLY = ["active", "ended", "stopped", "dead"]
const COLLECTIONS = ["Map", "Set"]
const SIGNALS = ["createSignal", "createStore"]

// Constructs that match no rule on purpose (the boundary cases, pinned by QUIET below):
// - an xstate `after` row, a `Queue`, a `Stream.scan` and a `Semaphore` hold no lifecycle state of their own;
// - a function-local `let` lives for one call;
// - a module-level `WeakMap` is an identity memo keyed by a plan object: it holds derived values, never a state;
// - a record built inside a function (a generator's transition table) is the machine's definition, not a list;
// - a list that holds a tag name that is no state name is the tag vocabulary (AD-1), not a list of states.

interface Finding {
  readonly file: string
  readonly identifier: string
  readonly rule: string
  readonly line: number
}

const callee = (node: ts.Node) => {
  if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return undefined
  return { object: node.expression.text, member: node.name.text }
}

const literalTrue = (node: ts.Expression) => node.kind === ts.SyntaxKind.TrueKeyword

const isLoop = (node: ts.Node) =>
  ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node) || ts.isForOfStatement(node)

const nameOf = (name: ts.BindingName | ts.PropertyName | undefined): string | undefined => {
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name))
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue
      const found = nameOf(element.name)
      if (found) return found
    }
  return undefined
}

/**
 * The nearest declaration around a node: a variable, a function, a method, a class or a type, and, unless
 * `properties` is false, an object property (so a `Ref` held in a record field is named by its field).
 */
const identifierOf = (node: ts.Node, properties = true): string => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return nameOf(current.name) ?? "<anonymous>"
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      (properties && (ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)))
    ) {
      const found = nameOf(current.name)
      if (found) return found
    }
  }
  return "<module>"
}

const insideFunction = (node: ts.Node) => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent)
    if (ts.isFunctionLike(current)) return true
  return false
}

const strings = (node: ts.ArrayLiteralExpression) =>
  node.elements.flatMap((element) =>
    ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element) ? [element.text] : [],
  )

// A list that holds a tag that is no state name is a list of tags (spine AD-1), not a list of states.
const tagList = (node: ts.ArrayLiteralExpression) => strings(node).some((value) => TAG_ONLY.includes(value))

/** The state names of an array literal's own string members: a list of state names when two or more. */
const listNames = (node: ts.ArrayLiteralExpression) =>
  tagList(node) ? 0 : strings(node).filter((value) => VOCABULARY.has(value)).length

/**
 * The state names a module-level literal holds, nested literals included: an array's own members, and the keys of
 * an object whose every key is a state name (a record keyed by another vocabulary, such as a tool part's
 * `pending | running | completed | error`, is not a record of states).
 */
const tableNames = (node: ts.Node): number => {
  if (ts.isArrayLiteralExpression(node))
    return listNames(node) + node.elements.reduce((sum, element) => sum + tableNames(element), 0)
  if (!ts.isObjectLiteralExpression(node)) return 0
  const keys = node.properties.map((property) => nameOf(property.name) ?? "")
  const own = keys.length > 0 && keys.every((name) => VOCABULARY.has(name)) ? keys.length : 0
  return (
    own +
    node.properties.reduce(
      (sum, property) => sum + (ts.isPropertyAssignment(property) ? tableNames(property.initializer) : 0),
      0,
    )
  )
}

const isLiteral = (node: ts.Node) => ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)

/** The findings of one source text. `file` is the path relative to the repository root. */
const scan = (file: string, text: string): ReadonlyArray<Finding> => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const ui = file.startsWith(UI)
  const found: Finding[] = []
  const add = (node: ts.Node, rule: string, identifier = identifierOf(node)) =>
    found.push({ file, identifier, rule, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 })

  const visit = (node: ts.Node) => {
    // State outside the machines.
    if (ts.isCallExpression(node)) {
      const call = callee(node.expression)
      if (call && STATE[call.object]?.includes(call.member)) add(node, `${call.object}.${call.member}`)
      if (call && POLL[call.object]?.includes(call.member)) add(node, `${call.object}.${call.member}`)
      if (call && ui && call.object === "Effect" && call.member === "sleep") add(node, "Effect.sleep")
      if (ts.isIdentifier(node.expression) && node.expression.text === "setInterval") add(node, "setInterval")
      if (ts.isIdentifier(node.expression) && ui && SIGNALS.includes(node.expression.text))
        add(node, node.expression.text)
      // The task-ui's own polling helper (`store.ts`): each call is a poll.
      if (ts.isIdentifier(node.expression) && ui && node.expression.text === "poll") add(node, "poll")
      if (ts.isIdentifier(node.expression) && node.expression.text === "setTimeout") {
        const owner = identifierOf(node)
        const callback = node.arguments[0]
        let rearms = false
        const look = (inner: ts.Node) => {
          if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression))
            if (inner.expression.text === "setTimeout" || inner.expression.text === owner) rearms = true
          ts.forEachChild(inner, look)
        }
        // `setTimeout(tick)` inside `tick`, or a callback that sets a timer again.
        if (callback && ts.isIdentifier(callback) && callback.text === owner) rearms = true
        if (callback) look(callback)
        if (rearms) add(node, "setTimeout re-arming")
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "FiberMap") add(node, "FiberMap")
      if (ui && node.expression.text === "Schedule" && !ts.isCallExpression(node.parent)) add(node, "Schedule")
      if (ui && node.expression.text === "Schedule" && ts.isCallExpression(node.parent)) {
        const call = callee(node)
        if (call && !POLL.Schedule.includes(call.member)) add(node, `Schedule.${call.member}`)
      }
    }
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && node.left.text === "FiberMap") add(node, "FiberMap")
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && COLLECTIONS.includes(node.expression.text))
      if (!insideFunction(node)) add(node, `module-level new ${node.expression.text}`)
    if (ts.isVariableStatement(node) && node.parent === source) {
      const flags = node.declarationList.flags
      const keyword = flags & ts.NodeFlags.Let ? "let" : flags & (ts.NodeFlags.Const | ts.NodeFlags.Using) ? "" : "var"
      if (keyword)
        for (const declaration of node.declarationList.declarations)
          add(declaration, `module-level ${keyword}`, nameOf(declaration.name) ?? "<anonymous>")
    }
    // Polled loops.
    if (ts.isWhileStatement(node) && literalTrue(node.expression)) add(node, "while (true)")
    if (ts.isDoStatement(node) && literalTrue(node.expression)) add(node, "do while (true)")
    if (ts.isForStatement(node) && !node.condition) add(node, "for (;;)")
    if (isLoop(node)) {
      let sleeps = false
      const look = (inner: ts.Node) => {
        const call = ts.isCallExpression(inner) ? callee(inner.expression) : undefined
        if (call?.object === "Effect" && call.member === "sleep") sleeps = true
        if (!ts.isFunctionLike(inner)) ts.forEachChild(inner, look)
      }
      ts.forEachChild(node, look)
      if (sleeps) add(node, "sleep in a loop")
    }
    // Lists of state names.
    if (ts.isIdentifier(node) && LISTS.includes(node.text) && !ts.isImportSpecifier(node.parent))
      if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression === node)
        add(node, node.text, node.text)
    // A module-level table is reported once, at its outermost literal, and not walked again for lists.
    const outermost = isLiteral(node) && !isLiteral(node.parent) && !ts.isPropertyAssignment(node.parent)
    if (outermost && !insideFunction(node) && tableNames(node) >= 2) {
      add(node, "table of state names", identifierOf(node, false))
      return
    }
    if (ts.isArrayLiteralExpression(node) && listNames(node) >= 2)
      add(node, "list of state names", identifierOf(node, false))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Every `.ts`/`.tsx` file of the audited trees, relative to the repository root. */
const files = () =>
  SCOPES.flatMap((scope) =>
    fs
      .readdirSync(path.join(ROOT, scope), { recursive: true, encoding: "utf8" })
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => path.join(scope, name)),
  ).toSorted()

interface Entry {
  readonly file: string
  readonly identifier: string
  readonly reason: string
  /** The task that removes an interim entry. */
  readonly until?: string
}

const opencode = (file: string) => `packages/opencode/src/task/${file}`
const ui = (file: string) => `${UI}${file}`

// The final entries (spine AD-17).
const SCHEMA = "The status contract's encode and decode vocabulary, not a classification (AD-13)."
const FACTS =
  "The stored-fact vocabulary of FactSchema (a verdict, a result status, a run.ended state), not a classification."
const FINAL: ReadonlyArray<Entry> = [
  { file: opencode("core/status.ts"), identifier: "RunStateSchema", reason: SCHEMA },
  { file: opencode("core/status.ts"), identifier: "TaskStateSchema", reason: SCHEMA },
  { file: opencode("core/status.ts"), identifier: "ObligationStateSchema", reason: SCHEMA },
  { file: opencode("core/status.ts"), identifier: "ScenarioStateSchema", reason: SCHEMA },
  { file: opencode("core/status.ts"), identifier: "OutsideStateSchema", reason: SCHEMA },
  {
    file: opencode("engine-xstate/machine.ts"),
    identifier: "CLASS",
    reason: "The class tags of each state: the machine's definition, read only by the generator.",
  },
  {
    file: opencode("engine-xstate/machine.ts"),
    identifier: "DEAD",
    reason: "The states that block a dependant: the machine's definition, read only by the generator.",
  },
  { file: opencode("core/events.ts"), identifier: "FactSchema", reason: FACTS },
  { file: opencode("core/events.ts"), identifier: "Verdict", reason: FACTS },
  { file: opencode("core/events.ts"), identifier: "Result_", reason: FACTS },
  {
    file: opencode("proof/process.ts"),
    identifier: "appender",
    reason: "The proof-log flush: it copies process output to the log file inside one proof process's scope.",
  },
  {
    file: ui("store.ts"),
    identifier: "DISPLAY",
    reason: "The state-to-glyph, tone and Gantt block lookup: presentation only; every classification reads the tags.",
  },
  {
    file: ui("actor.ts"),
    identifier: "fromActor",
    reason: "Solid renders only from signals: the one adapter copies the view actor's snapshot and decides nothing.",
  },
  {
    file: opencode("proof/process.ts"),
    identifier: "awaitGroupGone",
    reason: "A bounded poll for a process group to exit (Effect.timeoutOption): operating-system teardown.",
  },
]

// The interim entries: state that phase 2 and phase 4 moved into the actors, each naming the task that removed it.
// T4.8 removed the last, the store's and the Ticker's ENDED.
const INTERIM: ReadonlyArray<Entry> = []

const ALLOWLIST: ReadonlyArray<Entry> = [...FINAL, ...INTERIM]

const key = (item: { readonly file: string; readonly identifier: string }) => `${item.file} ${item.identifier}`

/** The audit's verdict over findings and an allowlist: what no entry covers, and what entry is wrong. */
const audit = (findings: ReadonlyArray<Finding>, allowlist: ReadonlyArray<Entry>) => {
  const allowed = new Set(allowlist.map(key))
  const matched = new Set(findings.map(key))
  return {
    unlisted: findings.filter((finding) => !allowed.has(key(finding))),
    unreasoned: allowlist.filter((entry) => entry.reason.trim() === ""),
    stale: allowlist.filter((entry) => !matched.has(key(entry))),
  }
}

const describeFinding = (finding: Finding) => `${finding.file}:${finding.line} ${finding.identifier} (${finding.rule})`

const PLANTED = "packages/opencode/src/task/core/planted.ts"
const PLANTED_UI = "packages/tui/src/task-ui/planted.tsx"

// Each planted construct with the identifier its finding must name.
const FLAGGED: ReadonlyArray<readonly [string, string, string]> = [
  ["Ref.make", "const run = Effect.gen(function* () { const cell = yield* Ref.make(0) })", "cell"],
  ["MutableHashMap.empty", "const table = MutableHashMap.empty<string, number>()", "table"],
  [
    "SynchronizedRef.make",
    "const run = Effect.gen(function* () { const lock = yield* SynchronizedRef.make(0) })",
    "lock",
  ],
  ["setInterval", "const timer = setInterval(() => undefined, 1000)", "timer"],
  ["while (true)", "function spin() { while (true) { step() } }", "spin"],
  ["Effect.repeat", "const again = effect.pipe(Effect.repeat({ times: 3 }))", "again"],
  ["Effect.forever", "const ever = Effect.forever(effect)", "ever"],
  ["Schedule.spaced", "const spaced = Effect.retry(effect, Schedule.spaced('1 second'))", "spaced"],
  ["Schedule.fixed", "const fixed = Schedule.fixed('1 second')", "fixed"],
  ["Stream.tick", "const ticks = Stream.tick('1 second')", "ticks"],
  ["module-level let", "let counter = 0", "counter"],
  ["list of state names", 'const run = () => { const phases = ["waiting", "building", "proving"] }', "phases"],
  ["FiberMap", "const run = Effect.gen(function* () { const fibers = yield* FiberMap.make<string>() })", "fibers"],
  ["ACTIVE", "const ACTIVE = states.filter(isActive)", "ACTIVE"],
  ["ENDED", "const ENDED = states.filter(isEnded)", "ENDED"],
  ["JUDGED", "const JUDGED = states.filter(isJudged)", "JUDGED"],
  ["for (;;)", "function spin() { for (;;) { step() } }", "spin"],
  ["do while (true)", "function spin() { do { step() } while (true) }", "spin"],
  ["module-level var", "var shared = 1", "shared"],
  ["module-level new Map", "const cache = new Map<string, number>()", "cache"],
  ["setTimeout re-arming", "function tick() { setTimeout(tick, 100) }", "tick"],
  ["Effect.repeatN", "const thrice = Effect.repeatN(effect, 3)", "thrice"],
  ["Effect.schedule", "const later = Effect.schedule(effect, policy)", "later"],
  ["sleep in a loop", "const wait = Effect.gen(function* () { while (yield* busy) yield* Effect.sleep(10) })", "wait"],
  ["table of state names", 'const TONE = { waiting: "idle", building: "active" }', "TONE"],
  ["list of state names", 'const run = () => new Set(["waiting", "blocked"])', "run"],
  ["list of state names", 'const run = () => Object.fromEntries(["trusted", "failed"].map((s) => [s, 1]))', "run"],
]

const FLAGGED_UI: ReadonlyArray<readonly [string, string, string]> = [
  ["Effect.sleep", "const pause = Effect.sleep('1 second')", "pause"],
  ["Schedule.recurs", "const every = Schedule.recurs(3)", "every"],
  ["createSignal", "const [shown, setShown] = createSignal(false)", "shown"],
  ["poll", "const sample = poll([], '1 second', read)", "sample"],
]

// Constructs that hold no lifecycle state of their own.
const QUIET: ReadonlyArray<readonly [string, string]> = [
  ["a function-local let", "function count() { let total = 0; total += 1; return total }"],
  ["an xstate after row", "const config = { states: { idle: { after: { 1000: { target: 'busy' } } } } }"],
  ["a Queue", "const run = Effect.gen(function* () { const queue = yield* Queue.sliding<number>(1) })"],
  ["a Stream.scan", "const last = changes.pipe(Stream.scan(none, (_, next) => next))"],
  ["a Semaphore", "const run = Effect.gen(function* () { const lock = yield* Semaphore.make(1) })"],
  ["a module-level WeakMap", "const memo = new WeakMap<object, number>()"],
  ["a single state name", 'const run = () => ["waiting"]'],
  ["a list of tags", 'const TAGS = ["waiting", "active", "ended", "stopped", "blocked", "dead"]'],
  ["a record of another vocabulary", 'const TOOL = { pending: "·", running: "◐", completed: "›", error: "✗" }'],
  ["a record built in a function", "const build = () => ({ waiting: rows(), ready: rows() })"],
  ["an Effect.sleep outside the task-ui and outside a loop", "const pause = Effect.sleep('1 second')"],
]

describe("the state audit", () => {
  test("flags each planted construct with its file and identifier", () => {
    for (const [rule, text, identifier] of FLAGGED)
      expect({ rule, found: scan(PLANTED, text).map((item) => [item.file, item.identifier, item.rule]) }).toEqual({
        rule,
        found: expect.arrayContaining([[PLANTED, identifier, rule]]),
      })
    for (const [rule, text, identifier] of FLAGGED_UI)
      expect({ rule, found: scan(PLANTED_UI, text).map((item) => [item.file, item.identifier, item.rule]) }).toEqual({
        rule,
        found: expect.arrayContaining([[PLANTED_UI, identifier, rule]]),
      })
  })

  test("leaves the constructs that hold no lifecycle state alone", () => {
    for (const [name, text] of QUIET) expect({ name, found: scan(PLANTED, text) }).toEqual({ name, found: [] })
  })

  test("fails a finding outside the allowlist, an entry with no reason, and an entry that matches nothing", () => {
    const findings = scan(PLANTED, "const table = MutableHashMap.empty<string, number>()")
    expect(audit(findings, []).unlisted.map((item) => item.identifier)).toEqual(["table"])
    const unreasoned: Entry = { file: PLANTED, identifier: "table", reason: " " }
    expect(audit(findings, [unreasoned]).unreasoned).toEqual([unreasoned])
    const stale: Entry = { file: PLANTED, identifier: "gone", reason: "It was removed." }
    expect(audit(findings, [{ ...unreasoned, reason: "A reason." }, stale]).stale).toEqual([stale])
  })

  test("names the task that removes each interim entry", () => {
    for (const entry of INTERIM)
      expect({ entry: key(entry), until: entry.until }).toEqual({
        entry: key(entry),
        until: expect.stringMatching(/^T[24]\.\d+$/),
      })
  })

  test("SV19 holds exactly the AD-17 entries for the harness tree, none of them interim", () => {
    // The AD-17 table, for packages/opencode/src/task: the status schemas, the machine's DEAD and CLASS, the
    // FactSchema vocabulary (with its verdict and result-status members), and the two proof-process loops.
    const expected = [
      "core/events.ts FactSchema",
      "core/events.ts Result_",
      "core/events.ts Verdict",
      "core/status.ts ObligationStateSchema",
      "core/status.ts OutsideStateSchema",
      "core/status.ts RunStateSchema",
      "core/status.ts ScenarioStateSchema",
      "core/status.ts TaskStateSchema",
      "engine-xstate/machine.ts CLASS",
      "engine-xstate/machine.ts DEAD",
      "proof/process.ts appender",
      "proof/process.ts awaitGroupGone",
    ]
    const harness = ALLOWLIST.filter((entry) => entry.file.startsWith(opencode("")))
    expect(harness.map((entry) => `${entry.file.slice(opencode("").length)} ${entry.identifier}`).toSorted()).toEqual(
      expected,
    )
    expect(harness.filter((entry) => entry.until !== undefined).map(key)).toEqual([])
  })

  test("keeps no interim entry for the polled runner, its builder watch or its hook maps; each left names a T4 task", () => {
    expect(INTERIM.filter((entry) => !entry.file.startsWith(UI)).map(key)).toEqual([])
    for (const file of ["core/runner.ts", "core/sessions.ts", "core/hooks.ts"])
      expect(ALLOWLIST.filter((entry) => entry.file === opencode(file)).map(key)).toEqual([])
    for (const entry of INTERIM)
      expect({ entry: key(entry), until: entry.until }).toEqual({
        entry: key(entry),
        until: expect.stringMatching(/^T4\.\d+$/),
      })
  })

  test("passes on the current tree with the allowlist", () => {
    const findings = files().flatMap((file) => scan(file, fs.readFileSync(path.join(ROOT, file), "utf8")))
    const result = audit(findings, ALLOWLIST)
    expect(result.unlisted.map(describeFinding)).toEqual([])
    expect(result.unreasoned.map(key)).toEqual([])
    expect(result.stale.map(key)).toEqual([])
  })
})
