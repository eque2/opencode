/**
 * verify-integrity-key.ts — the setup skill's key-layer verification with
 * three-case detection (committed-plaintext-key workstream, CAP-11 +
 * Observability §setup-verify).
 *
 * Machine contract: a single JSON result object on STDOUT; human prose
 * (✅/❌ + guidance) on STDERR. Exit 0 = healthy (or greenfield); exit 1 =
 * a hard failure (broken clone, malformed keyring, seal failure).
 *
 * Cases:
 *   present             — the committed keyring `{projectRoot}/state/integrity-key.json`
 *                         exists: verify a sign/verify round-trip and every
 *                         signed record in every committed event log under the
 *                         full keyId map; report the file's git status
 *                         (untracked/ignored → WARN + commit instruction, not
 *                         a failure).
 *   absent-with-history — no keyring but signed history exists: a broken
 *                         clone. Exit 1; remedies: `git pull` the keyring
 *                         commit, or `state.mjs key migrate` on a key-holding
 *                         machine.
 *   greenfield          — no keyring, no signed history: a brand-new repo.
 *                         Exit 0; guidance: ONE maintainer runs
 *                         `state.mjs key init` and commits the file.
 *
 * The key is committed PLAINTEXT by design — protected by agent policy, not
 * secrecy. An `INTEGRITY_KEY(S)` env override is the exceptional path
 * (overlay semantics) and is reported as `source: "env-override"`.
 *
 * Self-contained plain-Node — MUST mirror `src/eque2-code/scripts/integrity.ts`
 * (same file shape `{"activeKeyId":"<id>","keys":{"<keyId>":"<64-hex>"}}`,
 * same canonicalization).
 *
 * Usage: tsx verify-integrity-key.ts --project-root <path>
 */

import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

const KEY_RE = /^[0-9a-fA-F]{64}$/

interface Check {
  name: string
  passed: boolean
  detail: string
}

interface Result {
  case: 'present' | 'absent-with-history' | 'greenfield' | 'env-only' | 'malformed' | 'invalid-env'
  source: 'committed-file' | 'env-override' | 'none'
  filePath: string
  gitStatus: 'tracked' | 'untracked' | 'ignored' | 'absent'
  activeKeyId?: string
  knownKeyIds?: string[]
  /** A legacy SOPS-era encrypted key blob is present. Remedy depends on state:
   * keyring resolves → blob is stale, delete it; signed history without a
   * keyring → `key migrate` on the key-holding machine; greenfield → coordinate
   * with the blob's committer before `key init` (prose names them). */
  legacyBlobPresent?: boolean
  checks: Check[]
}

function prose(line: string): void {
  process.stderr.write(line + '\n')
}

let LEGACY_BLOB = false

function emitAndExit(result: Result, code: number): never {
  const final = LEGACY_BLOB ? { ...result, legacyBlobPresent: true } : result
  process.stdout.write(JSON.stringify(final, null, 2) + '\n')
  process.exit(code)
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function keyringPath(projectRoot: string): string {
  return path.join(projectRoot, 'state', 'integrity-key.json')
}

/** The committed keyring and its signed history live at the GIT top-level,
 * never in a subdirectory (matching state.mjs). A caller that passes a
 * sub-folder as --project-root must still resolve to the repo root, otherwise
 * verification reports a false "absent" from a subfolder. Falls back to the
 * passed path when git is unavailable or it is outside a work tree. */
function gitToplevel(projectRoot: string): string {
  const r = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  return projectRoot
}

function gitStatusOf(filePath: string, projectRoot: string): Result['gitStatus'] {
  if (!fs.existsSync(filePath)) return 'absent'
  const rel = path.relative(projectRoot, filePath)
  const tracked = spawnSync('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', rel], { encoding: 'utf-8' })
  if (tracked.status === 0) return 'tracked'
  const ignored = spawnSync('git', ['-C', projectRoot, 'check-ignore', '-q', rel], { encoding: 'utf-8' })
  if (ignored.status === 0) return 'ignored'
  return 'untracked'
}

