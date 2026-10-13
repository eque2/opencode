/**
 * migrate-legacy-read.ts — the ONE sanctioned legacy key read.
 *
 * MIGRATE-LEGACY-READ-SANCTIONED — this marker exempts this file (and only
 * this file) from the workstream's keychain/sops deletion sweeps. It exists
 * solely so `state.mjs key migrate` can move a LEGACY key (OS keychain era,
 * SOPS-blob era) into the committed plaintext keyring. It is deliberately NOT
 * bundled into any shipped .mjs (the bundles stay keychain-free by
 * construction) and is flagged for removal in a later release once live
 * installs have migrated.
 *
 * Output: one JSON object on stdout:
 *   { "keychain": "<64-hex>"|null, "sops": "<64-hex>"|null,
 *     "sopsBlobPresent": boolean, "sopsError": string|null }
 * Exit 0 always (callers branch on the JSON, not the exit code).
 *
 * Usage: tsx migrate-legacy-read.ts --project-root <path>
 */

import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY_RE = /^[0-9a-fA-F]{64}$/

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Both the resolved AND realpath forms — the legacy era hashed whichever the
 * bootstrap saw (symlinked /tmp vs /private/tmp on macOS diverge). */
function projectHashes(projectRoot: string): string[] {
  const forms = new Set([path.resolve(projectRoot)])
  try {
    forms.add(fs.realpathSync(projectRoot))
  } catch {
    /* fine — resolved form only */
  }
  return [...forms].map((f) => crypto.createHash('sha256').update(f).digest('hex').slice(0, 12))
}

const PROBE_TIMEOUT_MS = 15000

/** The legacy keychain entry (service `eque2-code-integrity`), via any
 * available reader. `blocked: true` when a probe looks interaction-gated
 * (locked keychain / ACL prompt / timeout) — the parent maps that to the
 * headless-needs-interactive cell instead of a false "no entry". */
function readKeychain(projectRoot: string): { key: string | null; blocked: boolean } {
  let blocked = false
  for (const account of projectHashes(projectRoot)) {
    // 1. cross-keychain (PATH, then this skill's local bin)
    const candidates = [
      'cross-keychain',
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'cross-keychain'),
    ]
    for (const cli of candidates) {
      const probe = spawnSync(cli, ['get', 'eque2-code-integrity', account], { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS })
      if (probe.signal) blocked = true // killed on timeout — likely a GUI prompt
      if (probe.status === 0) {
        const v = probe.stdout.trim()
        if (KEY_RE.test(v)) return { key: v.toLowerCase(), blocked: false }
      }
    }
    // 2. macOS native
    if (process.platform === 'darwin') {
      const probe = spawnSync('security', ['find-generic-password', '-s', 'eque2-code-integrity', '-a', account, '-w'], { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS })
      if (probe.signal || /user interaction is not allowed|errSecInteractionNotAllowed|user canceled/i.test(probe.stderr ?? '')) blocked = true
      if (probe.status === 0) {
        const v = probe.stdout.trim()
        if (KEY_RE.test(v)) return { key: v.toLowerCase(), blocked: false }
      }
    }
    // 3. Linux secret-tool
    if (process.platform.startsWith('linux')) {
      const probe = spawnSync('secret-tool', ['lookup', 'service', 'eque2-code-integrity', 'account', account], { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS })
      if (probe.signal) blocked = true
      if (probe.status === 0) {
        const v = probe.stdout.trim()
        if (KEY_RE.test(v)) return { key: v.toLowerCase(), blocked: false }
      }
    }
  }
  return { key: null, blocked }
}

/** The legacy SOPS blob, when present and decryptable on this machine. */
function readSops(projectRoot: string): { key: string | null; present: boolean; error: string | null } {
  const blob = [
    path.join(projectRoot, 'state', '.integrity-key.sops.json'),
    path.join(projectRoot, '.integrity-key.sops.json'),
  ].find((p) => fs.existsSync(p))
  if (!blob) return { key: null, present: false, error: null }
  const probe = spawnSync('sops', ['--decrypt', '--extract', '["integrityKey"]', blob], { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS })
  if (probe.status === 0) {
    const v = probe.stdout.trim()
    if (KEY_RE.test(v)) return { key: v.toLowerCase(), present: true, error: null }
    return { key: null, present: true, error: 'decrypted value is not a 64-hex key' }
  }
  return { key: null, present: true, error: (probe.stderr || 'sops decrypt failed (binary missing or not a recipient)').trim().split('\n')[0]! }
}

function main(): void {
  const projectRoot = arg('--project-root') ?? process.cwd()
  const keychain = readKeychain(projectRoot)
  const sops = readSops(projectRoot)
  process.stdout.write(
    JSON.stringify({
      keychain: keychain.key,
      keychainBlocked: keychain.blocked,
      sops: sops.key,
      sopsBlobPresent: sops.present,
      sopsError: sops.error,
    }) + '\n',
  )
}

main()
