#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
preflight-check.py — Deterministic pre-flight environment checks for Linus.

Replaces the prompt-driven pre-flight described in
`references/pre-flight-checks.md`. Runs the checks listed below mechanically
and emits a JSON envelope on stdout for the agent to fold into its greeting.

Checks:
  1. env_credentials   (warn)           — .env has JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN (optional; enables Jira-sourced workflows)
  2. gh_cli            (warn)           — `gh` on PATH
  3. node              (warn)           — `node --version` succeeds
  4. keyring           (blocker)        — committed plaintext keyring resolves (state/integrity-key.json; greenfield passes)
  5a. code_standards    (auto_bootstrap) — coding-standards glob matches ≥1 file
  5b. review_rules      (auto_bootstrap) — review-rules glob matches ≥1 file
  6. package_manager   (warn)           — lockfile detected; node_modules present
  7. project_docs      (warn)           — project context (bmad-project-context block, or legacy index) present

Exit codes:
  0 — ok (no blockers, no warnings, no auto-bootstrap needed)
  1 — degraded (warnings or auto-bootstrap needed)
  2 — failed (one or more blockers)

Design notes:
  - Each check is pure: read a file, run a subprocess, or stat a path. No
    network. No side effects.
  - `--coding-standards-glob` and `--review-rules-glob` are pass-throughs to
    let the agent forward its `customize.toml` values, so customisation flows
    through to the script.
  - Glob support: shell-style with ** recursion, resolved through
    `Path.glob` after manual substitution of `{project-root}`.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_CODING_STANDARDS_GLOB = "{project-root}/docs/CLAUDE/code-standards/*.md"
DEFAULT_REVIEW_RULES_GLOB = "{project-root}/.github/review-rules/*.md"
# Project-context markers. Current: the `bmad-project-context` managed block in
# the repo's AGENTS.md. Legacy: an `index.md` written by the retired
# bmad-document-project (callers forwarding `{planning_artifacts}/index.md`);
# the default covers repos that documented into `docs/`. Either satisfies the gate.
DEFAULT_PROJECT_DOCS_GLOB = "{project-root}/docs/index.md"
PROJECT_CONTEXT_MARKER = "<!-- bmad:context -->"

REQUIRED_ENV_KEYS = ("JIRA_URL", "JIRA_EMAIL", "JIRA_API_TOKEN")

