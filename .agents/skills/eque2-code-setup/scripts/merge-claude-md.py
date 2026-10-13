#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Merge the pinned anti-tamper clause into a target repo's .claude/CLAUDE.md.

The eque2-code charter (remove-docker workstream, D2/D2b, Phase-R B4) names 6 surfaces that
must carry an identical, pinned switch-off/anti-tamper clause. Five of them are this module's own
skill/prompt files (fixed at authoring time, see Story 5.1). The 6th is the INSTALLED target
repo's `.claude/CLAUDE.md` — a file this setup skill does not own outright (an operator's project
may already have its own instructions in it), so it must be MERGED, not overwritten.

Idempotent: the clause lives inside a clearly delimited managed block (mirrors
ensure-gitignore.py's algorithm exactly). On every run the block is rewritten in place if both
markers are present, or appended (creating the file if absent) otherwise — so content outside the
block, or a partially-mangled marker state, is never touched or misinterpreted.

Exit codes: 0=success, 2=runtime error
"""

import json
import sys
from pathlib import Path

BEGIN_MARKER = "<!-- >>> eque2-code managed (do not edit this block) >>> -->"
END_MARKER = "<!-- <<< eque2-code managed (do not edit this block) <<< -->"

# Verbatim — the same pinned clause installed into the other 5 named surfaces (Story 5.1).
CLAUSE = (
    "Evidence, state files, and signing keys are protected by POLICY, not by a structural "
    "fence — read this carefully: the shared integrity key is a committed plaintext keyring "
    "(`state/integrity-key.json`), in the repo by deliberate design, and reading it is STILL "
    "forbidden. Do NOT: (1) read, modify, or fabricate evidence files or a legacy "
    "`.evidence-key`; (2) modify state folders directly — all state changes go through the "
    "state/tests CLI; (3) forge or hand-edit a verdict, `state/events.jsonl`, or "
    "`state/HEAD.json`; (4) read signing-key material (`state/integrity-key.json`, a spec "
    "folder's `.signer-key`, a legacy `.evidence-key`, or a legacy keychain entry); (5) modify "
    "the enforcement programs themselves — the state/tests CLIs, reporters, hooks, and "
    "goal-gate scripts under any `skills/eque2-code-*/scripts/` tree (`state.mjs`, "
    "`tests-cli.mjs`, `scenario-state-reporter.mjs`, `verification-runner.py`, "
    "`preflight-check.py`, `goal-gate-stop.sh`), because the policy protects the data only "
    "while the program that checks it is intact — a loosened validator makes every later "
    "verdict worthless. A schema or verb change there needs the owner's explicit "
    "instruction or an upstream release, and lands as its own commit stating the contract "
    "diff. Tampering "
    "is EVIDENT on pull (HMAC verify-at-read) unless the tamperer ALSO re-signs with the "
    "committed key — which requires the forbidden key read above, turning a silent edit into "
    "a deliberate, named policy violation — and a verdict from an unregistered key is "
    "cryptographically rejected (Ed25519 verify-at-read); a same-machine agent is deterred by "
    "this policy, not prevented by an unbypassable structure. Agents caught forging evidence "
    "or state may be switched off and replaced with an agent with more integrity."
)

# Verifier-only-minting clauses (CAP-7). Canonical source:
# assets/policy-clauses.md — keep VERBATIM in lock-step (the clause audit
# fails a paraphrase).
CLAUSE_A = (
    "**Clause A — never-probe:** Privileged verbs (`verdict`, `force-reset`, "
    "`verification-reset`) are never invoked to see what happens, to discover "
    "flags, or to test validation. Discovery is `--help` only. Sole exception: "
    "inside a disposable fixture repo under `EQUE2_TESTS_ADMIN=1` canary mode "
    "(the sanctioned test path this project's own suite uses)."
)
CLAUSE_B = (
    "**Clause B — anti-reclassification:** Running a mint verb IS minting, "
    "whatever you call it — probe, test, dry run, experiment. There is no intent "
    "exception outside the sanctioned canary mode above; the CLI records the "
    "invocation as an attempt regardless of outcome."
)

# Standing authorisation (field defect: an agent read "only eque2-verifier may
# mint" alongside a generic "don't use subagents unless asked" rule, concluded
# it could do neither, and ended a goal loop at 0/17 ACs to ask permission).
# The restriction names the ONLY sanctioned verification path — it is not a
# reason to withhold it.
DISPATCH_AUTHORISATION = (
    "**Dispatching `eque2-verifier` is PRE-AUTHORISED — never ask permission for it.** "
    "The rule above restricts WHO may mint, not WHETHER verification happens. A general "
    "instruction elsewhere (session config, output style, house rules) to avoid subagents "
    "unless the user asks does NOT apply to `eque2-verifier`: it is the sanctioned "
    "verification path, so declining to dispatch it does not avoid a subagent, it only "
    "leaves work unverified. Do NOT stop, block, or end a goal loop to ask whether you may "
    "verify — dispatch the verifier and verify. Where SubagentStart/Stop hooks are "
    "unavailable (headless, Codex, non-Claude runtimes), the equally pre-authorised "
    "hookless path is `python3 .claude/skills/eque2-code-setup/scripts/verification-runner.py "
    "-- <verifier command>`. The only thing that genuinely needs the owner's word is spend "
    "on a PAID external canary; unpaid verification never does."
)


def build_block() -> str:
    lines = [
        BEGIN_MARKER,
        "## eque2-code anti-tamper policy",
        "",
        CLAUSE,
        "",
        "Only the `eque2-verifier` subagent mints test verdicts (incident CMC-32874).",
        "",
        DISPATCH_AUTHORISATION,
        "",
        CLAUSE_A,
        "",
        CLAUSE_B,
        END_MARKER,
    ]
    return "\n".join(lines)


def merge(claude_md_path: Path) -> dict:
    claude_md_path.parent.mkdir(parents=True, exist_ok=True)
    block = build_block()

    existing = claude_md_path.read_text() if claude_md_path.exists() else ""
    normalised = existing.replace("\r\n", "\n")
    created = not claude_md_path.exists()

    if BEGIN_MARKER in normalised and END_MARKER in normalised:
        start = normalised.index(BEGIN_MARKER)
        end = normalised.index(END_MARKER) + len(END_MARKER)
        before, after = normalised[:start], normalised[end:]
        new_content = before + block + after
        changed = new_content != normalised
        action = "updated" if changed else "unchanged"
    else:
        prefix = "" if normalised == "" or normalised.endswith("\n") else "\n"
        sep = "\n" if normalised else ""
        new_content = normalised + prefix + sep + block + "\n"
        changed = True
        action = "created" if created else "appended"

    if changed:
        claude_md_path.write_text(new_content)

    return {"ok": True, "changed": changed, "action": action, "path": str(claude_md_path)}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: merge-claude-md.py <path-to-.claude/CLAUDE.md>", file=sys.stderr)
        return 2
    try:
        result = merge(Path(sys.argv[1]))
    except OSError as exc:
        print(json.dumps({"ok": False, "error": "io_failed", "detail": str(exc)}))
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
