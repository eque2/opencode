#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
First Breath — Deterministic sanctum scaffolding for Grace.

Creates the sanctum folder structure, copies templates with config values
substituted, copies reference files, and auto-generates CAPABILITIES.md from
the workflow manifest. Sanctum location is non-standard for Grace —
`_bmad/_memory/grace-sidecar/` — following the module sidecar convention
(alongside `linus-sidecar`).

If the sanctum already exists, scaffolding is skipped (detect-and-skip pattern)
and the existing sanctum stands.

Usage:
    uv run ./scripts/init-sanctum.py <project-root> <skill-path>
    uv run ./scripts/init-sanctum.py --help
"""

import argparse
import json
import shutil
import sys
from datetime import date
from pathlib import Path

# Skill name retained for tooling compatibility. The sanctum path is NOT
# derived from this — see SANCTUM_RELATIVE_PATH below for the actual location.
SKILL_NAME = "eque2-code-agent-grace"

# Grace's sanctum lives at a non-standard path following the module's sidecar
# convention (alongside linus-sidecar). The builder default would be
# `_bmad/memory/{SKILL_NAME}/`; we override to the sidecar location.
SANCTUM_RELATIVE_PATH = "_bmad/_memory/grace-sidecar"

SKILL_ONLY_FILES = {"first-breath.md"}

# Templates copied verbatim to the sanctum during First Breath.
# CAPABILITIES-info.md (the renamed stub formerly known as CAPABILITIES-template.md)
# is intentionally omitted — CAPABILITIES.md is auto-generated from
# bmad-manifest.json instead, so the table stays in sync with the manifest
# without manual edits. The info file is documentation only; it does not feed
# the sanctum scaffold.
TEMPLATE_FILES = [
    "INDEX-template.md",
    "PERSONA-template.md",
    "CREED-template.md",
    "BOND-template.md",
    "MEMORY-template.md",
    "PULSE-template.md",
]


def parse_yaml_config(config_path: Path) -> dict:
    """Top-level scalar YAML parser, sufficient for _bmad config files."""
    config = {}
    if not config_path.exists():
        return config
    with open(config_path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                key, _, value = line.partition(":")
                value = value.strip().strip("'\"")
                if value:
                    config[key.strip()] = value
    return config


def substitute_vars(content: str, variables: dict) -> str:
    """Replace {var_name} placeholders with values from the variables dict."""
    for key, value in variables.items():
        content = content.replace(f"{{{key}}}", value)
    return content


def copy_references(source_dir: Path, dest_dir: Path) -> list[str]:
    """Copy reference files (except SKILL_ONLY_FILES) into the sanctum."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    copied = []
    for source_file in sorted(source_dir.iterdir()):
        if source_file.name in SKILL_ONLY_FILES:
            continue
        if source_file.is_file():
            shutil.copy2(source_file, dest_dir / source_file.name)
            copied.append(source_file.name)
    return copied


def generate_capabilities_md(manifest_path: Path) -> str:
    """Generate CAPABILITIES.md from manifest.capabilities[]."""
    manifest = json.loads(manifest_path.read_text())
    capabilities = manifest.get("capabilities", [])

    lines = [
        "# Capabilities",
        "",
        "## Built-in",
        "",
        "| Code | Name | Description | Source |",
        "|------|------|-------------|--------|",
    ]
    for cap in capabilities:
        if cap.get("hidden"):
            continue
        code = cap.get("menu-code", "")
        name = cap.get("name", "")
        desc = cap.get("description", "")
        source = cap.get("workflow-path", "")
        lines.append(f"| [{code}] | {name} | {desc} | `{source}` |")

    lines.extend([
        "",
        "## Tools",
        "",
        "Prefer crafting your own tools over depending on external ones.",
        "",
        "### Workflow-Specific Tooling",
        "",
        "- `tests-cli.ts`/`.mjs` — sole writer of test lifecycle state (verbs: update, reset, force-reset, summary, next, query, report, analytics, transitions-since, run-log, verification-reset, verdict). Runtime state lives in signed plaintext (`events.jsonl`, HMAC-verified at read); a fresh verification subagent per submission runs compliance + a live Playwright execution and mints HMAC evidence on pass — agents never self-certify. If the CLI is not present, the tests engine is not installed: say so plainly and never fabricate lifecycle state.",
        "- `xray-cli.ts`/`.mjs` — the ONLY Xray access path (sync, folders, status, diff, test, tests, steps). No bespoke Xray shell/Node scripts, no direct API calls from prompts — ever.",
        "- Playwright MCP — live-UI exploration before any selector is written. Explore the running app first; write the locator second.",
        "",
        "### Shared Pipeline",
        "",
        "- `eque2-code-e2e-test` (stages 2-7) — the canonical test-generation technique, shared with Linus's [ET]. [BT] dispatches it for one Xray test ID; [BK] fans it out across a folder. The Stage 2 Xray gate (stepCount >= 1 or HARD STOP) applies unchanged.",
        "- Test-knowledge cache — subagents write a short .md note per solved problem to `{output_folder}/test-knowledge/` with a `.manifest.jsonl`; [BK] injects the newest entries into subagent prompts on later runs.",
        "",
        "### User-Provided Tools",
        "",
        "_Document MCP servers, APIs, or services here as they are registered._",
        "",
        "- _Xray credentials in `.env` — consumed by the eque2-xray MCP server, never read directly._",
    ])

    return "\n".join(lines) + "\n"


