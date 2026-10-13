// The completion check for the release-notes task tree: a fresh repository seeded from
// release-notes-repo/, each leaf's files from release-notes-solution/ written and committed in tree order, then the
// four gates of SPEC.md run offline. It proves that the tree can be completed as written.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import z from "zod"
import { tmpdir } from "../fixture/fixture"

const HERE = import.meta.dir
const SEED = path.join(HERE, "release-notes-repo")
const SOLUTION = path.join(HERE, "release-notes-solution")
const TREE = path.join(HERE, "..", "..", "..", "..", "task-formats", "blend", "release-notes.spec")
const PARENT = path.join(TREE, "T1-release-notes.task")
const ORDER = ["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"]
const TIMEOUT = 300_000

const Leaf = z.object({
  files: z.record(z.string(), z.string()),
  tags: z.array(z.string()),
  skipped: z.array(z.string()).optional(),
})
type Leaf = z.infer<typeof Leaf>

const Proved = z.record(z.string(), z.object({ proof: z.unknown().optional() }))
const TaskMatter = z.object({
  after: z.array(z.string()).optional(),
  touches: z.array(z.object({ path: z.string() })),
})
const VerifyMatter = z.object({
  hint: z.string(),
  ensures: Proved.optional(),
  preserves: Proved.optional(),
  forbids: Proved.optional(),
})
const ScenarioMatter = z.object({
  needs: z.array(z.string()),
  environment: z.object({ kind: z.string() }).optional(),
})

type Run = { code: number; stdout: string; stderr: string }
type Status = "passed" | "failed" | "skipped"

async function frontmatter(file: string): Promise<unknown> {
  const text = await fs.readFile(file, "utf8")
  const match = /^---\n([\s\S]*?)^---$/m.exec(text)
  if (!match) throw new Error(`${file} has no frontmatter`)
  return Bun.YAML.parse(match[1] ?? "")
}

async function loadTasks(): Promise<Map<string, Leaf>> {
  const raw = z.record(z.string(), Leaf).parse(JSON.parse(await fs.readFile(path.join(SOLUTION, "tasks.json"), "utf8")))
  return new Map(Object.entries(raw))
}

/** What the tree itself requires of each leaf: the files it may write and the tags its test file must prove. */
async function requirements() {
  const folders = (await fs.readdir(PARENT)).filter((name) => name.endsWith(".task")).sort()
  const leaves = new Map<
    string,
    { after: string[]; touches: string[]; hint: string; tags: string[]; skipped: string[] }
  >()
  for (const folder of folders) {
    const id = folder.split("-")[0] ?? folder
    const task = TaskMatter.parse(await frontmatter(path.join(PARENT, folder, "TASK.md")))
    const verify = VerifyMatter.parse(await frontmatter(path.join(PARENT, folder, "VERIFY.md")))
    // An obligation with no proof, or proof `test`, needs its own tagged test; `{test: cN}` reuses cN's test.
    const tags = [verify.ensures, verify.preserves, verify.forbids].flatMap((group) =>
      Object.entries(group ?? {})
        .filter(([, item]) => item.proof === undefined || item.proof === "test")
        .map(([key]) => `${id}.${key}`),
    )
    leaves.set(id, {
      after: task.after ?? [],
      touches: task.touches.map((touch) => touch.path),
      hint: verify.hint,
      tags,
      skipped: [],
    })
  }
  // A scenario's test sits in the test file of the leaf among its needs that the tree builds last.
  const scenarios = (await fs.readdir(path.join(TREE, "acceptance"))).filter((name) => /^S\d+\.md$/.test(name))
  for (const file of scenarios) {
    const id = file.replace(/\.md$/, "")
    const scenario = ScenarioMatter.parse(await frontmatter(path.join(TREE, "acceptance", file)))
    const owner = scenario.needs
      .filter((need) => ORDER.includes(need))
      .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
      .at(-1)
    const leaf = owner === undefined ? undefined : leaves.get(owner)
    if (!leaf) throw new Error(`${id} needs no leaf of the tree`)
    if (scenario.environment?.kind === "deployed") leaf.skipped.push(id)
    else leaf.tags.push(id)
  }
  return leaves
}

function isolatedGitEnv(root: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: root,
    GIT_AUTHOR_NAME: "Release Notes Check",
    GIT_AUTHOR_EMAIL: "release-notes-check@eque2.test",
    GIT_COMMITTER_NAME: "Release Notes Check",
    GIT_COMMITTER_EMAIL: "release-notes-check@eque2.test",
    GIT_AUTHOR_DATE: "1767225600 +0000",
    GIT_COMMITTER_DATE: "1767225600 +0000",
  }
}

