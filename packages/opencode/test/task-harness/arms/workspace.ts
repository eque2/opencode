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
  GIT_AUTHOR_NAME: "spike",
  GIT_AUTHOR_EMAIL: "spike@eque2.test",
  GIT_COMMITTER_NAME: "spike",
  GIT_COMMITTER_EMAIL: "spike@eque2.test",
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
  const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: repo })
  if (install.exitCode !== 0) throw new Error(`bun install failed in ${repo}: ${install.stderr.toString()}`)
  return { dir, repo, home }
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