def bootstrap_index(sanctum_path: Path) -> None:
    """Mark a freshly scaffolded sanctum as headless-bootstrapped.

    Flips birth_status to complete and records `bootstrapped: true` so headless
    CI runs can proceed without the interactive First Breath. The sanctum's BOND
    / PERSONA seeds stay at template level — a human should still run First Breath
    later to personalise; `bootstrapped: true` is the breadcrumb that this is owed.
    """
    index_path = sanctum_path / "INDEX.md"
    if not index_path.exists():
        return
    text = index_path.read_text().replace("\r\n", "\n")
    text = text.replace("birth_status: incomplete", "birth_status: complete", 1)
    if "bootstrapped:" not in text and text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[:end] + "\nbootstrapped: true" + text[end:]
    index_path.write_text(text)


def run_scaffold(
    project_root: Path,
    skill_path: Path,
    refresh_capabilities: bool = False,
    bootstrap: bool = False,
) -> dict:
    """Perform the sanctum scaffold. Returns a result dict."""
    bmad_dir = project_root / "_bmad"
    sanctum_path = project_root / SANCTUM_RELATIVE_PATH
    assets_dir = skill_path / "assets"
    references_dir = skill_path / "references"
    manifest_path = skill_path / "bmad-manifest.json"
    sanctum_refs = sanctum_path / "references"

    if sanctum_path.exists():
        # CAPABILITIES.md is a generated cache, not a hand-authored sanctum file.
        # Refresh it in place from the manifest so a long-lived sanctum picks up
        # capability changes — without touching PERSONA/CREED/BOND/MEMORY/PULSE.
        if refresh_capabilities:
            (sanctum_path / "CAPABILITIES.md").write_text(
                generate_capabilities_md(manifest_path)
            )
            return {
                "status": "refreshed",
                "sanctum_path": str(sanctum_path),
                "templates_written": ["CAPABILITIES.md"],
                "references_copied": [],
            }
        return {
            "status": "skipped",
            "reason": "sanctum_already_exists",
            "sanctum_path": str(sanctum_path),
            "templates_written": [],
            "references_copied": [],
        }

    config = {}
    for config_file in ("config.yaml", "config.user.yaml"):
        config.update(parse_yaml_config(bmad_dir / config_file))

    today = date.today().isoformat()
    variables = {
        "user_name": config.get("user_name", "friend"),
        "communication_language": config.get("communication_language", "English"),
        "birth_date": today,
        "project_root": str(project_root),
        "sanctum_path": str(sanctum_path),
    }

    sanctum_path.mkdir(parents=True, exist_ok=True)
    (sanctum_path / "sessions").mkdir(exist_ok=True)

    copied_refs = copy_references(references_dir, sanctum_refs)

    written = []
    for template_name in TEMPLATE_FILES:
        template_path = assets_dir / template_name
        if not template_path.exists():
            continue
        output_name = template_name.replace("-template", "")[:-3].upper() + ".md"
        content = substitute_vars(template_path.read_text(), variables)
        (sanctum_path / output_name).write_text(content)
        written.append(output_name)

    capabilities_content = generate_capabilities_md(manifest_path)
    (sanctum_path / "CAPABILITIES.md").write_text(capabilities_content)
    written.append("CAPABILITIES.md")

    if bootstrap:
        bootstrap_index(sanctum_path)

    return {
        "status": "ok",
        "bootstrapped": bootstrap,
        "sanctum_path": str(sanctum_path),
        "templates_written": written,
        "references_copied": copied_refs,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Scaffold Grace's sanctum at {project-root}/_bmad/_memory/grace-sidecar/. "
            "Detect-and-skip if the sanctum already exists. Outputs structured JSON."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run ./scripts/init-sanctum.py /path/to/project /path/to/skill\n"
            "  uv run ./scripts/init-sanctum.py . . --pretty\n"
        ),
    )
    parser.add_argument(
        "project_root",
        help="Project root directory (contains _bmad/)",
    )
    parser.add_argument(
        "skill_path",
        help="Skill directory (contains SKILL.md, references/, assets/, bmad-manifest.json)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output (human-readable). Default is single-line JSON.",
    )
    parser.add_argument(
        "--refresh-capabilities",
        action="store_true",
        help=(
            "If the sanctum already exists, regenerate ONLY CAPABILITIES.md from "
            "bmad-manifest.json (it is a generated cache) and leave every other "
            "sanctum file untouched. No-op semantics on a fresh scaffold."
        ),
    )
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        help=(
            "Non-interactive CI cold-start: scaffold the sanctum (if absent) and "
            "mark birth_status=complete with bootstrapped=true, so --headless tasks "
            "can run before a human completes First Breath. Seeds stay template-level."
        ),
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Write progress diagnostics to stderr.",
    )
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    skill_path = Path(args.skill_path).resolve()

    if args.verbose:
        print(f"project_root: {project_root}", file=sys.stderr)
        print(f"skill_path:   {skill_path}", file=sys.stderr)

    result = run_scaffold(
        project_root,
        skill_path,
        refresh_capabilities=args.refresh_capabilities,
        bootstrap=args.bootstrap,
    )

    if args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))

    if args.verbose:
        if result["status"] == "ok":
            print(f"Sanctum created at {result['sanctum_path']}", file=sys.stderr)
            print(f"  Templates: {len(result['templates_written'])}", file=sys.stderr)
            print(f"  References: {len(result['references_copied'])}", file=sys.stderr)
        elif result["status"] == "refreshed":
            print(f"Refreshed CAPABILITIES.md at {result['sanctum_path']}", file=sys.stderr)
        elif result["status"] == "skipped":
            print(f"Sanctum already exists at {result['sanctum_path']}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
