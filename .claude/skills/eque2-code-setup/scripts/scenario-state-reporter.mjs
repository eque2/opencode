#!/usr/bin/env node
// CJS require shim for ESM bundles (needed by transitive deps like undici)
import { createRequire as __bundled_createRequire } from "node:module";
const require = __bundled_createRequire(import.meta.url);
// Bundled trigger-file paths point at the build machine, not the install
// target. The trust-graph scan is a build-time check, implicitly proven
// once bundled — default it off here so the host-run reporter does not
// fail on a non-existent path. Explicit EQUE2_GRAPH_SKIP_SCAN=0 still wins.
process.env.EQUE2_GRAPH_SKIP_SCAN ??= "1";
// src/eque2-code/scripts/reporters/scenario-state-reporter.ts
import * as crypto4 from "node:crypto";
import * as fs6 from "node:fs";
import * as path6 from "node:path";
import { execFileSync } from "node:child_process";

// src/eque2-code/scripts/verdict.ts
import * as crypto from "node:crypto";
import * as fs2 from "node:fs";
import * as path2 from "node:path";

// src/eque2-code/scripts/fsstate.ts
import * as fs from "node:fs";
import * as path from "node:path";
function stateDir(specFolder) {
  return path.join(specFolder, "state");
}
function eventLogPath(specFolder) {
  return path.join(stateDir(specFolder), "events.jsonl");
}
function snapshotPath(specFolder, testId) {
  return path.join(stateDir(specFolder), "snapshots", `${safeId(testId)}.json`);
}
function safeId(testId) {
  return testId.replace(/[^A-Za-z0-9._-]/g, "__");
}
function compareEvent(aHlc, aActor, bHlc, bActor) {
  if (aHlc.wall !== bHlc.wall) return aHlc.wall - bHlc.wall;
  if (aHlc.counter !== bHlc.counter) return aHlc.counter - bHlc.counter;
  if (aActor < bActor) return -1;
  if (aActor > bActor) return 1;
  return 0;
}
function nextHlc(last, now) {
  if (last === void 0) return { wall: now, counter: 0 };
  if (now > last.wall) return { wall: now, counter: 0 };
  return { wall: last.wall, counter: last.counter + 1 };
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
function ensureStateDir(specFolder) {
  const dir = stateDir(specFolder);
  fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
  ensureGitattributes(specFolder);
  return dir;
}
function ensureGitattributes(specFolder) {
  const p = path.join(stateDir(specFolder), ".gitattributes");
  const line = "events.jsonl merge=union\n";
  fs.mkdirSync(stateDir(specFolder), { recursive: true });
  if (fs.existsSync(p)) {
    if (fs.readFileSync(p, "utf-8").includes("merge=union")) return;
    fs.appendFileSync(p, line);
    return;
  }
  fs.writeFileSync(p, line);
}
function appendEvent(specFolder, input, now = Date.now()) {
  ensureStateDir(specFolder);
  const existing = readEvents(specFolder);
  const last = maxHlc(existing);
  const event = {
    hlc: nextHlc(last, now),
    actor: input.actor,
    testId: input.testId,
    event: input.event,
    ...input.payload !== void 0 ? { payload: input.payload } : {}
  };
  fs.appendFileSync(eventLogPath(specFolder), canonicalJson(event) + "\n");
  writeSnapshots(specFolder, materialise([...existing, event]));
  return event;
}
function maxHlc(events) {
  let max;
  for (const e of events) {
    if (max === void 0 || e.hlc.wall > max.wall || e.hlc.wall === max.wall && e.hlc.counter > max.counter) {
      max = e.hlc;
    }
  }
  return max;
}
function writeSnapshots(specFolder, snapshots) {
  const dir = path.join(stateDir(specFolder), "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  for (const [testId, snap] of snapshots) {
    fs.writeFileSync(snapshotPath(specFolder, testId), canonicalJson(snap) + "\n");
  }
}

// src/eque2-code/scripts/verdict.ts
function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}
function hashTestFile(absPath) {
  return crypto.createHash("sha256").update(fs2.readFileSync(absPath)).digest("hex");
}
function buildPayload(input) {
  return {
    testId: input.testId,
    testFileHash: input.testFileHash,
    commitSha: input.commitSha,
    result: input.result,
    ts: input.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
    nonce: input.nonce ?? crypto.randomBytes(12).toString("hex")
  };
}
function signVerdict(payload, keypair) {
  const sig = crypto.sign(null, Buffer.from(canonicalJson(payload)), crypto.createPrivateKey(keypair.privateKeyPem));
  return { payload, signer: keypair.keyId, signature: sig.toString("base64") };
}
function signerKeyPath(specFolder) {
  return path2.join(specFolder, ".signer-key");
}
function keypairFromPrivatePem(privateKeyPem) {
  const publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  return { keyId: fingerprint(publicKeyPem), publicKeyPem, privateKeyPem };
}
function loadSignerKey(specFolder) {
  const p = signerKeyPath(specFolder);
  if (!fs2.existsSync(p)) return void 0;
  try {
    return keypairFromPrivatePem(fs2.readFileSync(p, "utf-8").trim());
  } catch {
    return void 0;
  }
}
function mintVerdict(specFolder, input, keypair) {
  const payload = buildPayload({
    testId: input.testId,
    testFileHash: hashTestFile(input.testFileAbsPath),
    commitSha: input.commitSha,
    result: input.result
  });
  const verdict = signVerdict(payload, keypair);
  appendEvent(specFolder, {
    actor: keypair.keyId,
    testId: input.testId,
    event: input.result === "passing" ? "verified_passing" : "failed",
    payload: {
      verdict,
      ...input.testFilePath !== void 0 ? { testFilePath: input.testFilePath } : {}
    }
  });
  return verdict;
}

