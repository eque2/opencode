export type BumpInput = { type: string; breaking: boolean }

export type Bump = "major" | "minor" | "patch" | "none"

// Semantic Versioning 2.0.0: numeric parts without leading zeros, an optional pre-release and build metadata.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 }

function bumpOf(commit: BumpInput, major: bigint): Bump {
  if (commit.breaking) return major === 0n ? "minor" : "major"
  const type = commit.type.toLowerCase()
  if (type === "feat") return "minor"
  if (type === "fix" || type === "perf") return "patch"
  return "none"
}

export function nextVersion(
  current: string,
  commits: BumpInput[],
): { bump: "major" | "minor" | "patch" | "none"; next: string } | { error: string } {
  const match = SEMVER.exec(current)
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return { error: `"${current}" is not a semantic version` }
  }
  const major = BigInt(match[1])
  const minor = BigInt(match[2])
  const patch = BigInt(match[3])

  let bump: Bump = "none"
  for (const commit of commits) {
    const candidate = bumpOf(commit, major)
    if (RANK[candidate] > RANK[bump]) bump = candidate
  }

  if (bump === "major") return { bump, next: `${major + 1n}.0.0` }
  if (bump === "minor") return { bump, next: `${major}.${minor + 1n}.0` }
  if (bump === "patch") return { bump, next: `${major}.${minor}.${patch + 1n}` }
  return { bump, next: current }
}
