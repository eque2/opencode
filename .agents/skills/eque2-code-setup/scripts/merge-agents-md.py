#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Merge the eque2-code bridge block into a target repo's AGENTS.md (Codex installs).

Codex has no `.claude/rules/` auto-load and must not receive Claude-only files
(`.claude/settings.json`, `.claude/CLAUDE.md`). Its discovery surface is the repo's
`AGENTS.md`. This script merges ONE marked block into that file — explaining the
installed skills, how to invoke the eque2-code workflows and bundled CLIs, and the
pinned anti-tamper policy (the same clause merge-claude-md.py installs on Claude
Code) — without overwriting any existing operator instructions.

Idempotent: the block lives inside a clearly delimited managed block (mirrors
merge-claude-md.py / ensure-gitignore.py exactly). On every run the block is
rewritten in place if both markers are present, or appended (creating the file if
absent) otherwise — content outside the block is never touched.

Exit codes: 0=success, 2=runtime error
"""

import argparse
import json
import sys
from pathlib import Path

BEGIN_MARKER = "<!-- >>> eque2-code managed (do not edit this block) >>> -->"
END_MARKER = "<!-- <<< eque2-code managed (do not edit this block) <<< -->"

# Verbatim — the same pinned clause installed into the other named surfaces (Story 5.1).
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


def build_block(skills_root: str) -> str:
    setup = f"{skills_root}/eque2-code-setup"
    lines = [
        BEGIN_MARKER,
        "## eque2-code (installed module)",
        "",
        f"eque2-code skills are installed under `{skills_root}/`. Each skill is a folder "
        "with a `SKILL.md` — read it and follow it when the user invokes that capability. "
        "Entry points:",
        "",
        f"- `{skills_root}/eque2-code-agent-linus/SKILL.md` — **Linus**, feature-development "
        "orchestrator: Jira ticket or prose brief → spec → build → E2E test → PR. Invoke for "
        "'talk to Linus', 'implement a ticket', 'spec a brief', 'fix a bug', 'open a PR', or "
        "a dispatch code like `JF <TICKET>` / `CS @brief.md`.",
        f"- `{skills_root}/eque2-code-agent-grace/SKILL.md` — **Grace**, test-automation "
        "orchestrator over the Xray-backed test lifecycle (build, backfill, validate, report).",
        f"- `{skills_root}/eque2-code-setup/SKILL.md` — module setup / re-setup.",
        "",
        "State, tests, and Xray operations are plain bundled Node CLIs (no MCP server, no "
        "Docker):",
        "",
        f"- `node {setup}/scripts/state.mjs <verb> …` — signed spec/scenario state",
        f"- `node {setup}/scripts/tests-cli.mjs <verb> …` — test-backfill lifecycle",
        f"- `node {setup}/scripts/xray-cli.mjs <verb> …` — Xray fetch/sync",
        "",
        f"Where a skill file uses the literal token `{{skills-root}}`, resolve it to "
        f"`{skills_root}` in this repo. Where it uses `{{project-root}}`, resolve it to the "
        "repo root.",
        "",
        "### eque2-code anti-tamper policy",
        "",
        CLAUSE,
        "",
        "Only the verifier role mints test verdicts (incident CMC-32874). Hookless "
        f"runtimes dispatch verification through `python3 {setup}/scripts/"
        "verification-runner.py -- <verifier command>`, which mints/revokes the "
        "role marker the tests CLI checks.",
        "",
        CLAUSE_A,
        "",
        CLAUSE_B,
        END_MARKER,
    ]
    return "\n".join(lines)


def merge(agents_md_path: Path, skills_root: str) -> dict:
    agents_md_path.parent.mkdir(parents=True, exist_ok=True)
    block = build_block(skills_root)

    existing = agents_md_path.read_text() if agents_md_path.exists() else ""
    normalised = existing.replace("\r\n", "\n")
    created = not agents_md_path.exists()

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
        agents_md_path.write_text(new_content)

    return {"ok": True, "changed": changed, "action": action, "path": str(agents_md_path)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("agents_md", help="Path to the target repo's AGENTS.md")
    parser.add_argument(
        "--skills-root",
        default=".agents/skills",
        help="Project-relative installed skills root to advertise (default: .agents/skills)",
    )
    args = parser.parse_args()
    try:
        result = merge(Path(args.agents_md), args.skills_root.rstrip("/"))
    except OSError as exc:
        print(json.dumps({"ok": False, "error": "io_failed", "detail": str(exc)}))
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