// src/eque2-code/scripts/integrity.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import * as crypto2 from "node:crypto";
import * as fs4 from "node:fs";
import * as path4 from "node:path";

// src/eque2-code/scripts/project-root.ts
import { spawnSync } from "node:child_process";
import * as fs3 from "node:fs";
import * as path3 from "node:path";
function projectRootFor(startDir, env = process.env) {
  const fromEnv = env.EQUE2_PROJECT_ROOT?.trim();
  if (fromEnv && fs3.existsSync(fromEnv) && fs3.statSync(fromEnv).isDirectory()) return path3.resolve(fromEnv);
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: startDir, encoding: "utf-8" });
  if (probe.status === 0) {
    const top = probe.stdout.trim();
    if (top && fs3.existsSync(top)) return top;
  }
  let dir = path3.resolve(startDir);
  for (; ; ) {
    if (fs3.existsSync(path3.join(dir, ".git"))) return dir;
    const parent = path3.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path3.resolve(startDir);
}

// src/eque2-code/scripts/integrity.ts
var KEY_RE = /^[0-9a-fA-F]{64}$/;
var KEY_ID_RE = /^[A-Za-z0-9._-]+$/;
var KeyringMalformedError = class extends Error {
  constructor(filePath, defect) {
    super(
      `Committed keyring ${filePath} is malformed (${defect}) \u2014 fix or regenerate the file; expected {"activeKeyId":"<id>","keys":{"<keyId>":"<64 hex chars>"}}`
    );
    this.name = "KeyringMalformedError";
  }
};
function keyringFilePath(projectRoot) {
  return path4.join(projectRoot, "state", "integrity-key.json");
}
function readKeyringFile(filePath) {
  if (!fs4.existsSync(filePath)) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(fs4.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, ""));
  } catch {
    throw new KeyringMalformedError(filePath, "unparseable JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KeyringMalformedError(filePath, "not a JSON object");
  }
  const obj = parsed;
  if (typeof obj.activeKeyId !== "string" || !obj.activeKeyId.trim()) {
    throw new KeyringMalformedError(filePath, "activeKeyId missing or empty");
  }
  if (!obj.keys || typeof obj.keys !== "object" || Array.isArray(obj.keys)) {
    throw new KeyringMalformedError(filePath, "keys map missing");
  }
  const keys = {};
  for (const [id, val] of Object.entries(obj.keys)) {
    if (!KEY_ID_RE.test(id)) {
      throw new KeyringMalformedError(filePath, `keyId "${id}" contains forbidden characters (allowed: letters, digits, . _ -)`);
    }
    if (typeof val !== "string" || !KEY_RE.test(val)) {
      throw new KeyringMalformedError(filePath, `keys["${id}"] is not 64 hex characters`);
    }
    keys[id] = val.toLowerCase();
  }
  if (Object.keys(keys).length === 0) throw new KeyringMalformedError(filePath, "keys map is empty");
  if (!Object.hasOwn(keys, obj.activeKeyId)) {
    throw new KeyringMalformedError(filePath, `activeKeyId "${obj.activeKeyId}" is absent from keys`);
  }
  return { activeKeyId: obj.activeKeyId, keys };
}
function isTestContext(env) {
  return Boolean(env.VITEST?.trim() || env.NODE_ENV === "test");
}
function resolveEnvKeyring(env) {
  const wantId = env.INTEGRITY_KEY_ID?.trim();
  const raw = env.INTEGRITY_KEYS?.trim();
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('INTEGRITY_KEYS is not valid JSON \u2014 expected {"<keyId>":"<64 hex chars>"}');
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("INTEGRITY_KEYS must be a JSON object of keyId \u2192 64-hex-char key");
    }
    const keys = {};
    for (const [id, val] of Object.entries(parsed)) {
      if (typeof val !== "string" || !KEY_RE.test(val)) {
        throw new Error(`INTEGRITY_KEYS["${id}"] must be 64 hex characters (32 bytes)`);
      }
      keys[id] = val.toLowerCase();
    }
    const ids = Object.keys(keys);
    if (ids.length === 0) throw new Error("INTEGRITY_KEYS is empty \u2014 no keys to sign or verify with");
    const activeKeyId = wantId && Object.hasOwn(keys, wantId) ? wantId : highestKeyId(ids);
    return { activeKeyId, keys };
  }
  const single = firstValid(env.INTEGRITY_KEY) ?? (isTestContext(env) ? firstValid(env.STATE_DB_KEY) : void 0);
  if (single) {
    const keyId = wantId || "1";
    if (!KEY_ID_RE.test(keyId)) {
      throw new Error(`INTEGRITY_KEY_ID "${keyId}" contains forbidden characters (allowed: letters, digits, . _ -)`);
    }
    return { activeKeyId: keyId, keys: { [keyId]: single } };
  }
  return void 0;
}
function keyFor(keys, id) {
  return Object.hasOwn(keys, id) ? keys[id] : void 0;
}
function resolveKeyring(env = process.env, startDir = process.cwd()) {
  const filePath = keyringFilePath(projectRootFor(startDir, env));
  const envRing = resolveEnvKeyring(env);
  let fileRing;
  try {
    fileRing = readKeyringFile(filePath);
  } catch (err) {
    if (!envRing || !(err instanceof KeyringMalformedError)) throw err;
    console.error(`[integrity] WARNING: ${err.message} \u2014 proceeding on the INTEGRITY_KEY* env override alone`);
  }
  if (envRing) {
    let active = envRing.activeKeyId;
    let envKeys = envRing.keys;
    if (fileRing) {
      const envActiveVal = keyFor(envRing.keys, active);
      const matching = envActiveVal ? Object.entries(fileRing.keys).find(([, v]) => v === envActiveVal) : void 0;
      if (matching && !Object.hasOwn(fileRing.keys, active)) {
        active = matching[0];
        envKeys = { [active]: matching[1] };
      }
    }
    const merged = { ...fileRing?.keys ?? {}, ...envKeys };
    const fileActiveVal = fileRing ? keyFor(fileRing.keys, active) : void 0;
    if (fileRing && fileActiveVal !== void 0 && fileActiveVal !== keyFor(merged, active)) {
      console.error(
        `[integrity] WARNING: the env override SHADOWS committed keyId "${active}" with a DIFFERENT key value \u2014 history signed under the committed key will misreport as tampering; unset the override or set INTEGRITY_KEY_ID correctly (${filePath})`
      );
    } else if (fileRing && active !== fileRing.activeKeyId) {
      console.error(
        `[integrity] WARNING: signing with the env-override keyId "${active}", which diverges from the committed keyring's activeKeyId "${fileRing.activeKeyId}" (${filePath})`
      );
    } else {
      console.error(
        `[integrity] notice: signing with the INTEGRITY_KEY* env override` + (fileRing ? ` (committed keyring ${filePath} still verifies)` : " (no committed keyring file present)")
      );
    }
    return {
      activeKeyId: active,
      keys: merged,
      source: "env-override",
      ...fileRing ? { filePath, fileActiveKeyId: fileRing.activeKeyId } : {}
    };
  }
  if (fileRing) {
    return { ...fileRing, source: "committed-file", filePath, fileActiveKeyId: fileRing.activeKeyId };
  }
  throw new Error(
    `No integrity key found. Expected the committed keyring at ${filePath} \u2014 \`git pull\` to fetch the maintainer's keyring commit, run \`state.mjs key init\` in a brand-new repo, or \`state.mjs key migrate\` to move a legacy key into the file. (An explicit INTEGRITY_KEY env var also works as a CI override.)`
  );
}
function firstValid(v) {
  const t = v?.trim();
  if (!t) return void 0;
  if (!KEY_RE.test(t)) {
    throw new Error(`Integrity key must be 64 hex characters (32 bytes); got length ${t.length}`);
  }
  return t.toLowerCase();
}
function highestKeyId(ids) {
  const allNumeric = ids.every((id) => /^\d+$/.test(id));
  const sorted = allNumeric ? [...ids].sort((a, b) => Number(a) - Number(b)) : [...ids].sort();
  return sorted[sorted.length - 1];
}
function computeTag(record, keyHex) {
  return crypto2.createHmac("sha256", Buffer.from(keyHex, "hex")).update(canonicalJson(record), "utf-8").digest("hex");
}
function verify2(record, integrity, keyring2) {
  if (!integrity || typeof integrity.keyId !== "string" || typeof integrity.tag !== "string") {
    return { valid: false, reason: "malformed" };
  }
  const key = keyFor(keyring2.keys, integrity.keyId);
  if (!key) return { valid: false, reason: "unknown-keyid" };
  const expected = computeTag(record, key);
  if (!timingSafeStrEqual(expected, integrity.tag)) {
    return { valid: false, reason: "tag-mismatch" };
  }
  return { valid: true, reason: "ok" };
}
function timingSafeStrEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto2.timingSafeEqual(ab, bb);
}
function verifyRecord(record, keyring2) {
  const keyId = record.keyId;
  const tag = record.tag;
  if (typeof keyId !== "string" || typeof tag !== "string") {
    return { valid: false, reason: "malformed" };
  }
  return verify2(stripTag(record), { keyId, tag }, keyring2);
}
function stripTag(record) {
  const { keyId: _k, tag: _t, ...rest } = record;
  return rest;
}
function describeFailure(reason, keyId) {
  switch (reason) {
    case "unknown-keyid":
      return `record signed under keyId=${keyId ?? "?"} which is not in the resolved keyring \u2014 most likely a rotation gap: \`git pull\` to fetch the latest state/integrity-key.json (or check its activeKeyId), or \`state.mjs key migrate\` if this machine still holds a legacy key. If the keyring IS current, treat the record as suspect and check its git diff`;
    case "tag-mismatch":
      return `integrity tag mismatch (keyId=${keyId ?? "?"}) \u2014 record was hand-edited or signed under a different key`;
    case "malformed":
      return "record is missing its keyId/tag integrity fields \u2014 not a signed record";
    case "keyring-malformed":
      return 'the committed keyring state/integrity-key.json is malformed \u2014 a file defect, not tampering: fix the JSON (expected {"activeKeyId":"<id>","keys":{...}}) or restore it with `git checkout` / `state.mjs key init`';
    case "legacy-unverifiable":
      return "legacy artifact predates the committed keyring and its era key is absent on this machine \u2014 legacy-unverifiable, not tampering: read it where the legacy key exists, or regenerate the artifact under the committed keyring";
    case "ok":
      return "ok";
  }
}

