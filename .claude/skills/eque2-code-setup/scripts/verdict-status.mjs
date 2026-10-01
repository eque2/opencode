#!/usr/bin/env node
// CJS require shim for ESM bundles (needed by transitive deps like undici)
import { createRequire as __bundled_createRequire } from "node:module";
const require = __bundled_createRequire(import.meta.url);
// Bundled trigger-file paths point at the build machine, not the install
// target. The trust-graph scan is a build-time check, implicitly proven
// once bundled — default it off here so the host-run reporter does not
// fail on a non-existent path. Explicit EQUE2_GRAPH_SKIP_SCAN=0 still wins.
process.env.EQUE2_GRAPH_SKIP_SCAN ??= "1";
// src/eque2-code/scripts/verdict-status.ts
import * as fs3 from "node:fs";
import * as path3 from "node:path";
import { parseArgs } from "node:util";

// src/eque2-code/scripts/fsstate.ts
import * as fs from "node:fs";
import * as path from "node:path";
function stateDir(specFolder) {
  return path.join(specFolder, "state");
}
function eventLogPath(specFolder) {
  return path.join(stateDir(specFolder), "events.jsonl");
}
function compareEvent(aHlc, aActor, bHlc, bActor) {
  if (aHlc.wall !== bHlc.wall) return aHlc.wall - bHlc.wall;
  if (aHlc.counter !== bHlc.counter) return aHlc.counter - bHlc.counter;
  if (aActor < bActor) return -1;
  if (aActor > bActor) return 1;
  return 0;
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
function readEvents(specFolder) {
  const p = eventLogPath(specFolder);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8");
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isEvent(parsed)) events.push(parsed);
  }
  return events;
}
function isEvent(v) {
  if (!v || typeof v !== "object") return false;
  const e = v;
  return typeof e.actor === "string" && typeof e.testId === "string" && typeof e.event === "string" && !!e.hlc && typeof e.hlc.wall === "number" && typeof e.hlc.counter === "number";
}
function materialise(events) {
  const winners = /* @__PURE__ */ new Map();
  for (const e of events) {
    const cur = winners.get(e.testId);
    if (cur === void 0 || compareEvent(e.hlc, e.actor, cur.hlc, cur.actor) > 0) {
      winners.set(e.testId, e);
    }
  }
  const snapshots = /* @__PURE__ */ new Map();
  for (const [testId, e] of winners) {
    snapshots.set(testId, {
      testId,
      event: e.event,
      actor: e.actor,
      hlc: e.hlc,
      ...e.payload !== void 0 ? { payload: e.payload } : {}
    });
  }
  return snapshots;
}
function materialiseFromDisk(specFolder) {
  return materialise(readEvents(specFolder));
}

// src/eque2-code/scripts/verdict.ts
import * as crypto from "node:crypto";
import * as fs2 from "node:fs";
import * as path2 from "node:path";
function hashTestFile(absPath) {
  return crypto.createHash("sha256").update(fs2.readFileSync(absPath)).digest("hex");
}
function signersDir(specFolder) {
  return path2.join(stateDir(specFolder), "signers");
}
function loadSigners(specFolder) {
  const dir = signersDir(specFolder);
  if (!fs2.existsSync(dir)) return {};
  const registry = {};
  for (const name of fs2.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(fs2.readFileSync(path2.join(dir, name), "utf-8"));
      const keyId = entry.keyId ?? name.replace(/\.json$/, "");
      if (typeof entry.pubkey === "string") registry[keyId] = { pubkey: entry.pubkey, identity: entry.identity };
    } catch {
      continue;
    }
  }
  return registry;
}
function verifyVerdict(verdict, signers, expected) {
  if (!isWellFormed(verdict)) return { valid: false, reason: "malformed" };
  if (verdict.payload.testFileHash !== expected.testFileHash) {
    return { valid: false, reason: "binding" };
  }
  if (expected.commitSha !== void 0 && verdict.payload.commitSha !== expected.commitSha) {
    return { valid: false, reason: "binding" };
  }
  const entry = signers[verdict.signer];
  if (!entry) return { valid: false, reason: "unknown-signer" };
  const ok = safeVerify(canonicalJson(verdict.payload), verdict.signature, entry.pubkey);
  if (!ok) return { valid: false, reason: "signature" };
  return { valid: true };
}
function isWellFormed(v) {
  const p = v?.payload;
  return !!p && typeof p.testId === "string" && typeof p.testFileHash === "string" && typeof p.commitSha === "string" && (p.result === "passing" || p.result === "failing") && typeof p.ts === "string" && typeof p.nonce === "string" && typeof v.signature === "string" && typeof v.signer === "string";
}
function safeVerify(message, signatureB64, publicKeyPem) {
  try {
    return crypto.verify(null, Buffer.from(message), crypto.createPublicKey(publicKeyPem), Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
function verdictOf(snap) {
  const v = snap?.payload?.verdict;
  return v && isWellFormed(v) ? v : void 0;
}
function testFilePathOf(snap) {
  const p = snap?.payload?.testFilePath;
  return typeof p === "string" ? p : void 0;
}

// src/eque2-code/scripts/verdict-status.ts
var RESET = "[0m";
var BOLD = "[1m";
var GREEN = "[32m";
var RED = "[41;97m";
var { values } = parseArgs({
  args: process.argv.slice(2),
  options: { spec: { type: "string" }, repo: { type: "string" }, strict: { type: "boolean" } },
  allowPositionals: true
});
var spec = values.spec ?? process.cwd();
var repo = values.repo ?? spec;
var rows = [];
for (const [testId, snap] of materialiseFromDisk(spec)) {
  if (snap.event !== "verified_passing" && snap.event !== "failed") continue;
  if (snap.event === "failed") {
    rows.push({ testId, status: "failed", reason: "result-failing" });
    continue;
  }
  const rel = testFilePathOf(snap);
  const verdict = verdictOf(snap);
  if (!rel || !verdict) {
    rows.push({ testId, status: "unverified", reason: "no-verdict" });
    continue;
  }
  const abs = path3.isAbsolute(rel) ? rel : path3.join(repo, rel);
  if (!fs3.existsSync(abs)) {
    rows.push({ testId, status: "failed", reason: "test-file-missing" });
    continue;
  }
  const outcome = verifyVerdict(verdict, loadSigners(spec), { testFileHash: hashTestFile(abs) });
  rows.push(outcome.valid ? { testId, status: "verified" } : { testId, status: "failed", reason: outcome.reason });
}
var verified = rows.filter((r) => r.status === "verified");
var failed = rows.filter((r) => r.status === "failed");
var unverified = rows.filter((r) => r.status === "unverified");
var parts = [`${BOLD}${GREEN}\u2705 ${verified.length} verified${RESET}`];
if (unverified.length > 0) parts.push(`${BOLD}\u26A0\uFE0F  ${unverified.length} unverified${RESET}`);
if (failed.length > 0) {
  parts.push(`${BOLD}${RED} \u274C ${failed.length} FAILED VERIFICATION ${RESET} ${failed.map((f) => f.testId).join(", ")}`);
}
process.stdout.write(`
Test-state verdicts:  ${parts.join("   ")}
`);
for (const f of failed) process.stdout.write(`  \u274C ${f.testId}${f.reason ? ` (${f.reason})` : ""}
`);
process.stdout.write("\n");
process.exit(values.strict && failed.length > 0 ? 1 : 0);
