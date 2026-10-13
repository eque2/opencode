// A fresh target repository for one conformance check: the release-notes seed plus the two blend trees, committed,
// with dependencies installed offline from the local Bun cache. Everything lives under the run folder (D12).
import path from "node:path"
import fs from "node:fs"

const testRoot = path.resolve(import.meta.dir, "..")
const repoRoot = path.resolve(testRoot, "../../../..")
export const seedDir = path.join(testRoot, "release-notes-repo")
export const solutionDir = path.join(testRoot, "release-notes-solution")
export const releaseNotesSpec = "task-formats/blend/release-notes.spec"
export const t2Task = "task-formats/blend/provider-ordering-admin.spec/T2-services.task"

export type Workspace = { readonly dir: string; readonly repo: string; readonly home: string }

const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "conformance",
  GIT_AUTHOR_EMAIL: "conformance@eque2.test",
  GIT_COMMITTER_NAME: "conformance",
  GIT_COMMITTER_EMAIL: "conformance@eque2.test",
}

export function git(repo: string, ...args: string[]) {
  const out = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, ...gitEnv } })
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString()}`)
  return out.stdout.toString().trim()
}

export function create(runDir: string, name: string): Workspace {
  const dir = path.join(runDir, name)
  fs.rmSync(dir, { recursive: true, force: true })
  const repo = path.join(dir, "repo")
  const home = path.join(dir, "home")
  fs.mkdirSync(home, { recursive: true })
  fs.cpSync(seedDir, repo, { recursive: true })
  for (const tree of ["release-notes.spec", "provider-ordering-admin.spec"]) {
    fs.cpSync(path.join(repoRoot, "task-formats/blend", tree), path.join(repo, "task-formats/blend", tree), { recursive: true })
  }
  git(repo, "init", "-q", "-b", "main")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "seed")
  // One install of the seed's frozen lockfile per lockfile, linked into every check's repository: a fresh install
  // per check left about 2,000 files per check behind, and indexing them loaded the machine. `node_modules` is in
  // the seed's .gitignore, so the link is never committed.
  fs.symlinkSync(sharedModules(path.dirname(runDir)), path.join(repo, "node_modules"))
  return { dir, repo, home }
}

// `<runs folder>/seed-modules/<lockfile hash>/node_modules`, installed once; a marker file says it is complete.
function sharedModules(runsDir: string) {
  const lock = fs.readFileSync(path.join(seedDir, "bun.lock"))
  const hash = new Bun.CryptoHasher("sha256").update(lock).digest("hex").slice(0, 16)
  const dir = path.join(runsDir, "seed-modules", hash)
  const done = path.join(dir, ".installed")
  if (!fs.existsSync(done)) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    for (const file of ["package.json", "bun.lock"]) fs.copyFileSync(path.join(seedDir, file), path.join(dir, file))
    // Bounded: a stuck install (a cache miss going to the network) must not hold the check. A null exit code means
    // the bound killed it.
    const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: dir, timeout: 120_000 })
    if (install.exitCode !== 0)
      throw new Error(
        `bun install failed in ${dir}: ${install.exitCode === null ? "not finished within 120 s" : install.stderr.toString()}`,
      )
    fs.writeFileSync(done, new Date().toISOString())
  }
  return path.join(dir, "node_modules")
}

// Edit a file in the target repository and commit it on the current branch (H9 edits a trusted leaf's VERIFY.md).
export function editAndCommit(repo: string, file: string, edit: (text: string) => string, message: string) {
  const full = path.join(repo, file)
  fs.writeFileSync(full, edit(fs.readFileSync(full, "utf8")))
  git(repo, "add", file)
  git(repo, "commit", "-q", "-m", message)
}

export function solutionTasks(): Record<string, { files: Record<string, string>; tags?: string[] }> {
  return JSON.parse(fs.readFileSync(path.join(solutionDir, "tasks.json"), "utf8"))
}

export function solutionFile(source: string) {
  return fs.readFileSync(path.join(solutionDir, source), "utf8")
}
