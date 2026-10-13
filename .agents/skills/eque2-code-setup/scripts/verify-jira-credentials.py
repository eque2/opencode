#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
verify-jira-credentials.py — Advisory Jira credential check for install.

Jira credentials are OPTIONAL. They unlock the Jira-sourced workflows ([JF] Jira
Fetch, and [ET]/Xray E2E generation, which authenticate to Jira with a direct
REST call using JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN from the project's
`.env`). They are NOT required to install eque2-code, launch Linus, or spec from
a plain prose/prompt file — `CS @brief.md` runs end-to-end without ever touching
Jira. So this script never blocks an install: it reports, it does not gate.

This script is the deterministic check the setup skill runs to tell the user
whether Jira-sourced workflows will be available. It is intentionally non-LLM
and non-network so it gives a consistent answer offline: it checks that the
three credentials are present, non-empty, and minimally well-formed in `.env`,
and prints guidance when they are not — then exits 0 either way so setup
proceeds.

For the Atlassian MCP: it is still NOT a substitute for real credentials when a
Jira-sourced workflow does run — [JF]'s own rules forbid falling back to it. The
difference is that missing credentials no longer stop the install; they only
defer the Jira-sourced workflows until the user adds them.

Jira-sourced (need credentials):
  JIRA_URL        — must be an http(s) URL
  JIRA_EMAIL      — must contain "@"
  JIRA_API_TOKEN  — any non-empty value

Exit codes:
  0 — always (advisory). Prints a ✅ when present/well-formed, otherwise prints
      guidance and the list of what's missing, but still exits 0 so setup runs.

The key list and `.env` parsing are kept identical to
scripts/preflight-check.py (REQUIRED_ENV_KEYS / _parse_env_file) so the install
check and Linus's runtime pre-flight never disagree.
"""

import argparse
import os
import sys
from pathlib import Path

# Keep in lock-step with preflight-check.py REQUIRED_ENV_KEYS.
REQUIRED_ENV_KEYS = ("JIRA_URL", "JIRA_EMAIL", "JIRA_API_TOKEN")


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
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            out[key] = value
    return out


def _malformed(env: dict[str, str]) -> list[str]:
    """Return human-readable problems for present-but-malformed values."""
    problems: list[str] = []
    url = env.get("JIRA_URL", "").strip()
    if url and not (url.startswith("http://") or url.startswith("https://")):
        problems.append(f"JIRA_URL must start with http:// or https:// (got: {url!r})")
    email = env.get("JIRA_EMAIL", "").strip()
    if email and "@" not in email:
        problems.append(f"JIRA_EMAIL does not look like an email address (got: {email!r})")
    return problems


REMEDIATION = """\
Jira credentials are optional — setup will continue without them. They unlock
the Jira-sourced workflows ([JF] Jira Fetch, [ET]/Xray E2E). Prose-file
workflows (e.g. CS @brief.md) work without them.

To enable Jira-sourced workflows, add these to {env_path} (create the file if it
does not exist) and re-run /eque2-code-setup:

  JIRA_URL=https://eque2.atlassian.net
  JIRA_EMAIL=your.email@company.com
  JIRA_API_TOKEN=your_token_here

Generate an API token at:
  https://id.atlassian.com/manage-profile/security/api-tokens

Note: when a Jira-sourced workflow does run, the Atlassian MCP is NOT a
substitute — those workflows authenticate with these credentials directly."""


def verify(project_root: Path) -> tuple[bool, str]:
    env_path = project_root / ".env"
    if not env_path.exists():
        return False, f"{env_path} not found.\n\n" + REMEDIATION.format(env_path=env_path)

    env = _parse_env_file(env_path)
    missing = [k for k in REQUIRED_ENV_KEYS if not env.get(k, "").strip()]
    problems = _malformed(env)

    if missing or problems:
        lines = []
        if missing:
            lines.append(f"Missing or empty: {', '.join(missing)}")
        lines.extend(problems)
        detail = "\n".join(lines)
        return False, detail + "\n\n" + REMEDIATION.format(env_path=env_path)

    return True, "JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN present and well-formed."


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Advisory Jira credential check for /eque2-code-setup. Always exits 0; "
        "reports whether Jira-sourced workflows will be available.",
    )
    parser.add_argument(
        "project_root",
        nargs="?",
        default=os.getcwd(),
        help="Project root directory (default: current working directory).",
    )
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    ok, message = verify(project_root)

    if ok:
        print(f"✅ Jira credentials present — Jira-sourced workflows available. {message}")
        return 0

    # Advisory only: Jira is optional, so we never block the install. Surface the
    # guidance and exit 0 so setup proceeds — prose-file workflows work regardless.
    print("ℹ️  Jira credentials not configured — Jira-sourced workflows ([JF], [ET]) "
          "will be unavailable until added. Setup will continue.\n")
    print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
