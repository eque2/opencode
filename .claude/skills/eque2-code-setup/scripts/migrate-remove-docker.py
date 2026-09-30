#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""migrate-remove-docker.py — Remove stale MCP registrations + Docker artefacts
left over from a pre-remove-docker install (eque2-code-state, eque2-tests,
eque2-xray).

Unlike prune-stale-mcp.py (which removes an MCP entry only when its wrapper
path no longer exists on disk — a "moved checkout" cleanup), this script
removes ALL THREE registrations unconditionally: post-remove-docker, none of
them should exist regardless of whether the wrapper is still present.

Order of operations (each step is best-effort / non-fatal unless noted):
  1. `claude mcp remove <name> --scope local` and `--scope user` for all 3
     server names.
  2. BEFORE touching any Docker volume: verify every project spec folder's
     committed events.jsonl still cryptographically verifies (via the state
     engine's own health check, invoked through `node`/`npx tsx`). If ANY
     spec folder fails verification, ABORT before step 3 — do not risk
     deleting a volume that might hold the only copy of unmigrated state.
     This mirrors the v0.42.0 SQLite -> signed-plaintext migration's
     "detect legacy state, refuse to half-migrate" precedent.
  3. Remove the `eque2-state:v*` Docker image(s) and the per-project
     `eque2-state-<hash>` / `eque2-tests-<hash>` named volumes.
  4. Sweep stale SOPS-era key artifacts (`state/.integrity-key.sops.json`,
     root `.integrity-key.sops.json`, and a `.sops.yaml` that references
     integrity-key) — ONLY when the committed keyring
     `state/integrity-key.json` exists AND is git-tracked, i.e. migration to
     the committed-key model has demonstrably completed. Otherwise the blob
     is the only (encrypted) copy of the legacy key and is left alone.
     Deletions are working-tree only; the operator commits them.

Deliberately NEVER touches either OS keychain entry (`eque2-code-state` or
`eque2-code-integrity` service) — no keychain read/write/delete call exists
anywhere in this file. That is the whole point: the integrity key and signer
keys must survive this migration untouched.

Usage:
  migrate-remove-docker.py --project-root <path> [--specs-root <path>] [--dry-run]

Output (stdout JSON):
  {"mcpRemoved": [...], "verified": [...], "verificationFailed": [...],
   "dockerRemoved": [...], "legacyKeyArtifactsRemoved": [...], "aborted": bool,
   "warnings": [...]}

Exit codes: 0 = completed (including a no-op on a clean/no-docker machine),
1 = aborted because events.jsonl verification failed for at least one spec
folder (Docker artefacts intentionally left in place).

MIGRATE-LEGACY-READ-SANCTIONED (cleanup-only: step 4 deletes stale SOPS-era
artifacts once the committed keyring is tracked — it never reads, decrypts,
or writes key material).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

SERVER_NAMES = ["eque2-code-state", "eque2-tests", "eque2-xray"]

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Remove stale MCP registrations + Docker artefacts from a pre-remove-docker install."
    )
    parser.add_argument("--project-root", required=True, help="Absolute path to the project root")
    parser.add_argument(
        "--specs-root",
        action="append",
        default=[],
        help="A spec-folder-containing directory to scan for events.jsonl verification "
        "(repeatable). If omitted, no verification is attempted and Docker removal proceeds.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Report only; make no changes")
    parser.add_argument(
        "--claude-bin", default="claude", help="Path to the claude CLI (default: 'claude' on PATH)"
    )
    parser.add_argument(
        "--docker-bin", default="docker", help="Path to the docker CLI (default: 'docker' on PATH)"
    )
    parser.add_argument(
        "--state-cli",
        help="Path to a state.ts/state.mjs CLI to run '<specFolder> health' against for "
        "verification. If omitted, verification is skipped for --specs-root entries.",
    )
    return parser.parse_args()


def _project_hash(project_root: str) -> str:
    import hashlib

    return hashlib.sha256(project_root.encode("utf-8")).hexdigest()[:12]