// src/eque2-code/scripts/fsstore.ts
import * as crypto3 from "node:crypto";
import * as fs5 from "node:fs";
import * as path5 from "node:path";
function resolveRoot(dbPathVar, defaultName, env = process.env) {
  if (env.STATE_DIR && env.STATE_DIR.trim()) return path5.resolve(env.STATE_DIR.trim());
  const raw = env[dbPathVar]?.trim();
  if (raw && raw !== ":memory:") {
    return raw.replace(/\.(db|sqlite3?)$/i, "") || path5.join(path5.dirname(raw), defaultName);
  }
  return void 0;
}
function safeScope(scope) {
  const flat = scope.replace(/[^A-Za-z0-9._-]/g, "_");
  const h = crypto3.createHash("sha256").update(scope).digest("hex").slice(0, 8);
  return `${flat}.${h}`;
}
function specStoreDir(specFolder, env = process.env) {
  const override = resolveRoot("STATE_DB_PATH", "state", env);
  return override !== void 0 ? path5.join(override, safeScope(specFolder)) : path5.join(specFolder, "state");
}
function openStoreAt(dir, keyring2) {
  fs5.mkdirSync(path5.join(dir, "snapshots"), { recursive: true });
  ensureGitattributes2(dir);
  return { dir, keyring: keyring2 };
}
function eventLog(store) {
  return path5.join(store.dir, "events.jsonl");
}
function headPath(store) {
  return path5.join(store.dir, "HEAD.json");
}
function ensureGitattributes2(dir) {
  const p = path5.join(dir, ".gitattributes");
  const line = "events.jsonl merge=union\n";
  if (fs5.existsSync(p)) {
    if (fs5.readFileSync(p, "utf-8").includes("merge=union")) return;
    fs5.appendFileSync(p, line);
    return;
  }
  fs5.writeFileSync(p, line);
}
var cachedKeyrings = /* @__PURE__ */ new Map();
function keyring(env = process.env, startDir = process.cwd()) {
  const root = projectRootFor(startDir, env);
  let ring = cachedKeyrings.get(root);
  if (!ring) {
    ring = resolveKeyring(env, root);
    cachedKeyrings.set(root, ring);
  }
  return ring;
}
var RollbackError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RollbackError";
  }
};
function readRawLines(store) {
  const p = eventLog(store);
  if (!fs5.existsSync(p)) return [];
  const out = [];
  for (const line of fs5.readFileSync(p, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.tag === "string") {
      out.push({ parsed, tagHex: parsed.tag });
    }
  }
  return out;
}
function computeLogHash(lines) {
  const bodies = lines.map((l) => canonicalJson(l.parsed)).sort();
  return crypto3.createHash("sha256").update(bodies.join("\n")).digest("hex");
}
function readHead(store) {
  const p = headPath(store);
  if (!fs5.existsSync(p)) return void 0;
  try {
    const h = JSON.parse(fs5.readFileSync(p, "utf-8"));
    if (typeof h.version === "number" && typeof h.logHash === "string") return h;
  } catch {
  }
  return void 0;
}
function checkHead(store, lines) {
  const head = readHead(store);
  if (!head) return;
  const headOk = verifyRecord({ version: head.version, logHash: head.logHash, ts: head.ts, keyId: head.keyId, tag: head.tag }, store.keyring);
  if (!headOk.valid) {
    throw new RollbackError(`HEAD.json integrity failed (${describeFailure(headOk.reason, head.keyId)}) in ${store.dir}`);
  }
  if (lines.length < head.version) {
    throw new RollbackError(
      `state rollback detected in ${store.dir}: log has ${lines.length} events but HEAD recorded ${head.version} \u2014 lines were truncated`
    );
  }
  if (lines.length === head.version && computeLogHash(lines) !== head.logHash) {
    throw new RollbackError(
      `state tampering detected in ${store.dir}: log hash does not match HEAD (a record was edited in place)`
    );
  }
}
function readEvents2(store) {
  const lines = readRawLines(store);
  checkHead(store, lines);
  return verifyLines(store, lines);
}
function verifyLines(store, lines) {
  const events = [];
  for (const { parsed } of lines) {
    const outcome = verifyRecord(parsed, store.keyring);
    if (!outcome.valid) {
      console.error(
        `[integrity] dropping unverifiable event kind=${String(parsed.kind)} id=${String(parsed.id)}: ${describeFailure(outcome.reason, typeof parsed.keyId === "string" ? parsed.keyId : void 0)}`
      );
      continue;
    }
    events.push(parsed);
  }
  return events;
}
function lwwKey(kind, id) {
  return `${kind}\0${id}`;
}
function materialise2(events) {
  const winners = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.op === "append") continue;
    const k = lwwKey(e.kind, e.id);
    const cur = winners.get(k);
    if (cur === void 0 || compareEvent(e.hlc, e.actor, cur.hlc, cur.actor) > 0) {
      winners.set(k, e);
    }
  }
  return winners;
}
function getOne(store, kind, id) {
  const w = materialise2(readEvents2(store)).get(lwwKey(kind, id));
  if (!w || w.op === "delete") return void 0;
  return w.payload;
}
function listKind(store, kind) {
  const out = /* @__PURE__ */ new Map();
  for (const [, w] of materialise2(readEvents2(store))) {
    if (w.kind === kind && w.op !== "delete") out.set(w.id, w.payload);
  }
  return out;
}

