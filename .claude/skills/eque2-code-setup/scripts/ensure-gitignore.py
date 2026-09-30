#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Ensure the target repo's root .gitignore ignores eque2-code's personal/runtime artifacts.

eque2-code writes two classes of file into a target repo:

  * SHARED — committed and shared across all developers. Linus's sanctum
    (`_bmad/_memory/linus-sidecar/` — PERSONA, CREED, BOND, MEMORY, CAPABILITIES,
    INDEX, PULSE, state.md, sessions/), generated docs (`docs/CLAUDE/...`,
    `.github/review-rules/`), and `_bmad/config.yaml`. These are deliberately
    NOT ignored — git tracks them by default.

  * PERSONAL / RUNTIME — must never be committed. Personal settings
    (`_bmad/config.user.yaml`), the state audit log (`.state-events.jsonl`),
    per-spec verdict signing keys (`.signer-key`), and legacy per-spec evidence
    keys (`.evidence-key`). This script ensures those are ignored.

Idempotent: the entries live inside a clearly delimited managed block. On every
run the block is rewritten in place if present, or appended if absent — so a
later version can change the entries without leaving stale lines, and re-running
setup never duplicates anything. Content outside the block is left untouched.

Exit codes: 0=success, 1=validation error, 2=runtime error
"""

import argparse
import json
import sys
from pathlib import Path

BEGIN_MARKER = "# >>> eque2-code managed (do not edit this block) >>>"
END_MARKER = "# <<< eque2-code managed (do not edit this block) <<<"

# Personal/runtime artifacts that must not be committed. Anchored forms (with a
# slash) match only at the repo root; bare names match in any directory, which is
# intended for the per-spec / per-features-tree artifacts.
IGNORE_ENTRIES = [
    "# Personal settings — never shared (user_name, language, user_setting:true keys).",
    "_bmad/config.user.yaml",
    "# State engine runtime audit log — regenerated, not version-controlled.",
    ".state-events.jsonl",
    "# Per-spec verdict signing key — plaintext Ed25519 private key, policy-protected.",
    ".signer-key",
    "# Legacy per-spec evidence key — no longer created; ignored for hygiene on older folders.",
    ".evidence-key",
    "# Verifier role marker — machine-local, minted/revoked by the SubagentStart/Stop hooks.",
    ".eque2-tests/state/.verifier-marker.json",
    "# Mint-verb policy denial log — machine-local observability, never shared state.",
    ".eque2-tests/state/policy-denials.log",
    "# Codex project hook — contains an absolute machine-local executable path.",
    "/.codex/hooks.json",
]

# Shared artifacts are intentionally absent from the ignore list. Documented here
# (as a comment written into the block) so an operator reading their .gitignore
# understands the omission is deliberate.
SHARED_NOTE = [
    "# NOTE: Linus's sanctum (_bmad/_memory/linus-sidecar/), generated docs",
    "# (docs/CLAUDE/, .github/review-rules/) and _bmad/config.yaml are intentionally",
    "# NOT ignored — they are committed and shared across all developers.",
]


def build_block() -> str:
    lines = [BEGIN_MARKER, *SHARED_NOTE, *IGNORE_ENTRIES, END_MARKER]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Ensure eque2-code's personal/runtime artifacts are gitignored."
    )
    parser.add_argument(
        "--gitignore",
        required=True,
        help="Path to the target repo's root .gitignore (created if absent).",
    )
    args = parser.parse_args()

    path = Path(args.gitignore)
    block = build_block()

    try:
        existing = path.read_text() if path.exists() else ""
    except OSError as exc:
        print(json.dumps({"ok": False, "error": "read_failed", "detail": str(exc)}))
        return 2

    # Normalise to LF for matching; we rewrite with LF regardless of the source.
    normalised = existing.replace("\r\n", "\n")
    created = not path.exists()

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
        try:
            path.write_text(new_content)
        except OSError as exc:
            print(json.dumps({"ok": False, "error": "write_failed", "detail": str(exc)}))
            return 2

    print(
        json.dumps(
            {
                "ok": True,
                "changed": changed,
                "action": action,
                "path": str(path),
                "entries": [e for e in IGNORE_ENTRIES if not e.startswith("#")],
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