/** Read + validate the committed keyring file. undefined when absent; null when malformed. */
function readKeyringFile(filePath: string): { activeKeyId: string; keys: Record<string, string> } | undefined | null {
  if (!fs.existsSync(filePath)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  const obj = parsed as Record<string, unknown>
  if (!obj || typeof obj !== 'object' || typeof obj.activeKeyId !== 'string' || !obj.keys || typeof obj.keys !== 'object') {
    return null
  }
  const keys: Record<string, string> = {}
  for (const [id, val] of Object.entries(obj.keys as Record<string, unknown>)) {
    if (typeof val !== 'string' || !KEY_RE.test(val)) return null
    keys[id] = val.toLowerCase()
  }
  if (!Object.hasOwn(keys, obj.activeKeyId)) return null
  return { activeKeyId: obj.activeKeyId, keys }
}

/** Numeric-aware highest keyId — mirrors integrity.ts's `highestKeyId`. */
function highestKeyId(ids: string[]): string {
  const allNumeric = ids.every((id) => /^\d+$/.test(id))
  const sorted = allNumeric ? [...ids].sort((a, b) => Number(a) - Number(b)) : [...ids].sort()
  return sorted[sorted.length - 1]!
}

/** Emit an invalid-env JSON envelope + prose, exit 1 — the machine contract holds even here. */
function failInvalidEnv(cause: string, fix: string): never {
  prose(`❌ ${cause}`)
  prose(`   fix: ${fix}`)
  emitAndExit(
    {
      case: 'invalid-env',
      source: 'env-override',
      filePath: '',
      gitStatus: 'absent',
      checks: [{ name: 'env-override', passed: false, detail: cause }],
    },
    1,
  )
}

/** The env-override half — validated to MIRROR integrity.ts; undefined when unset. */
function resolveEnvRing(): { activeKeyId: string; keys: Record<string, string> } | undefined {
  const multi = process.env.INTEGRITY_KEYS?.trim()
  if (multi) {
    let parsed: unknown
    try {
      parsed = JSON.parse(multi)
    } catch {
      failInvalidEnv('INTEGRITY_KEYS is not valid JSON', 'expected {"<keyId>":"<64 hex chars>"}')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      failInvalidEnv('INTEGRITY_KEYS must be a JSON object of keyId → 64-hex-char key', 'expected {"<keyId>":"<64 hex chars>"}')
    }
    const keys: Record<string, string> = {}
    for (const [id, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val !== 'string' || !KEY_RE.test(val)) {
        failInvalidEnv(`INTEGRITY_KEYS["${id}"] is not 64 hex characters`, 'every value must be a 32-byte key as 64 hex chars')
      }
      keys[id] = val.toLowerCase()
    }
    const ids = Object.keys(keys)
    if (ids.length === 0) failInvalidEnv('INTEGRITY_KEYS is empty', 'provide at least one keyId → key entry')
    const wantId = process.env.INTEGRITY_KEY_ID?.trim()
    const activeKeyId = wantId && Object.hasOwn(keys, wantId) ? wantId : highestKeyId(ids)
    return { activeKeyId, keys }
  }
  const single = process.env.INTEGRITY_KEY?.trim()
  if (single) {
    if (!KEY_RE.test(single)) {
      failInvalidEnv('INTEGRITY_KEY is not 64 hex chars', 'export a valid 32-byte key as INTEGRITY_KEY')
    }
    const id = process.env.INTEGRITY_KEY_ID?.trim() || '1'
    return { activeKeyId: id, keys: { [id]: single.toLowerCase() } }
  }
  return undefined
}

// --- the one HMAC primitive, reproduced (must match scripts/integrity.ts) ---

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}
function tagOf(record: unknown, keyHex: string): string {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(JSON.stringify(canonical(record)), 'utf-8').digest('hex')
}

/**
 * Every GIT-TRACKED events.jsonl in the project. Only tracked logs count:
 * gitignored scratch stores and vendored/untracked fixtures must neither
 * trigger the broken-clone case nor be verified under this project's keyring
 * (E2/E3 review). Falls back to a pruned walk when git is unavailable.
 */