def remove_mcp_registrations(claude_bin: str, dry_run: bool) -> list[dict]:
    removed: list[dict] = []
    for name in SERVER_NAMES:
        for scope in ("local", "user"):
            entry = {"server": name, "scope": scope}
            if dry_run:
                removed.append(entry)
                continue
            try:
                subprocess.run(
                    [claude_bin, "mcp", "remove", name, "--scope", scope],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                removed.append(entry)
            except (OSError, subprocess.TimeoutExpired):
                # Non-fatal: claude CLI missing, or the entry never existed.
                pass
    return removed


def find_event_logs(specs_root: Path) -> list[Path]:
    """Find every spec folder under specs_root that has a state/ subtree with
    at least one events.jsonl file."""
    if not specs_root.exists():
        return []
    return sorted({p.parent.parent for p in specs_root.rglob("state/*/events.jsonl")} |
                  {p.parent for p in specs_root.rglob("state") if (p / "events.jsonl").exists()})


def verify_spec_folder(state_cli: str, spec_folder: Path) -> bool:
    """Run the state engine's health check against one spec folder. Returns
    True if it reports ok, False otherwise (including any invocation error —
    fail closed, never assume a verify error means "fine")."""
    try:
        result = subprocess.run(
            ["npx", "tsx", state_cli, str(spec_folder), "health"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            return False
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        if payload.get("disabled"):
            # Health explicitly disabled (EQUE2_HEALTHCHECK=0) — treat as
            # "cannot confirm", which is NOT the same as "confirmed ok".
            return False
        return bool(payload.get("ok"))
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, IndexError):
        return False


def remove_docker_artifacts(docker_bin: str, project_hash: str, dry_run: bool) -> list[str]:
    removed: list[str] = []
    if shutil.which(docker_bin) is None:
        return removed  # No docker installed — nothing to remove, not an error.

    volumes = [f"eque2-state-{project_hash}", f"eque2-tests-{project_hash}"]
    for vol in volumes:
        if dry_run:
            removed.append(f"volume:{vol}")
            continue
        result = subprocess.run(
            [docker_bin, "volume", "rm", vol], capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            removed.append(f"volume:{vol}")

    # Remove every eque2-state:v* image tag present on this host.
    try:
        images = subprocess.run(
            [docker_bin, "images", "--format", "{{.Repository}}:{{.Tag}}"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        for line in images.stdout.splitlines():
            if line.startswith("eque2-state:v"):
                if dry_run:
                    removed.append(f"image:{line}")
                    continue
                rm = subprocess.run(
                    [docker_bin, "image", "rm", line], capture_output=True, text=True, timeout=30
                )
                if rm.returncode == 0:
                    removed.append(f"image:{line}")
    except (OSError, subprocess.TimeoutExpired):
        pass

    return removed


def sweep_sops_artifacts(project_root: str, dry_run: bool, warnings: list[str]) -> list[str]:
    """Step 4: remove stale SOPS-era key artifacts, ONLY once the committed
    keyring exists and is git-tracked (the blob is otherwise the sole encrypted
    copy of the legacy key). Working-tree deletion only — the operator commits."""
    root = Path(project_root)
    keyring = root / "state" / "integrity-key.json"
    if not keyring.exists():
        return []
    tracked = subprocess.run(
        ["git", "-C", project_root, "ls-files", "--error-unmatch", "state/integrity-key.json"],
        capture_output=True,
    )
    if tracked.returncode != 0:
        warnings.append(
            "stale SOPS artifacts left in place: state/integrity-key.json exists but is "
            "not git-tracked yet — commit the keyring, then re-run to sweep the blob"
        )
        return []

    removed: list[str] = []
    for rel in ["state/.integrity-key.sops.json", ".integrity-key.sops.json"]:
        p = root / rel
        if p.exists():
            if not dry_run:
                p.unlink()
            removed.append(rel)
    sops_yaml = root / ".sops.yaml"
    if sops_yaml.exists():
        try:
            ours = "integrity-key" in sops_yaml.read_text(encoding="utf-8")
        except OSError:
            ours = False
        if ours:
            if not dry_run:
                sops_yaml.unlink()
            removed.append(".sops.yaml")
        else:
            warnings.append(
                ".sops.yaml present but does not reference integrity-key — left alone "
                "(may govern other secrets in this repo)"
            )
    if removed:
        warnings.append(
            "removed stale SOPS-era key artifacts (superseded by the committed keyring): "
            + ", ".join(removed)
            + " — commit the deletion(s), noting the legacy blob is superseded"
        )
    return removed


def run(args: argparse.Namespace) -> int:
    warnings: list[str] = []
    mcp_removed = remove_mcp_registrations(args.claude_bin, args.dry_run)

    verified: list[str] = []
    verification_failed: list[str] = []
    if args.state_cli:
        for specs_root_str in args.specs_root:
            for spec_folder in find_event_logs(Path(specs_root_str)):
                if verify_spec_folder(args.state_cli, spec_folder):
                    verified.append(str(spec_folder))
                else:
                    verification_failed.append(str(spec_folder))
    elif args.specs_root:
        warnings.append("--specs-root given without --state-cli — verification skipped")

    if verification_failed:
        print(
            json.dumps(
                {
                    "mcpRemoved": mcp_removed,
                    "verified": verified,
                    "verificationFailed": verification_failed,
                    "dockerRemoved": [],
                    "aborted": True,
                    "warnings": warnings
                    + [
                        "ABORTED before Docker removal: events.jsonl verification "
                        "failed for one or more spec folders. No volume or image was "
                        "touched. Investigate the failing folder(s) before re-running."
                    ],
                }
            )
        )
        return 1

    docker_removed = remove_docker_artifacts(
        args.docker_bin, _project_hash(args.project_root), args.dry_run
    )

    sops_removed = sweep_sops_artifacts(args.project_root, args.dry_run, warnings)

    print(
        json.dumps(
            {
                "mcpRemoved": mcp_removed,
                "verified": verified,
                "verificationFailed": [],
                "dockerRemoved": docker_removed,
                "legacyKeyArtifactsRemoved": sops_removed,
                "aborted": False,
                "warnings": warnings,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(run(parse_args()))