function bunCache(): string {
  const explicit = process.env["BUN_INSTALL_CACHE_DIR"]
  if (explicit) return explicit
  return path.join(process.env["BUN_INSTALL"] || path.join(os.homedir(), ".bun"), "install", "cache")
}

/**
 * The gates run offline: every proxy points at a closed local port, so any registry request fails, and the install
 * reads the local Bun cache only. No RELEASE_NOTES_REGISTRY is passed, so the deployed scenario must skip.
 */
function gateEnv(root: string): Record<string, string> {
  const closed = "http://127.0.0.1:9"
  return {
    PATH: [path.dirname(process.execPath), process.env["PATH"] ?? ""].join(path.delimiter),
    HOME: root,
    TMPDIR: os.tmpdir(),
    BUN_INSTALL_CACHE_DIR: bunCache(),
    HTTP_PROXY: closed,
    HTTPS_PROXY: closed,
    http_proxy: closed,
    https_proxy: closed,
    NO_COLOR: "1",
  }
}

async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

async function git(dir: string, root: string, ...args: string[]): Promise<string> {
  const result = await run(["git", ...args], dir, isolatedGitEnv(root))
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** Copies the seed into `<root>/repo` and commits it as the starting point of a run. */
async function seedRepo(root: string): Promise<string> {
  const dir = path.join(root, "repo")
  await fs.cp(SEED, dir, { recursive: true })
  await git(dir, root, "init", "-q")
  await git(dir, root, "add", "-A")
  await git(dir, root, "commit", "-q", "-m", "seed")
  return dir
}

/** Writes one leaf's files, commits them, and returns the paths that the commit changed. */
async function buildLeaf(dir: string, root: string, id: string, leaf: Leaf): Promise<string[]> {
  for (const [target, source] of Object.entries(leaf.files)) {
    await fs.mkdir(path.dirname(path.join(dir, target)), { recursive: true })
    await fs.copyFile(path.join(SOLUTION, source), path.join(dir, target))
  }
  await git(dir, root, "add", "-A")
  await git(dir, root, "commit", "-q", "-m", `${id}: build the leaf`)
  const changed = await git(dir, root, "show", "--name-only", "--format=", "HEAD")
  return changed.split("\n").filter((line) => line !== "")
}

function unescapeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/** Every test case of a JUnit report, by title, with its outcome. */
function testCases(xml: string): { name: string; status: Status }[] {
  const cases: { name: string; status: Status }[] = []
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = unescapeXml(/\bname="([^"]*)"/.exec(match[1] ?? "")?.[1] ?? "")
    const body = match[2] ?? ""
    const status: Status = /<(failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed"
    cases.push({ name, status })
  }
  return cases
}

/** Runs the four gates of SPEC.md in order and returns each result plus the test cases of the JUnit report. */
async function gates(dir: string, root: string) {
  const env = gateEnv(root)
  const bun = process.execPath
  const report = path.join(root, "junit.xml")
  const install = await run([bun, "install", "--frozen-lockfile"], dir, env)
  const typecheck = await run([bun, "run", "typecheck"], dir, env)
  const lint = await run([bun, "run", "lint"], dir, env)
  const build = await run([bun, "run", "build"], dir, env)
  const tests = await run([bun, "test", "--reporter=junit", `--reporter-outfile=${report}`], dir, env)
  const xml = await fs.readFile(report, "utf8").catch(() => "")
  return { install, typecheck, lint, build, tests, cases: testCases(xml) }
}

function exitCodes(result: Awaited<ReturnType<typeof gates>>) {
  const summary = (gate: Run) =>
    gate.code === 0 ? 0 : { code: gate.code, output: (gate.stdout + gate.stderr).slice(-4000) }
  return {
    install: summary(result.install),
    typecheck: summary(result.typecheck),
    lint: summary(result.lint),
    build: summary(result.build),
    test: summary(result.tests),
  }
}

/** Expected tags that have no passing test, and tags that must skip but did not. */
function proofGaps(cases: { name: string; status: Status }[], tags: string[], skipped: string[]) {
  const statuses = new Map<string, Status[]>()
  for (const testCase of cases) {
    const tag = /^\[([^\]]+)\]/.exec(testCase.name)?.[1]
    if (tag === undefined) continue
    statuses.set(tag, [...(statuses.get(tag) ?? []), testCase.status])
  }
  return {
    unproved: tags.filter((tag) => !(statuses.get(tag) ?? []).includes("passed")),
    notSkipped: skipped.filter((tag) => {
      const seen = statuses.get(tag) ?? []
      return seen.length === 0 || seen.some((status) => status !== "skipped")
    }),
    failed: cases.filter((testCase) => testCase.status === "failed").map((testCase) => testCase.name),
  }
}