function findEventLogs(projectRoot: string): string[] {
  const tracked = spawnSync('git', ['-C', projectRoot, 'ls-files', '*events.jsonl'], { encoding: 'utf-8' })
  if (tracked.status === 0) {
    return (tracked.stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .map((rel) => path.join(projectRoot, rel))
      .filter((p) => fs.existsSync(p))
  }
  const skip = new Set(['.git', 'node_modules', '.eque2-tests', '.pnpm-store', '__pycache__', 'dist', '.venv', 'coverage', '.next', 'vendor', '.turbo', 'target'])
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(path.join(dir, e.name))
      } else if (e.name === 'events.jsonl') {
        out.push(path.join(dir, e.name))
      }
    }
  }
  walk(projectRoot)
  return out
}

/** Parse a log's SIGNED lines (keyId+tag). Unsigned fsstate lines are skipped. */
function signedLines(log: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of fs.readFileSync(log, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof rec.tag === 'string' && typeof rec.keyId === 'string') out.push(rec)
  }
  return out
}

/** Count readable signer public keys across every state/signers dir near a log. */
function countSigners(logs: string[]): number {
  const dirs = new Set(logs.map((l) => path.join(path.dirname(l), 'signers')))
  let n = 0
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith('.json')) continue
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(d, name), 'utf-8')) as { pubkey?: unknown }
        if (typeof entry.pubkey === 'string') n++
      } catch {
        continue
      }
    }
  }
  return n
}

/** CAP-10: the setup verify step DETECTS legacy sources and routes to migrate.
 * MIGRATE-LEGACY-READ-SANCTIONED (detection-only: an existsSync on the legacy
 * blob path — no decryption, no keychain; the read itself lives in
 * migrate-legacy-read.ts). */
function legacyBlobPath(projectRoot: string): string | undefined {
  return [
    path.join(projectRoot, 'state', '.integrity-key.sops.json'),
    path.join(projectRoot, '.integrity-key.sops.json'),
  ].find((p) => fs.existsSync(p))
}

/** Who committed the legacy blob (the SOPS-era bootstrapper) — the person to
 * coordinate with. undefined when the blob is untracked or git is unavailable. */
function blobCommitter(projectRoot: string, blobPath: string): string | undefined {
  const rel = path.relative(projectRoot, blobPath)
  const r = spawnSync('git', ['-C', projectRoot, 'log', '-1', '--format=%an <%ae> on %as', '--', rel], { encoding: 'utf-8' })
  const line = r.status === 0 ? (r.stdout ?? '').trim() : ''
  return line || undefined
}

/** Signed-history sweep across ALL fetched refs, not just the current checkout —
 * an events.jsonl on an unmerged branch must block a confident "greenfield". */
function eventLogsOnAnyRef(projectRoot: string): boolean {
  const r = spawnSync('git', ['-C', projectRoot, 'log', '--all', '--name-only', '--format=', '--', '*events.jsonl'], { encoding: 'utf-8' })
  return r.status === 0 && (r.stdout ?? '').trim().length > 0
}