// src/packages/schemas/src/schemas/constants.ts
var SCHEMA_VERSION = "1";
var SCHEMA_VERSION_V2 = "2";
var SCHEMA_VERSION_V3 = "3";
var SCHEMA_URI_PREFIX = "schemas";
var makeSchemaUri = (type, version = SCHEMA_VERSION) => `${SCHEMA_URI_PREFIX}/${type}@${version}`;
var VERIFICATION_SCHEMA_URI = makeSchemaUri("verification", SCHEMA_VERSION);
var CHECKPOINT_SCHEMA_URI = makeSchemaUri("checkpoint", SCHEMA_VERSION);
var TOUCHPOINT_REQUEST_SCHEMA_URI = makeSchemaUri("touchpoint-request", SCHEMA_VERSION);
var TOUCHPOINT_DECISION_SCHEMA_URI = makeSchemaUri("touchpoint-decision", SCHEMA_VERSION);
var TASK_STATE_SCHEMA_URI = makeSchemaUri("task-state", SCHEMA_VERSION);
var SCENARIO_STATE_SCHEMA_URI = makeSchemaUri("scenario-state", SCHEMA_VERSION);
var TASK_SNAPSHOT_SCHEMA_URI = makeSchemaUri("task-snapshot", SCHEMA_VERSION);
var SCENARIO_SNAPSHOT_SCHEMA_URI = makeSchemaUri("scenario-snapshot", SCHEMA_VERSION);
var BUILD_CHECK_SNAPSHOT_SCHEMA_URI = makeSchemaUri("build-check-snapshot", SCHEMA_VERSION);
var STATE_METADATA_SCHEMA_URI = makeSchemaUri("state-metadata", SCHEMA_VERSION);
var REMEDIATION_TOUCHPOINT_SCHEMA_URI = makeSchemaUri("remediation-touchpoint", SCHEMA_VERSION);
var PARENT_TASK_SNAPSHOT_SCHEMA_URI = makeSchemaUri("parent-task-snapshot", SCHEMA_VERSION);
var ACTOR_DEFINITIONS_SCHEMA_URI = makeSchemaUri("actor-definitions", SCHEMA_VERSION);
var SCENARIO_ID_SOURCE = "[A-Z]+-?\\d+(?:-[A-Z]+)*(?:\\.\\d+)?[a-z]?";
var TEST_LIFECYCLE_SNAPSHOT_SCHEMA_URI = makeSchemaUri("test-lifecycle-snapshot", SCHEMA_VERSION);
var TEST_LIFECYCLE_CONTEXT_V1_SCHEMA_URI = makeSchemaUri("test-lifecycle-context", SCHEMA_VERSION);
var TEST_LIFECYCLE_CONTEXT_V2_SCHEMA_URI = makeSchemaUri("test-lifecycle-context", SCHEMA_VERSION_V2);
var TEST_LIFECYCLE_STATE_V1_SCHEMA_URI = makeSchemaUri("test-lifecycle-state", SCHEMA_VERSION);
var TEST_LIFECYCLE_STATE_V2_SCHEMA_URI = makeSchemaUri("test-lifecycle-state", SCHEMA_VERSION_V2);
var TEST_LIFECYCLE_CONTEXT_V3_SCHEMA_URI = makeSchemaUri("test-lifecycle-context", SCHEMA_VERSION_V3);
var TEST_LIFECYCLE_STATE_V3_SCHEMA_URI = makeSchemaUri("test-lifecycle-state", SCHEMA_VERSION_V3);
var TEST_LIFECYCLE_SNAPSHOT_V2_SCHEMA_URI = makeSchemaUri("test-lifecycle-snapshot", SCHEMA_VERSION_V2);

