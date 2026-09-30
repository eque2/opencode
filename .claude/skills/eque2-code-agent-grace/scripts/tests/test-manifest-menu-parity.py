#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Parity guard: customize.toml [[agent.menu]] must agree with bmad-manifest.json capabilities[].

Grace's capability set is declared in two places:
  * customize.toml `[[agent.menu]]` — the user-facing menu Grace renders.
  * bmad-manifest.json `capabilities[]` — the source init-sanctum.py turns into
    the sanctum's CAPABILITIES.md (Grace's rebirth self-knowledge).

These overlap on `code`, `description`, and `hidden`. If they drift, Grace
advertises one set to the user and believes another — exactly the failure this
QA round fixed for Linus. This test fails the build when the two disagree, so
the dual registry stays single-source-of-truth-by-test.

Run standalone (exit 0 = parity, 1 = drift) or under pytest (the test_* fn).

    uv run ./scripts/tests/test-manifest-menu-parity.py
"""

import json
import sys
import tomllib
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[2]


def load_menu() -> dict[str, dict]:
    cfg = tomllib.loads((SKILL_ROOT / "customize.toml").read_text())
    out = {}
    for item in cfg.get("agent", {}).get("menu", []):
        out[item["code"]] = {
            "description": item.get("description", ""),
            "hidden": bool(item.get("hidden", False)),
        }
    return out


def load_manifest() -> dict[str, dict]:
    data = json.loads((SKILL_ROOT / "bmad-manifest.json").read_text())
    out = {}
    for cap in data.get("capabilities", []):
        out[cap["menu-code"]] = {
            "description": cap.get("description", ""),
            "hidden": bool(cap.get("hidden", False)),
        }
    return out


def diff() -> list[str]:
    menu, manifest = load_menu(), load_manifest()
    problems: list[str] = []

    only_menu = sorted(set(menu) - set(manifest))
    only_manifest = sorted(set(manifest) - set(menu))
    if only_menu:
        problems.append(f"codes in customize.toml menu but not manifest: {only_menu}")
    if only_manifest:
        problems.append(f"codes in manifest but not customize.toml menu: {only_manifest}")

    for code in sorted(set(menu) & set(manifest)):
        if menu[code]["description"] != manifest[code]["description"]:
            problems.append(
                f"[{code}] description drift:\n"
                f"    menu:     {menu[code]['description']!r}\n"
                f"    manifest: {manifest[code]['description']!r}"
            )
        if menu[code]["hidden"] != manifest[code]["hidden"]:
            problems.append(
                f"[{code}] hidden flag drift: menu={menu[code]['hidden']} "
                f"manifest={manifest[code]['hidden']}"
            )
    return problems


def test_manifest_menu_parity() -> None:
    problems = diff()
    assert not problems, "Capability registry drift:\n" + "\n".join(problems)


def main() -> int:
    problems = diff()
    if problems:
        print("DRIFT — customize.toml menu and bmad-manifest.json disagree:\n")
        print("\n".join(problems))
        return 1
    print(json.dumps({"ok": True, "codes": sorted(load_menu())}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