function main(): void {
  const projectRoot = gitToplevel(arg('--project-root') ?? process.cwd())
  const filePath = keyringPath(projectRoot)
  const gitStatus = gitStatusOf(filePath, projectRoot)
  const blobPath = legacyBlobPath(projectRoot)
  LEGACY_BLOB = blobPath !== undefined
  const envRing = resolveEnvRing()
  const fileRing = readKeyringFile(filePath)
  const logs = findEventLogs(projectRoot)
  const allSigned = logs.flatMap((l) => signedLines(l).map((rec) => ({ log: l, rec })))

  // Legacy SOPS-era blob: the guidance depends on where the repo actually is —
  // an unconditional "run key migrate" dead-ends a non-recipient on a repo
  // where nothing is signed yet (live defect, 2026-07-13).
  if (blobPath) {
    const who = blobCommitter(projectRoot, blobPath)
    const whoLine = who ? `committed by ${who}` : 'committer unknown (blob untracked)'
    if (fileRing || envRing) {
      prose(`ℹ️  a legacy encrypted key blob (${whoLine}) is still in this repo, but the committed keyring already resolves — the blob is stale. Confirm the team is on the committed keyring, then delete the blob (and any .sops.yaml) in a follow-up commit.`)
    } else if (allSigned.length > 0) {
      prose(`ℹ️  a legacy encrypted key blob (${whoLine}) is present and signed history exists — run \`node state.mjs key migrate\` on a machine that holds the legacy key (the blob's committer's machine has it in the OS keychain; no age identity needed there), then commit the keyring and delete the blob in a follow-up commit.`)
    }
    // keyring absent + no signed history: guidance is printed by the greenfield branch below.
  }

  // Malformed committed file — its own named case (a file defect, never "tamper").
  if (fileRing === null && !envRing) {
    prose(`❌ committed keyring ${filePath} is malformed — a file defect, not tampering.`)
    prose('   fix: repair the JSON (expected {"activeKeyId":"<id>","keys":{"<keyId>":"<64 hex>"}}) or `git checkout` the file')
    emitAndExit({ case: 'malformed', source: 'none', filePath, gitStatus, checks: [{ name: 'keyring-file', passed: false, detail: 'malformed' }] }, 1)
  }

  // Three-case detection when nothing resolves.
  if (!fileRing && !envRing) {
    if (allSigned.length > 0) {
      prose(`❌ keyring absent but signed history exists (${logs.length} log(s)) — a broken clone.`)
      prose('   fix: `git pull` the maintainer\'s keyring commit, or run `node state.mjs key migrate` on a machine that still holds the legacy key')
      emitAndExit(
        {
          case: 'absent-with-history',
          source: 'none',
          filePath,
          gitStatus: 'absent',
          checks: [{ name: 'keyring-file', passed: false, detail: `absent while ${allSigned.length} signed record(s) exist` }],
        },
        1,
      )
    }
    if (blobPath) {
      const who = blobCommitter(projectRoot, blobPath)
      const otherRefs = eventLogsOnAnyRef(projectRoot)
      prose('ℹ️  no committed keyring and no signed history on this checkout — but a legacy encrypted key blob exists:')
      prose(`   ${path.relative(projectRoot, blobPath)}, ${who ? `committed by ${who}` : 'untracked (committer unknown)'}.`)
      if (otherRefs) {
        prose('   ⚠️ an events.jsonl exists on another fetched ref — this repo is NOT greenfield. Do NOT `key init`:')
        prose('   the blob\'s key may sign that history. Have the blob\'s committer run `node state.mjs key migrate`')
        prose('   on their machine (the decrypted key is in their OS keychain; no age identity needed).')
        emitAndExit({
          case: 'greenfield', source: 'none', filePath, gitStatus: 'absent',
          checks: [{ name: 'all-refs-sweep', passed: false, detail: 'events.jsonl exists on another fetched ref — do not key init; migrate on the key-holding machine' }],
        }, 0)
      } else {
        prose(`   Preferred: ${who ? `ask ${who.split(' <')[0]}` : 'ask the blob\'s creator'} to run \`node state.mjs key migrate\` on their machine — one command,`)
        prose('   the decrypted key is already in their OS keychain, and any unpushed state they hold stays valid.')
        prose(`   Fallback: once they confirm NO unpushed signed state exists, ONE maintainer runs \`node state.mjs key init\`,`)
        prose('   commits state/integrity-key.json, and deletes the stale blob (and any .sops.yaml) in a follow-up commit,')
        prose('   noting in the commit message that the legacy blob is superseded.')
      }
      emitAndExit({ case: 'greenfield', source: 'none', filePath, gitStatus: 'absent', checks: [] }, 0)
    }
    prose('ℹ️  greenfield: no committed keyring and no signed history yet — nothing to verify.')
    prose('   ONE maintainer (single-bootstrapper discipline) runs: `node state.mjs key init`,')
    prose('   then commits state/integrity-key.json as the printed instruction says; everyone else just pulls.')
    emitAndExit({ case: 'greenfield', source: 'none', filePath, gitStatus: 'absent', checks: [] }, 0)
  }

  // A resolvable key layer: env overlay > file (mirror of integrity.ts semantics).
  const source: Result['source'] = envRing ? 'env-override' : 'committed-file'
  const ring = envRing
    ? { activeKeyId: envRing.activeKeyId, keys: { ...(fileRing ? fileRing.keys : {}), ...envRing.keys } }
    : fileRing!
  const checks: Check[] = []

  if (fileRing === null && envRing) {
    prose(`⚠️  committed keyring ${filePath} is malformed — proceeding on the env override alone; repair the file.`)
    checks.push({ name: 'keyring-file', passed: false, detail: 'malformed (env override active)' })
  } else if (fileRing) {
    const trackedOk = gitStatus === 'tracked'
    checks.push({
      name: 'file-present-tracked',
      passed: trackedOk,
      detail: trackedOk ? 'present and git-tracked' : `present but ${gitStatus}`,
    })
    if (!trackedOk) {
      prose(`⚠️  the keyring is ${gitStatus} — commit state/integrity-key.json so the key rides with every clone.`)
    }
  }

  // Round-trip: the active key signs and verifies.
  const activeKey = ring.keys[ring.activeKeyId]!
  const probe = { probe: 'setup-verify', ts: 'fixed' }
  const rtOk = tagOf(probe, activeKey) === tagOf(probe, activeKey)
  checks.push({ name: 'active-key-roundtrip', passed: rtOk, detail: rtOk ? `activeKeyId ${ring.activeKeyId} signs and verifies` : 'HMAC self-test failed' })
  if (rtOk) prose(`✅ write-then-verify roundtrip passed (activeKeyId ${ring.activeKeyId})`)

  // Every signed record in every committed log verifies under the keyring.
  // ALL rotation gaps are collected (not first-failure) so one pass reports
  // the full set of referenced-but-absent keyIds.
  let verified = 0
  let failedDetail: string | undefined
  const missingKeyIds = new Set<string>()
  for (const { log, rec } of allSigned) {
    const keyId = String(rec.keyId)
    const key = Object.hasOwn(ring.keys, keyId) ? ring.keys[keyId] : undefined
    const relLog = path.relative(projectRoot, log)
    if (!key) {
      missingKeyIds.add(keyId)
      continue
    }
    const { keyId: _k, tag, ...bare } = rec
    if (tagOf(bare, key) !== String(tag)) {
      failedDetail = `record in ${relLog} does not verify under keyId=${keyId} — the record was hand-edited (check the git diff) or the keyring carries the wrong key`
      break
    }
    verified++
  }
  if (!failedDetail && missingKeyIds.size > 0) {
    failedDetail = `records signed under keyId(s) [${[...missingKeyIds].sort().join(', ')}] which the keyring does not hold — most likely a rotation gap: \`git pull\` the latest state/integrity-key.json, or \`node state.mjs key migrate\` where the legacy key exists. If the keyring IS current, treat the records as suspect and check their git diff`
  }
  const eventsOk = failedDetail === undefined
  checks.push({
    name: 'events-verified',
    passed: eventsOk,
    detail: eventsOk ? `${verified} signed record(s) across ${logs.length} log(s)` : failedDetail!,
  })
  if (eventsOk) prose(`✅ committed state verifies under the keyring (${verified} signed record(s))`)
  else prose(`❌ ${failedDetail!}`)

  // Signer trust store is readable (K3 public keys, committed).
  const signerCount = countSigners(logs)
  checks.push({ name: 'signer-trust-store', passed: true, detail: `${signerCount} signer public key(s) readable` })

  const hardFail = !rtOk || !eventsOk
  const result: Result = {
    case: fileRing ? 'present' : 'env-only',
    source,
    filePath,
    gitStatus,
    activeKeyId: ring.activeKeyId,
    knownKeyIds: Object.keys(ring.keys).sort(),
    checks,
  }
  if (!hardFail) prose('✅ key layer verified.')
  emitAndExit(result, hardFail ? 1 : 0)
}

main()