// src/eque2-code/scripts/reporters/scenario-state-reporter.ts
var SCENARIO_FILE_PATTERN = new RegExp(`^verify-[A-Za-z0-9_.-]+-(${SCENARIO_ID_SOURCE})\\.spec\\.ts$`);
var SCENARIO_TAG_PATTERN = new RegExp(`\\[(${SCENARIO_ID_SOURCE})\\]`, "g");
function computeEvidenceHmac(evidence, key) {
  const record = {};
  for (const [k, v] of Object.entries(evidence)) {
    if (k !== "_hmac") record[k] = v;
  }
  const sortedRecord = {};
  for (const k of Object.keys(record).sort()) sortedRecord[k] = record[k];
  const canonical = JSON.stringify(sortedRecord);
  return crypto4.createHmac("sha256", key).update(canonical).digest("hex");
}
function signEvidence(specFolder, evidence) {
  const ring = resolveKeyring(process.env, specFolder);
  evidence._keyId = ring.activeKeyId;
  evidence._hmac = computeEvidenceHmac(evidence, ring.keys[ring.activeKeyId]);
}
function computeSourceHash(testFilePath) {
  const content = fs6.readFileSync(testFilePath, "utf-8");
  return crypto4.createHash("sha256").update(content).digest("hex").slice(0, 16);
}
function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs6.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  fs6.renameSync(tmpPath, filePath);
}
function resolveFilepath(file) {
  const f = file;
  if (typeof f.filepath === "string") return f.filepath;
  if (typeof f.moduleId === "string") return f.moduleId;
  return void 0;
}
function resolveTasks(file) {
  const f = file;
  const top = Array.isArray(f.tasks) ? f.tasks : f.task && Array.isArray(f.task.tasks) ? f.task.tasks : [];
  const out = [];
  const walk = (tasks, prefix) => {
    let anyLeafFailed = false;
    for (const task of tasks) {
      const name = prefix ? `${prefix} > ${task.name}` : task.name;
      if (Array.isArray(task.tasks)) {
        const childFailed = walk(task.tasks, name);
        if (task.result?.state === "fail" && !childFailed) {
          out.push({ name, result: { state: "fail", duration: task.result.duration ?? 0 } });
          anyLeafFailed = true;
        }
        anyLeafFailed ||= childFailed;
        continue;
      }
      out.push({ name, ...task.result ? { result: task.result } : {} });
      if (task.result?.state === "fail") anyLeafFailed = true;
    }
    return anyLeafFailed;
  };
  const anyFailed = walk(top, "");
  const fileResult = f.result ?? f.task?.result;
  if (fileResult?.state === "fail" && !anyFailed) {
    const filepath = resolveFilepath(file);
    out.push({
      name: `${filepath ? path6.basename(filepath) : "<file>"} (file-level failure)`,
      result: { state: "fail", duration: fileResult.duration ?? 0 }
    });
  }
  return out;
}
function readRegistrations(specFolder) {
  const dir = specStoreDir(specFolder);
  if (!fs6.existsSync(path6.join(dir, "events.jsonl"))) return void 0;
  try {
    const store = openStoreAt(dir, keyring(process.env, specFolder));
    const files = /* @__PURE__ */ new Map();
    for (const [id, payload] of listKind(store, "scenario")) {
      const testFile = payload?.context?.testFile;
      if (typeof testFile === "string" && testFile !== "") files.set(id, testFile);
    }
    const meta = getOne(store, "metadata", "_");
    const testDir = typeof meta?.test_dir === "string" && meta.test_dir !== "" ? meta.test_dir : void 0;
    return { files, projectRoot: projectRootFor(specFolder), ...testDir ? { testDir } : {} };
  } catch (e) {
    console.error(
      `[scenario-state-reporter] WARNING: the state store at ${dir} exists but could not be read (${e.message}). Scenario registrations are unknown, so evidence from a file a scenario was repointed away from is NOT filtered in this run.`
    );
    return void 0;
  }
}
function canonicalPath(p) {
  try {
    return fs6.realpathSync(p);
  } catch {
    return path6.resolve(p);
  }
}
function isRegisteredFile(filepath, registered, reg) {
  let target = registered;
  if (target.includes("{TEST_DIR}")) {
    if (!reg.testDir) {
      const rest = path6.normalize(target.replace(/^.*\{TEST_DIR\}[\\/]?/, ""));
      return canonicalPath(filepath).endsWith(path6.sep + rest);
    }
    target = target.replace("{TEST_DIR}", reg.testDir.replace(/\/+$/, ""));
  }
  const abs = path6.isAbsolute(target) ? target : path6.resolve(reg.projectRoot, target);
  return canonicalPath(abs) === canonicalPath(filepath);
}
var ScenarioStateReporter = class {
  specFolder;
  warnedMissingSpecFolder = false;
  playwrightTasks = /* @__PURE__ */ new Map();
  constructor(options) {
    this.specFolder = options?.specFolder ?? process.env.SPEC_FOLDER;
  }
  onInit() {
    this.resolveSpecFolder();
  }
  resolveSpecFolder() {
    this.specFolder ??= process.env.SPEC_FOLDER;
    if (!this.specFolder && !this.warnedMissingSpecFolder) {
      this.warnedMissingSpecFolder = true;
      console.error(
        "[scenario-state-reporter] SPEC_FOLDER env var not set. Scenario state reporting is disabled for this run; set it or pass { specFolder } as a reporter option."
      );
    }
    return this.specFolder !== void 0;
  }
  // vitest 2/3 hook. Implemented for backward compatibility.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  onFinished(files) {
    this.processFiles(files);
  }
  // vitest 4 hook. v4 stopped calling `onFinished`; without this method
  // evidence files were never written.
  onTestRunEnd(files) {
    this.processFiles(files);
  }
  /** Playwright reporter hook: retain only the final result for retried tests. */
  onTestEnd(test, result) {
    if (!this.resolveSpecFolder()) return;
    const filepath = test.location?.file;
    if (!filepath) return;
    const retry = result.retry ?? 0;
    const existing = this.playwrightTasks.get(test);
    if (existing && (existing.task.result?.retry ?? 0) > retry) return;
    const expectedFailure = test.expectedStatus === "failed";
    const skipped = result.status === "skipped" || test.expectedStatus === "skipped";
    const state = skipped ? "skip" : expectedFailure ? result.status === "failed" ? "pass" : "fail" : result.status === "passed" ? "pass" : "fail";
    const titlePath = test.titlePath?.();
    this.playwrightTasks.set(test, {
      filepath,
      task: {
        name: titlePath && titlePath.length > 0 ? titlePath.join(" > ") : test.title,
        result: { state, duration: result.duration ?? 0, retry }
      }
    });
  }
  /** Playwright reporter hook: turn accumulated callbacks into the shared writer shape. */
  onEnd(_result) {
    if (!this.resolveSpecFolder()) return;
    const files = /* @__PURE__ */ new Map();
    for (const { filepath, task } of this.playwrightTasks.values()) {
      const tasks = files.get(filepath) ?? [];
      tasks.push(task);
      files.set(filepath, tasks);
    }
    this.processFiles([...files.entries()].map(([filepath, tasks]) => ({ filepath, tasks })));
  }
  /** Playwright collection errors identify a file but have no TestCase callback. */
  onError(error) {
    const filepath = error.location?.file;
    if (!filepath) return;
    this.playwrightTasks.set(/* @__PURE__ */ Symbol("playwright-collection-error"), {
      filepath,
      task: {
        name: `Playwright collection error: ${error.message ?? "unknown error"}`,
        result: { state: "fail", duration: 0 }
      }
    });
  }
  processFiles(files) {
    if (!this.resolveSpecFolder() || !files) return;
    resolveKeyring(process.env, this.specFolder);
    const failures = [];
    const registered = readRegistrations(this.specFolder);
    for (const file of files) {
      const filepath = resolveFilepath(file);
      if (!filepath) continue;
      const basename2 = path6.basename(filepath);
      const match = basename2.match(SCENARIO_FILE_PATTERN);
      if (!match) {
        if (basename2.startsWith("verify-")) {
          console.error(
            `[scenario-state-reporter] WARNING: ${basename2} starts with 'verify-' but its trailing id does not match the scenario id grammar (${SCENARIO_ID_SOURCE}) \u2014 NO evidence written for it. Name it verify-{FEATURE}-{ID}.spec.ts with a non-empty feature slug.`
          );
        }
        continue;
      }
      const scenarioId = match[1];
      console.error(`[scenario-state-reporter] Processing scenario ${scenarioId} from ${basename2}`);
      const allTasks = resolveTasks(file).filter((t) => t.result && t.result.state !== "skip");
      const tagged = /* @__PURE__ */ new Map();
      for (const task of allTasks) {
        for (const tagMatch of task.name.matchAll(SCENARIO_TAG_PATTERN)) {
          const id = tagMatch[1];
          if (id === scenarioId) continue;
          const bucket = tagged.get(id) ?? [];
          bucket.push(task);
          tagged.set(id, bucket);
        }
      }
      const registeredElsewhere = (id) => {
        const registeredFile = registered?.files.get(id);
        if (registered === void 0 || registeredFile === void 0 || isRegisteredFile(filepath, registeredFile, registered)) return false;
        console.error(
          `[scenario-state-reporter] WARNING: ${basename2} carries scenario ${id}, but ${id} is registered to '${registeredFile}' \u2014 NO ${id} evidence written from this file.`
        );
        return true;
      };
      if (!registeredElsewhere(scenarioId)) {
        try {
          this.writeScenarioEvidence(scenarioId, filepath, allTasks);
        } catch (e) {
          failures.push(`${scenarioId}: ${e.message}`);
        }
      }
      for (const [taggedId, tasks] of tagged) {
        if (registeredElsewhere(taggedId)) continue;
        console.error(`[scenario-state-reporter] Consolidated tag [${taggedId}] found in ${basename2} \u2014 emitting per-scenario evidence`);
        try {
          this.writeScenarioEvidence(taggedId, filepath, tasks);
        } catch (e) {
          failures.push(`${taggedId}: ${e.message}`);
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`[scenario-state-reporter] evidence write failed for ${failures.length} scenario(s): ${failures.join("; ")}`);
    }
  }
  writeScenarioEvidence(scenarioId, filepath, tasks) {
    if (!this.specFolder) return;
    const testResults = [];
    let totalDuration = 0;
    let hasFailure = false;
    for (const task of tasks) {
      const result = task.result;
      if (!result) continue;
      const status = result.state === "pass" ? "passed" : "failed";
      if (result.state !== "pass") hasFailure = true;
      const duration = result.duration ?? 0;
      totalDuration += duration;
      testResults.push({
        name: task.name,
        status,
        duration,
        ...result.retry !== void 0 ? { retryCount: result.retry } : {}
      });
    }
    const noTestsCollected = testResults.length === 0;
    const exitCode = hasFailure || noTestsCollected ? 1 : 0;
    const evidenceDir = path6.join(this.specFolder, "evidence");
    fs6.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path6.join(evidenceDir, `${scenarioId}.json`);
    const evidence = {
      scenarioId,
      testFile: filepath,
      exitCode,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      durationMs: totalDuration,
      testResults,
      _sourceHash: computeSourceHash(filepath),
      ...noTestsCollected ? { reason: "no tests collected" } : {}
    };
    signEvidence(this.specFolder, evidence);
    atomicWriteJson(evidencePath, evidence);
    console.error(`[scenario-state-reporter] Wrote evidence to ${evidencePath}`);
    const signer = loadSignerKey(this.specFolder);
    if (signer) {
      try {
        const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: this.specFolder, encoding: "utf-8" }).trim();
        const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.specFolder, encoding: "utf-8" }).trim();
        mintVerdict(this.specFolder, {
          testId: scenarioId,
          testFileAbsPath: filepath,
          commitSha,
          result: exitCode === 0 ? "passing" : "failing",
          testFilePath: path6.relative(repoRoot, filepath)
        }, signer);
        console.error(`[scenario-state-reporter] Minted signed verdict for ${scenarioId} (${exitCode === 0 ? "passing" : "failing"})`);
      } catch (e) {
        console.error(`[scenario-state-reporter] Could not mint verdict for ${scenarioId}: ${e.message}`);
      }
    }
    console.error(`[scenario-state-reporter] Scenario ${scenarioId} exit=${exitCode}. Run \`node state.mjs <specFolder> verify ${scenarioId}\` to consume this evidence.`);
  }
};
export {
  SCENARIO_FILE_PATTERN,
  SCENARIO_TAG_PATTERN,
  ScenarioStateReporter as default,
  signEvidence
};
