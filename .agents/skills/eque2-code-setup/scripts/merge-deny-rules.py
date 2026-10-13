#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Merge eque2-code's secret deny rules into a target repo's .claude/settings.json.

Denies every common read/extraction path for the secrets a coding agent could
use to forge evidence or a verdict: `.signer-key` (Ed25519 private key),
`.evidence-key` (legacy per-spec HMAC key — no longer created), `evidence/*.json` (per-scenario
evidence an agent must not hand-edit), direct keychain reads of the shared
`eque2-code-integrity` key (bypasses the CLI's own env-var-first resolution),
direct edits to `state/events.jsonl`/`state/HEAD.json` (only the CLI may
append/regenerate these), and edits to the enforcement programs themselves
(state/tests CLIs, reporters, hooks, goal-gate scripts) — the data rules hold
only while the code that checks the data is intact.

Honest limit (Phase-R SF12, remove-docker workstream D2): these are
policy-primary deny rules, not a structural fence. A determined agent with
shell access can always find an unenumerated path to the same secret (e.g. a
one-off keyring library call the Bash-pattern rules below don't match). They
raise the bar; they do not eliminate it.

Idempotent: existing deny entries are preserved, only missing rules are
appended. Safe to re-run on every `/eque2-code-setup`.

Exit codes: 0=success, 2=runtime error
"""

import json
import sys
from pathlib import Path

EXTRACT_TOOLS = (
    "cat", "head", "tail", "less", "more", "xxd", "grep", "od",
    "python3", "python", "node", "perl", "ruby", "base64", "strings", "hexdump", "file",
)


def build_rules() -> list[str]:
    rules = [
        # The committed plaintext keyring (K2) — committed BY DESIGN, protected
        # by policy: agents must not READ the key material (verify/sign happens
        # inside the CLIs, which never print it).
        "Read(state/integrity-key.json)", "Read(**/state/integrity-key.json)",
        *(f"Bash({tool} *integrity-key.json*)" for tool in EXTRACT_TOOLS),
        "Read(.signer-key)", "Read(**/.signer-key)",
        *(f"Bash({tool}:.signer-key*)" for tool in EXTRACT_TOOLS),
        "Read(.evidence-key)", "Read(**/.evidence-key)",
        *(f"Bash({tool}:.evidence-key*)" for tool in EXTRACT_TOOLS),
        # Edit(...) covers ALL file-editing tools (Write included); a bare
        # Write(...) rule is NOT matched by file permission checks, so it was a
        # silent no-op — do not add them back.
        "Edit(evidence/*.json)",
        "Edit(**/evidence/*.json)",
        "Bash(cross-keychain:get*eque2-code-integrity*)",
        "Bash(security:find-generic-password*eque2-code-integrity*)",
        "Bash(secret-tool:lookup*eque2-code-integrity*)",
        # Legacy keychain reads (retired storage; entries may linger on dev machines).
        "Bash(cross-keychain:get*eque2-code-signer*)",
        "Bash(security:find-generic-password*eque2-code-signer*)",
        "Bash(secret-tool:lookup*eque2-code-signer*)",
        "Edit(**/state/events.jsonl)",
        "Edit(**/state/HEAD.json)",
        # The enforcement PROGRAMS, not just the data they guard. A loosened
        # validator makes every later verdict worthless, and the earlier rules
        # protect the files only while the code that checks them is intact
        # (incident: problems/state-cli-schema-change-2026-08-18.md). These are
        # module-delivered artefacts — the sanctioned change path is an upstream
        # release re-installed over them, never a hand edit. Installers copy via
        # shell, which Edit(...) rules do not gate, so re-install still works.
        *(
            f"Edit({tree}skills/eque2-code-setup/scripts/{ext})"
            for tree in ("**/", ".claude/", ".agents/")
            for ext in ("*.mjs", "*.py")
        ),
        *(
            f"Edit({tree}skills/eque2-code-goal-gate/*.sh)"
            for tree in ("**/", ".claude/", ".agents/")
        ),
        # The gate itself lives in a machine-global runtime tree, outside any repo.
        "Edit(**/goal-gate/gate/goal-gate-stop.sh)",
        "Edit(**/goal-gate-runtime/gate/goal-gate-stop.sh)",
    ]
    return rules


def merge(settings_path: Path) -> dict:
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        cfg = json.loads(settings_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        cfg = {}

    deny = cfg.setdefault("permissions", {}).setdefault("deny", [])
    # Purge the invalid `cmd:*integrity-key.json*` forms shipped by earlier
    # versions — Claude Code rejects mid-pattern `:*` and skips the rule.
    retired = {f"Bash({tool}:*integrity-key.json*)" for tool in EXTRACT_TOOLS}
    # Purge the dead Write(...) file rules earlier versions appended: file
    # permission checks only match Edit(...) (which covers Write), so these
    # never fired. The Edit(...) equivalents in build_rules() do the job.
    retired |= {
        "Write(evidence/*.json)", "Write(**/evidence/*.json)",
        "Write(**/state/events.jsonl)", "Write(**/state/HEAD.json)",
    }
    removed = len([r for r in deny if r in retired])
    deny[:] = [r for r in deny if r not in retired]
    added = 0
    for rule in build_rules():
        if rule not in deny:
            deny.append(rule)
            added += 1

    settings_path.write_text(json.dumps(cfg, indent=2) + "\n")
    return {"path": str(settings_path), "rules_added": added, "rules_removed": removed, "total_deny_rules": len(deny)}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: merge-deny-rules.py <path-to-.claude/settings.json>", file=sys.stderr)
        return 2
    result = merge(Path(sys.argv[1]))
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