describe("release-notes task tree completion", () => {
  test("tasks.json matches the tree: order, touches plus tests, hints and tags", async () => {
    const tasks = await loadTasks()
    const tree = await requirements()
    expect([...tasks.keys()]).toEqual(ORDER)
    expect([...tree.keys()].sort()).toEqual([...ORDER].sort())
    for (const id of ORDER) {
      const leaf = tasks.get(id)
      const required = tree.get(id)
      if (!leaf || !required) throw new Error(`${id} is missing`)
      // The tree builds a leaf only after the leaves it waits for.
      for (const after of required.after.filter((need) => ORDER.includes(need))) {
        expect(ORDER.indexOf(after)).toBeLessThan(ORDER.indexOf(id))
      }
      // touches-plus-tests: every touch is written, and nothing outside the touches except test files.
      const targets = Object.keys(leaf.files)
      expect({ id, missing: required.touches.filter((touch) => !targets.includes(touch)) }).toEqual({ id, missing: [] })
      expect({
        id,
        extra: targets.filter((target) => !required.touches.includes(target) && !target.startsWith("test/")),
      }).toEqual({ id, extra: [] })
      expect(targets).toContain(required.hint)
      expect({ id, tags: [...leaf.tags].sort() }).toEqual({ id, tags: [...required.tags].sort() })
      expect({ id, skipped: [...(leaf.skipped ?? [])].sort() }).toEqual({ id, skipped: [...required.skipped].sort() })
      for (const source of Object.values(leaf.files)) {
        expect(await Bun.file(path.join(SOLUTION, source)).exists()).toBe(true)
      }
    }

    // T1.4.p1: the final package.json is the seed's plus the `bin` entry, nothing else.
    const seed: unknown = JSON.parse(await fs.readFile(path.join(SEED, "package.json"), "utf8"))
    const final = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(await fs.readFile(path.join(SOLUTION, "package.json"), "utf8")))
    const { bin, ...rest } = final
    expect(bin).toEqual({ "release-notes": "src/cli.ts" })
    expect(rest).toEqual(z.record(z.string(), z.unknown()).parse(seed))
  })

  test(
    "the stage-T1.4 tree (T1.1 to T1.4) passes the four gates",
    async () => {
      const tasks = await loadTasks()
      const tree = await requirements()
      await using tmp = await tmpdir()
      const dir = await seedRepo(tmp.path)
      const built = ORDER.slice(0, ORDER.indexOf("T1.4") + 1)
      for (const id of built) {
        const leaf = Leaf.parse(tasks.get(id))
        expect({ id, changed: (await buildLeaf(dir, tmp.path, id, leaf)).sort() }).toEqual({
          id,
          changed: Object.keys(leaf.files).sort(),
        })
      }
      const result = await gates(dir, tmp.path)
      expect(exitCodes(result)).toEqual({ install: 0, typecheck: 0, lint: 0, build: 0, test: 0 })
      const tags = built.flatMap((id) => tree.get(id)?.tags ?? [])
      const skipped = built.flatMap((id) => tree.get(id)?.skipped ?? [])
      expect(proofGaps(result.cases, tags, skipped)).toEqual({ unproved: [], notSkipped: [], failed: [] })
    },
    TIMEOUT,
  )

  test(
    "the full tree (T1.1 to T1.5) passes the four gates offline with every obligation and scenario proved",
    async () => {
      const tasks = await loadTasks()
      const tree = await requirements()
      await using tmp = await tmpdir()
      const dir = await seedRepo(tmp.path)
      for (const id of ORDER) {
        const leaf = Leaf.parse(tasks.get(id))
        expect({ id, changed: (await buildLeaf(dir, tmp.path, id, leaf)).sort() }).toEqual({
          id,
          changed: Object.keys(leaf.files).sort(),
        })
      }
      expect(await git(dir, tmp.path, "status", "--porcelain")).toBe("")

      const result = await gates(dir, tmp.path)
      expect(exitCodes(result)).toEqual({ install: 0, typecheck: 0, lint: 0, build: 0, test: 0 })
      expect(await Bun.file(path.join(dir, "dist", "cli.js")).exists()).toBe(true)

      const tags = ORDER.flatMap((id) => tree.get(id)?.tags ?? [])
      const skipped = ORDER.flatMap((id) => tree.get(id)?.skipped ?? [])
      // 26 test-proved obligations, S1 to S12, and S13 skipped.
      expect(tags).toHaveLength(26 + 12)
      expect(skipped).toEqual(["S13"])
      expect(proofGaps(result.cases, tags, skipped)).toEqual({ unproved: [], notSkipped: [], failed: [] })

      // The gates leave the committed tree as it was: the install is frozen and dist/ and node_modules/ are ignored.
      expect(await git(dir, tmp.path, "status", "--porcelain")).toBe("")
    },
    TIMEOUT,
  )
})