# Lockfile → manager name. Order matters: bun → pnpm → yarn → npm default.
LOCKFILE_ORDER = (
    ("bun.lockb", "bun"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
)


def _parse_env_file(env_path: Path) -> dict[str, str]:
    """Minimal `.env` parser. KEY=VALUE per line, strips quotes, ignores #-comments."""
    out: dict[str, str] = {}
    if not env_path.exists():
        return out
    for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # Strip surrounding quotes.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            out[key] = value
    return out


# Appended to the detail when Jira credentials are absent, so the user knows
# exactly which capabilities are degraded — and which still work without Jira.
_JIRA_OPTIONAL_NOTE = (
    " — Jira-sourced workflows ([JF] fetch, [ET]/Xray E2E) are unavailable until "
    "JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN are added to .env; prose-file workflows "
    "(e.g. CS @brief.md) work without them"
)


def _malformed_jira(env: dict[str, str]) -> list[str]:
    """Human-readable problems for present-but-malformed Jira values.

    Kept in lock-step with verify-jira-credentials.py's `_malformed` so the
    install check and this runtime pre-flight agree on validation depth, not
    just on key presence.
    """
    problems: list[str] = []
    url = env.get("JIRA_URL", "").strip()
    if url and not (url.startswith("http://") or url.startswith("https://")):
        problems.append("JIRA_URL must start with http:// or https://")
    email = env.get("JIRA_EMAIL", "").strip()
    if email and "@" not in email:
        problems.append("JIRA_EMAIL does not look like an email address")
    return problems


def check_env_credentials(project_root: Path) -> dict:
    # Jira credentials are OPTIONAL: they unlock the Jira-sourced workflows but
    # are not required to install, launch Linus, or spec from a prose file. So a
    # missing/incomplete/malformed credential set is a `warn` (degraded,
    # proceed), never a `blocker`. See spec-jira-optional CAP-2 / CAP-5.
    env_path = project_root / ".env"
    if not env_path.exists():
        return {
            "name": "env_credentials",
            "severity": "warn",
            "passed": False,
            "detail": f"{env_path} not found{_JIRA_OPTIONAL_NOTE}",
        }
    env = _parse_env_file(env_path)
    missing = [k for k in REQUIRED_ENV_KEYS if not env.get(k, "").strip()]
    if missing:
        return {
            "name": "env_credentials",
            "severity": "warn",
            "passed": False,
            "detail": f"missing or empty: {', '.join(missing)}{_JIRA_OPTIONAL_NOTE}",
        }
    problems = _malformed_jira(env)
    if problems:
        return {
            "name": "env_credentials",
            "severity": "warn",
            "passed": False,
            "detail": f"malformed: {'; '.join(problems)}{_JIRA_OPTIONAL_NOTE}",
        }
    return {
        "name": "env_credentials",
        "severity": "warn",
        "passed": True,
        "detail": "JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN all present",
    }


def check_gh_cli() -> dict:
    gh_path = shutil.which("gh")
    if not gh_path:
        return {
            "name": "gh_cli",
            "severity": "warn",
            "passed": False,
            "detail": "gh not found on PATH",
        }
    return {
        "name": "gh_cli",
        "severity": "warn",
        "passed": True,
        "detail": gh_path,
    }


def check_node() -> dict:
    if not shutil.which("node"):
        return {
            "name": "node",
            "severity": "warn",
            "passed": False,
            "detail": "node not found on PATH",
        }
    try:
        proc = subprocess.run(
            ["node", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        return {
            "name": "node",
            "severity": "warn",
            "passed": False,
            "detail": f"node --version failed: {e}",
        }
    if proc.returncode != 0:
        return {
            "name": "node",
            "severity": "warn",
            "passed": False,
            "detail": f"node --version exit {proc.returncode}: {proc.stderr.strip()}",
        }
    return {
        "name": "node",
        "severity": "warn",
        "passed": True,
        "detail": proc.stdout.strip(),
    }


def _candidate_event_logs(project_root: Path) -> list[Path]:
    """GIT-TRACKED `events.jsonl` files — gitignored scratch stores and
    untracked/vendored fixtures must never count as "committed history"
    (E2/E3 review). Falls back to a pruned walk when git is unavailable."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(project_root), "ls-files", "*events.jsonl"],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode == 0:
            return [
                project_root / rel
                for rel in proc.stdout.splitlines()
                if rel and (project_root / rel).exists()
            ]
    except (subprocess.TimeoutExpired, OSError):
        pass
    hits: list[Path] = []
    skip = {".git", "node_modules", ".eque2-tests", ".pnpm-store", "__pycache__",
            "dist", ".venv", "coverage", ".next", "vendor", ".turbo", "target"}
    for dirpath, dirnames, filenames in os.walk(project_root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        if "events.jsonl" in filenames:
            hits.append(Path(dirpath) / "events.jsonl")
    return hits


def _find_signed_history(project_root: Path) -> list[Path]:
    """Tracked `events.jsonl` logs containing at least one SIGNED record
    (keyId+tag). Used to distinguish a broken clone (history exists, keyring
    commit missing) from a greenfield repo."""
    hits: list[Path] = []
    for path in _candidate_event_logs(project_root):
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict) and isinstance(rec.get("tag"), str) and isinstance(rec.get("keyId"), str):
                    hits.append(path)
                    break
        except OSError:
            continue
    return hits


def _git_toplevel(project_root: Path) -> Path:
    """The committed keyring and its signed history live at the GIT top-level,
    never in a subdirectory — matching how state.mjs resolves. Preflight may be
    pointed at a subfolder (a nested install, a monorepo package dir), so the
    keyring check must climb to the repo root regardless of the passed path,
    otherwise it reports a false "keyring absent" from a subfolder while the
    real keyring sits at the top level. Falls back to project_root when git is
    unavailable or the path is outside a work tree (greenfield / non-git)."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(project_root), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return Path(proc.stdout.strip())
    except (subprocess.TimeoutExpired, OSError):
        pass
    return project_root


def check_committed_keyring(project_root: Path) -> dict:
    """Check 4 — the committed plaintext keyring resolves.

    The K2 integrity key lives IN the repo (`state/integrity-key.json`,
    plaintext by design — protected by agent policy, not secrecy), so a fresh
    clone needs NO per-machine provisioning. Three cases:

      present                  → validate shape; pass (malformed → fail, a
                                 file defect, never "tampering")
      absent + signed history  → BLOCKER: broken clone (the keyring commit is
                                 missing) — `git pull`, or `state.mjs key
                                 migrate` on a key-holding machine
      absent + no history      → pass: greenfield; a maintainer runs
                                 `state.mjs key init` once (never a blocker)

    An explicit `INTEGRITY_KEY(S)` env override also satisfies the check
    (the exceptional CI path — overlay semantics).
    """
    env_keys = os.environ.get("INTEGRITY_KEYS", "").strip()
    env_key = os.environ.get("INTEGRITY_KEY", "").strip()
    if env_keys or env_key:
        # Validate the override FORMAT — a garbage value must not pass the
        # blocker check only to crash every CLI call (E2/E3 review).
        valid = False
        if env_keys:
            try:
                parsed = json.loads(env_keys)
                valid = (
                    isinstance(parsed, dict) and parsed
                    and all(isinstance(v, str) and re.fullmatch(r"[0-9a-fA-F]{64}", v) for v in parsed.values())
                )
            except ValueError:
                valid = False
        else:
            valid = re.fullmatch(r"[0-9a-fA-F]{64}", env_key) is not None
        if valid:
            return {
                "name": "keyring",
                "severity": "blocker",
                "passed": True,
                "detail": "INTEGRITY_KEY* env override set (exceptional path — the committed keyring is the default)",
            }
        return {
            "name": "keyring",
            "severity": "blocker",
            "passed": False,
            "detail": "INTEGRITY_KEY* env override is set but INVALID (expected 64-hex key(s)) — unset it or fix the value",
        }
    # The keyring is ALWAYS at the git top level — resolve there, not at the
    # (possibly sub-folder) path preflight was pointed at.
    root = _git_toplevel(project_root)
    keyring_file = root / "state" / "integrity-key.json"
    if keyring_file.exists():
        try:
            data = json.loads(keyring_file.read_text(encoding="utf-8").lstrip("\ufeff"))
            active = data["activeKeyId"]
            keys = data["keys"]
            if not (isinstance(active, str) and isinstance(keys, dict) and active in keys and keys):
                raise ValueError("wrong shape")
            for kid, val in keys.items():
                if not re.fullmatch(r"[A-Za-z0-9._-]+", str(kid)):
                    raise ValueError("bad keyId")
                if not (isinstance(val, str) and re.fullmatch(r"[0-9a-fA-F]{64}", val)):
                    raise ValueError("bad key value")
        except Exception:
            return {
                "name": "keyring",
                "severity": "blocker",
                "passed": False,
                "detail": (
                    f"committed keyring {keyring_file} is malformed — a file defect, not tampering; "
                    "fix the JSON or `git checkout` the file"
                ),
            }
        return {
            "name": "keyring",
            "severity": "blocker",
            "passed": True,
            "detail": f"committed keyring present (activeKeyId {active}, {len(keys)} key(s))",
        }
    history = _find_signed_history(root)
    if history:
        rel = ", ".join(str(h.relative_to(root)) for h in history[:3])
        return {
            "name": "keyring",
            "severity": "blocker",
            "passed": False,
            "detail": (
                f"keyring absent but signed history exists ({rel}) — broken clone: "
                "`git pull` the maintainer's keyring commit, or run `state.mjs key migrate` "
                "on a machine that still holds the legacy key"
            ),
        }
    return {
        "name": "keyring",
        "severity": "blocker",
        "passed": True,
        "detail": (
            "new repo — no keyring and no signed history yet; a maintainer runs "
            "`state.mjs key init` once and commits state/integrity-key.json"
        ),
    }


def _resolve_glob(project_root: Path, glob_pattern: str) -> tuple[Path, str]:
    """Resolve {project-root} substitution and split into base + relative glob.

    Returns (anchor_path, relative_glob). Path.glob is invoked on anchor_path
    with the relative_glob string.
    """
    substituted = glob_pattern.replace("{project-root}", str(project_root))
    # If the pattern is absolute, anchor at root; else anchor at project_root.
    p = Path(substituted)
    if p.is_absolute():
        # Walk down until we hit a part that contains a glob character.
        anchor_parts: list[str] = []
        rest_parts: list[str] = []
        glob_chars = set("*?[")
        hit = False
        for part in p.parts:
            if hit or any(c in part for c in glob_chars):
                hit = True
                rest_parts.append(part)
            else:
                anchor_parts.append(part)
        anchor = Path(*anchor_parts) if anchor_parts else Path("/")
        rel = "/".join(rest_parts) if rest_parts else ""
        return anchor, rel
    return project_root, substituted


def _glob_matches(project_root: Path, pattern: str) -> list[Path]:
    anchor, rel = _resolve_glob(project_root, pattern)
    if not rel:
        # Pattern was a literal path; just test existence.
        return [anchor] if anchor.exists() else []
    try:
        return sorted(anchor.glob(rel))
    except (OSError, ValueError):
        return []


def check_code_standards(project_root: Path, glob_pattern: str) -> dict:
    matches = _glob_matches(project_root, glob_pattern)
    if matches:
        return {
            "name": "code_standards",
            "severity": "auto_bootstrap",
            "passed": True,
            "detail": f"{len(matches)} file(s) matched {glob_pattern}",
        }
    return {
        "name": "code_standards",
        "severity": "auto_bootstrap",
        "passed": False,
        "detail": f"no matches for glob {glob_pattern}",
    }


def check_review_rules(project_root: Path, glob_pattern: str) -> dict:
    matches = _glob_matches(project_root, glob_pattern)
    if matches:
        return {
            "name": "review_rules",
            "severity": "auto_bootstrap",
            "passed": True,
            "detail": f"{len(matches)} file(s) matched {glob_pattern}",
        }
    return {
        "name": "review_rules",
        "severity": "auto_bootstrap",
        "passed": False,
        "detail": f"no matches for glob {glob_pattern}",
    }


def check_package_manager(project_root: Path) -> dict:
    detected_manager: str | None = None
    detected_lockfile: str | None = None
    for lockfile, manager in LOCKFILE_ORDER:
        if (project_root / lockfile).exists():
            detected_manager = manager
            detected_lockfile = lockfile
            break

    # If no lockfile but package.json exists, default to npm.
    pkg_json_present = (project_root / "package.json").exists()
    if detected_manager is None and pkg_json_present:
        detected_manager = "npm (default — no lockfile)"

    node_modules_present = (project_root / "node_modules").is_dir()

    # If there's no package.json at all, this is a non-Node project — pass.
    if not pkg_json_present and detected_manager is None:
        return {
            "name": "package_manager",
            "severity": "warn",
            "passed": True,
            "detail": "no package.json; non-Node project",
        }

    if not node_modules_present:
        return {
            "name": "package_manager",
            "severity": "warn",
            "passed": False,
            "detail": (
                f"{detected_manager}; node_modules/ missing — install before running build-touching workflows"
                + (f" (lockfile: {detected_lockfile})" if detected_lockfile else "")
            ),
        }
    return {
        "name": "package_manager",
        "severity": "warn",
        "passed": True,
        "detail": (
            f"{detected_manager}; node_modules/ present"
            + (f" (lockfile: {detected_lockfile})" if detected_lockfile else "")
        ),
    }


def check_project_docs(project_root: Path, glob_pattern: str) -> dict:
    """Check whether project context exists for the doc-dependent workflows.

    Two markers satisfy it: the `bmad-project-context` managed block in
    AGENTS.md (current), or an `index.md` from the retired
    bmad-document-project (legacy repos). Severity is `warn`, never a blocker:
    a missing map degrades the spec/build workflows but does not stop them. The
    caller decides how loudly to surface it — doc-dependent workflows ([CS],
    [DS], [RS], [BF], [ET]) treat a miss as a strong recommendation to run
    `bmad-project-context`; [JF]/[PR] log it quietly. See
    `references/pre-flight-checks.md`.
    """
    agents_md = project_root / "AGENTS.md"
    try:
        has_block = PROJECT_CONTEXT_MARKER in agents_md.read_text(errors="ignore")
    except OSError:
        has_block = False
    if has_block:
        return {
            "name": "project_docs",
            "severity": "warn",
            "passed": True,
            "detail": "project context present (bmad-project-context block in AGENTS.md)",
        }
    if _glob_matches(project_root, glob_pattern):
        return {
            "name": "project_docs",
            "severity": "warn",
            "passed": True,
            "detail": f"project documentation present ({glob_pattern}, legacy index marker)",
        }
    return {
        "name": "project_docs",
        "severity": "warn",
        "passed": False,
        "detail": (
            "no project context found (no bmad-project-context block in "
            f"AGENTS.md, no {glob_pattern}) — run bmad-project-context before "
            "doc-dependent workflows ([CS], [DS], [RS], [BF], [ET]); "
            "proceeding without it is slower and lower-quality"
        ),
    }


MIN_CLAUDE_CODE_VERSION = (2, 1, 195)  # SubagentStart agent-name matchers


def _parse_version(text: str) -> tuple[int, ...] | None:
    # Prefer the version adjacent to the product name; fall back to the first triple.
    m = re.search(r"(\d+)\.(\d+)\.(\d+)\s*\(Claude Code\)", text) or re.search(r"(\d+)\.(\d+)\.(\d+)", text)
    return tuple(int(g) for g in m.groups()) if m else None


def check_claude_code_version() -> dict:
    """Verifier-only-minting (CAP-8): the SubagentStart/Stop role-marker hooks
    need Claude Code >= 2.1.195 (agent-name matchers). Runtime-conditional:
    on a claude-code install an old version is a NAMED failure; with no
    `claude` binary (Codex / non-Claude runtime) this is an informational
    skip — the sanctioned verification runner
    (scripts/verification-runner.py) mints the role marker instead of hooks,
    and the tests CLI behaves identically."""
    claude = shutil.which("claude")
    if claude is None:
        return {
            "name": "claude_code_version",
            "severity": "warn",
            "passed": True,
            "skipped": True,
            "detail": (
                "no `claude` binary on PATH — SubagentStart/Stop marker hooks do not apply; "
                "verification uses the sanctioned runner fallback "
                "(python3 scripts/verification-runner.py -- <verifier command>), which mints/revokes "
                "the role marker itself. Not a failure."
            ),
        }
    try:
        out = subprocess.run([claude, "--version"], capture_output=True, text=True, timeout=15)
        version = _parse_version((out.stdout or "") + "\n" + (out.stderr or ""))
    except Exception:
        version = None
    if version is None:
        return {
            "name": "claude_code_version",
            "severity": "warn",
            "passed": False,
            "detail": "`claude --version` did not produce a parseable version — cannot confirm >= 2.1.195 (SubagentStart matchers); marker hooks may not fire",
        }
    if version < MIN_CLAUDE_CODE_VERSION:
        return {
            "name": "claude_code_version",
            "severity": "blocker",
            "passed": False,
            "detail": (
                f"Claude Code {'.'.join(map(str, version))} < 2.1.195 — SubagentStart agent-name matchers "
                "(the verifier role-marker hooks, verifier-only-minting) require >= 2.1.195. "
                "Update Claude Code, or use the sanctioned runner fallback for verification."
            ),
        }
    return {
        "name": "claude_code_version",
        "severity": "blocker",
        "passed": True,
        "detail": f"Claude Code {'.'.join(map(str, version))} >= 2.1.195 (SubagentStart matchers available)",
    }


def check_marker_gitignore(project_root: Path) -> dict:
    """Verifier-only-minting: the tests store root is COMMITTED; the role
    marker and denial log inside it must be gitignored — either by the
    store-local .gitignore (hooks self-heal it) or by the repo-root entries
    ensure-gitignore.py installs. Passes when the store does not exist yet."""
    store = project_root / ".eque2-tests" / "state"
    wanted = (".verifier-marker.json", "policy-denials.log")
    if not store.exists():
        return {
            "name": "marker_gitignore",
            "severity": "warn",
            "passed": True,
            "detail": "no .eque2-tests/state yet — the marker hooks write the .gitignore on first mint",
        }

    def _lines(path: Path) -> list[str]:
        try:
            return [l.strip() for l in path.read_text(encoding="utf-8", errors="replace").split("\n")]
        except OSError:
            return []

    store_lines = _lines(store / ".gitignore")
    root_lines = _lines(project_root / ".gitignore")
    missing = [
        w for w in wanted
        if w not in store_lines and f".eque2-tests/state/{w}" not in root_lines
    ]
    if missing:
        return {
            "name": "marker_gitignore",
            "severity": "warn",
            "passed": False,
            "detail": (
                f".eque2-tests/state/.gitignore is missing {', '.join(missing)} — the role marker / "
                "denial log would be committed into the shared tests store; re-run /eque2-code-setup "
                "or add the entries"
            ),
        }
    return {
        "name": "marker_gitignore",
        "severity": "warn",
        "passed": True,
        "detail": "marker + denial log gitignored inside .eque2-tests/state",
    }


def derive_status(checks: list[dict]) -> tuple[str, list[str], list[str], list[str]]:
    """Return (status, blockers, warnings, auto_bootstrap_needed)."""
    blockers = [c["name"] for c in checks if c["severity"] == "blocker" and not c["passed"]]
    warnings = [c["name"] for c in checks if c["severity"] == "warn" and not c["passed"]]
    auto_bootstrap = [
        c["name"] for c in checks if c["severity"] == "auto_bootstrap" and not c["passed"]
    ]
    if blockers:
        return "failed", blockers, warnings, auto_bootstrap
    if warnings or auto_bootstrap:
        return "degraded", blockers, warnings, auto_bootstrap
    return "ok", blockers, warnings, auto_bootstrap


def build_summary_line(checks: list[dict], blockers: list[str],
                       warnings: list[str], auto_bootstrap: list[str]) -> str:
    total = len(checks)
    ok = sum(1 for c in checks if c["passed"])
    parts = [f"Pre-flight: {ok}/{total} OK"]
    if blockers:
        parts.append(f"{len(blockers)} blocker(s) ({', '.join(blockers)})")
    if warnings:
        parts.append(f"{len(warnings)} warning(s) ({', '.join(warnings)})")
    if auto_bootstrap:
        parts.append(f"{len(auto_bootstrap)} auto-bootstrap ({', '.join(auto_bootstrap)})")
    return ", ".join(parts)


def run_all_checks(project_root: Path, coding_glob: str, review_glob: str,
                   docs_glob: str) -> dict:
    checks = [
        check_env_credentials(project_root),
        check_gh_cli(),
        check_node(),
        check_committed_keyring(project_root),
        check_code_standards(project_root, coding_glob),
        check_review_rules(project_root, review_glob),
        check_package_manager(project_root),
        check_project_docs(project_root, docs_glob),
        check_claude_code_version(),
        check_marker_gitignore(project_root),
    ]
    status, blockers, warnings, auto_bootstrap = derive_status(checks)
    summary_line = build_summary_line(checks, blockers, warnings, auto_bootstrap)
    return {
        "status": status,
        "checks": checks,
        "blockers": blockers,
        "warnings": warnings,
        "auto_bootstrap_needed": auto_bootstrap,
        "summary_line": summary_line,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run Linus's pre-flight environment checks. Emits structured JSON "
            "on stdout. Exit code: 0 ok, 1 degraded, 2 failed."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run scripts/preflight-check.py\n"
            "  uv run scripts/preflight-check.py /path/to/project --pretty\n"
            "  uv run scripts/preflight-check.py . \\\n"
            "    --coding-standards-glob '{project-root}/docs/standards/*.md'\n"
        ),
    )
    parser.add_argument(
        "project_root",
        nargs="?",
        default=os.getcwd(),
        help="Project root directory (default: current working directory).",
    )
    parser.add_argument(
        "--coding-standards-glob",
        default=DEFAULT_CODING_STANDARDS_GLOB,
        help=f"Glob for coding-standards files (default: {DEFAULT_CODING_STANDARDS_GLOB}).",
    )
    parser.add_argument(
        "--review-rules-glob",
        default=DEFAULT_REVIEW_RULES_GLOB,
        help=f"Glob for review-rules files (default: {DEFAULT_REVIEW_RULES_GLOB}).",
    )
    parser.add_argument(
        "--project-docs-glob",
        default=DEFAULT_PROJECT_DOCS_GLOB,
        help=(
            "Glob for the LEGACY project-docs index marker, checked only when "
            "AGENTS.md carries no bmad-project-context block. Callers should "
            f"forward '{{planning_artifacts}}/index.md' (default: {DEFAULT_PROJECT_DOCS_GLOB})."
        ),
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    parser.add_argument("--verbose", "-v", action="store_true", help="Diagnostics to stderr.")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()

    if args.verbose:
        print(f"project_root: {project_root}", file=sys.stderr)
        print(f"coding_standards_glob: {args.coding_standards_glob}", file=sys.stderr)
        print(f"review_rules_glob:     {args.review_rules_glob}", file=sys.stderr)
        print(f"project_docs_glob:     {args.project_docs_glob}", file=sys.stderr)

    result = run_all_checks(
        project_root,
        args.coding_standards_glob,
        args.review_rules_glob,
        args.project_docs_glob,
    )

    if args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))

    if args.verbose:
        print(result["summary_line"], file=sys.stderr)

    if result["status"] == "failed":
        return 2
    if result["status"] == "degraded":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
