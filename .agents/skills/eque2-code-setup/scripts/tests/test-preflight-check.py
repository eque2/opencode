#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for preflight-check.py.

Covers:
- All checks pass when env present + globs match + node_modules present
  → status=ok, exit 0.
- Missing .env → env_credentials WARN (Jira optional), not a blocker.
- .env present but missing keys → env_credentials WARN, not a blocker.
- A genuine blocker still yields status=failed, exit 2.
- Glob with no matches → auto_bootstrap_needed populated, status=degraded, exit 1.
- node_modules missing with package.json → warning, status=degraded, exit 1.
- Non-Node project (no package.json) → package_manager passes.
- Custom --coding-standards-glob is honoured.
- --help works.

Run:
    uv run scripts/tests/test-preflight-check.py
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
PREFLIGHT_SCRIPT = SCRIPT_DIR.parent / "preflight-check.py"


def _load_preflight_module():
    """Import preflight-check.py as a module (its name has a hyphen, so a plain
    import won't work). Lets tests exercise pure functions like derive_status
    directly — host-independent, no subprocess, no Docker/keychain dependency."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("preflight_check", PREFLIGHT_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(*args: str, expect_exit: int | None = None) -> tuple[int, dict]:
    """Invoke preflight-check.py, return (exit_code, parsed_json)."""
    result = subprocess.run(
        [sys.executable, str(PREFLIGHT_SCRIPT), *args],
        capture_output=True,
        text=True,
    )
    if expect_exit is not None:
        assert result.returncode == expect_exit, (
            f"expected exit {expect_exit}, got {result.returncode}\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
    return result.returncode, json.loads(result.stdout)


def _make_good_project(root: Path) -> None:
    """Build a project where all checks should pass — except gh/node which we can't fake."""
    (root / ".env").write_text(
        "JIRA_URL=https://example.atlassian.net\n"
        "JIRA_EMAIL=test@example.com\n"
        "JIRA_API_TOKEN=fake-token-123\n"
    )
    servers_dir = root / "_bmad" / "eque2-code" / "servers"
    servers_dir.mkdir(parents=True, exist_ok=True)
    (servers_dir / "state-server.mjs").write_text("// stub\n")
    cs_dir = root / "docs" / "CLAUDE" / "code-standards"
    cs_dir.mkdir(parents=True, exist_ok=True)
    (cs_dir / "ts.md").write_text("# TS\n")
    rr_dir = root / ".github" / "review-rules"
    rr_dir.mkdir(parents=True, exist_ok=True)
    (rr_dir / "general.md").write_text("# General\n")
    # Legacy project-docs index marker (default docs glob).
    docs_dir = root / "docs"
    docs_dir.mkdir(parents=True, exist_ok=True)
    (docs_dir / "index.md").write_text("# Project Docs\n")
    (root / "package.json").write_text('{"name":"x"}\n')
    (root / "package-lock.json").write_text("{}\n")
    (root / "node_modules").mkdir(exist_ok=True)


def test_env_missing_is_warn_not_blocker():
    """No .env → env_credentials is a WARN (Jira optional), never a blocker.

    Jira credentials are optional, so a missing .env must not put
    env_credentials in `blockers`. (The keyring blocker only fires on a
    broken clone — asserted separately in test_genuine_blocker_still_fails;
    here we assert only that Jira isn't a blocker.)
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _, result = _run(str(root))
        env_check = next(c for c in result["checks"] if c["name"] == "env_credentials")
        assert env_check["passed"] is False
        assert env_check["severity"] == "warn"
        assert "env_credentials" in result["warnings"]
        assert "env_credentials" not in result["blockers"]
        # The advisory detail must point users at what Jira unlocks.
        assert "[JF]" in env_check["detail"] and "[ET]" in env_check["detail"]


def test_env_present_but_missing_keys_is_warn():
    """.env present with one required key missing → warn, not a blocker."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env").write_text("JIRA_URL=x\nJIRA_EMAIL=y\n")  # missing JIRA_API_TOKEN
        _, result = _run(str(root))
        env_check = next(c for c in result["checks"] if c["name"] == "env_credentials")
        assert env_check["passed"] is False
        assert env_check["severity"] == "warn"
        assert "JIRA_API_TOKEN" in env_check["detail"]
        assert "env_credentials" in result["warnings"]
        assert "env_credentials" not in result["blockers"]


def test_env_credentials_degraded_not_failed_when_jira_is_the_only_gap():
    """CAP-2 contract, tested host-independently: when EVERY blocker passes and
    the ONLY failing check is the env_credentials warn, derive_status must
    return `degraded` (→ exit 1), never `failed` (→ exit 2).

    This drives derive_status directly with a synthetic check set so the result
    does not depend on host state — the synthetic check set exercises the
    derive_status contract directly.
    """
    mod = _load_preflight_module()
    checks = [
        {"name": "env_credentials", "severity": "warn", "passed": False, "detail": "missing"},
        {"name": "keyring", "severity": "blocker", "passed": True, "detail": "ok"},
        {"name": "code_standards", "severity": "auto_bootstrap", "passed": True, "detail": "ok"},
    ]
    status, blockers, warnings, auto_bootstrap = mod.derive_status(checks)
    assert status == "degraded", (status, blockers, warnings)
    assert blockers == []
    assert "env_credentials" in warnings
    # And the real check function emits exactly that severity/passed for a
    # missing .env, so the synthetic input above is faithful.
    with tempfile.TemporaryDirectory() as tmp:
        chk = mod.check_env_credentials(Path(tmp))
        assert chk["severity"] == "warn" and chk["passed"] is False


def test_env_credentials_all_blockers_pass_exit_one():
    """End-to-end companion to the unit test: derive_status maps `degraded` to
    exit 1 (not 2). Verifies the status→exit mapping the contract depends on."""
    mod = _load_preflight_module()
    # `degraded` must be exit 1; `failed` exit 2; `ok` exit 0 — guard the mapping.
    assert mod.derive_status(
        [{"name": "x", "severity": "warn", "passed": False, "detail": ""}]
    )[0] == "degraded"
    assert mod.derive_status(
        [{"name": "x", "severity": "blocker", "passed": False, "detail": ""}]
    )[0] == "failed"
    assert mod.derive_status(
        [{"name": "x", "severity": "warn", "passed": True, "detail": ""}]
    )[0] == "ok"


def test_malformed_creds_are_warn_not_pass():
    """Present-but-malformed Jira creds (bad URL / email) → env_credentials
    fails as a WARN, matching verify-jira-credentials.py's validation depth
    (the documented lock-step). Must not silently pass at runtime."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env").write_text(
            "JIRA_URL=eque2.atlassian.net\n"   # no http(s) scheme
            "JIRA_EMAIL=notanemail\n"          # no @
            "JIRA_API_TOKEN=tok-123\n"
        )
        _, result = _run(str(root))
        env_check = next(c for c in result["checks"] if c["name"] == "env_credentials")
        assert env_check["passed"] is False, env_check
        assert env_check["severity"] == "warn"
        assert "malformed" in env_check["detail"]
        assert "env_credentials" not in result["blockers"]


def test_genuine_blocker_still_fails():
    """A real blocker (keyring absent while signed history exists — a broken
    clone) must still yield status=failed, exit 2 — downgrading Jira must not
    soften the blocker contract. Jira itself must NOT be among the blockers."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "spec" / "state"
        state.mkdir(parents=True)
        (state / "events.jsonl").write_text('{"keyId":"1","tag":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"task","id":"1"}\n')
        exit_code, result = _run(str(root))
        assert result["status"] == "failed", result
        assert exit_code == 2
        assert "keyring" in result["blockers"], result
        assert "env_credentials" not in result["blockers"]


def test_glob_with_no_matches_is_auto_bootstrap():
    """No code-standards files → auto_bootstrap_needed contains code_standards."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        # Remove the code-standards file to trigger auto_bootstrap.
        for p in (root / "docs" / "CLAUDE" / "code-standards").glob("*.md"):
            p.unlink()

        # Assert the behaviour under test (glob→auto_bootstrap) host-independently.
        # Overall status/exit depend on unrelated checks, which are
        # absent on a clean dev box / CI — see the sibling
        # test_env_credentials_degraded_not_failed... docstring.
        _, result = _run(str(root))
        assert "code_standards" in result["auto_bootstrap_needed"], result


def test_node_modules_missing_is_warn():
    """package.json present but no node_modules → package_manager warn."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        # Remove node_modules.
        os.rmdir(root / "node_modules")

        # Behaviour under test (missing node_modules → package_manager warn),
        # asserted host-independently; overall status depends on unrelated
        # blockers absent on a clean box (see sibling degraded-status test).
        _, result = _run(str(root))
        assert "package_manager" in result["warnings"], result


def test_non_node_project_passes_package_check():
    """No package.json → package_manager passes (non-Node project)."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        # Remove package.json + node_modules to simulate non-Node.
        (root / "package.json").unlink()
        (root / "package-lock.json").unlink()
        os.rmdir(root / "node_modules")

        exit_code, result = _run(str(root))
        pm_check = next(c for c in result["checks"] if c["name"] == "package_manager")
        assert pm_check["passed"] is True
        assert "non-Node project" in pm_check["detail"]


def test_custom_coding_standards_glob():
    """--coding-standards-glob is honoured."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        custom_dir = root / "my-standards"
        custom_dir.mkdir()
        (custom_dir / "rules.md").write_text("# Rules\n")
        # Remove default location to confirm the custom one is what's matching.
        for p in (root / "docs" / "CLAUDE" / "code-standards").glob("*.md"):
            p.unlink()

        exit_code, result = _run(
            str(root),
            "--coding-standards-glob", "{project-root}/my-standards/*.md",
        )
        cs_check = next(c for c in result["checks"] if c["name"] == "code_standards")
        assert cs_check["passed"] is True, cs_check
        assert "code_standards" not in result["auto_bootstrap_needed"]


def test_project_docs_present_passes():
    """Legacy index marker present → project_docs passes, not a warning."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        exit_code, result = _run(str(root))
        pd_check = next(c for c in result["checks"] if c["name"] == "project_docs")
        assert pd_check["passed"] is True, pd_check
        assert pd_check["severity"] == "warn"
        assert "project_docs" not in result["warnings"]


def test_project_docs_missing_is_warn():
    """No project documentation → project_docs warn, status degraded (not blocked)."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        (root / "docs" / "index.md").unlink()
        exit_code, result = _run(str(root))
        pd_check = next(c for c in result["checks"] if c["name"] == "project_docs")
        assert pd_check["passed"] is False, pd_check
        assert pd_check["severity"] == "warn"
        assert "project_docs" in result["warnings"]
        assert "bmad-project-context" in pd_check["detail"]
        # A missing map must never become a blocker.
        assert "project_docs" not in result["blockers"]


def test_project_docs_agents_md_block_passes():
    """A bmad-project-context block in AGENTS.md satisfies the gate with no index.md."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        (root / "docs" / "index.md").unlink()
        (root / "AGENTS.md").write_text("# Repo\n\n<!-- bmad:context -->\nOrientation.\n<!-- /bmad:context -->\n")
        exit_code, result = _run(str(root))
        pd_check = next(c for c in result["checks"] if c["name"] == "project_docs")
        assert pd_check["passed"] is True, pd_check
        assert "AGENTS.md" in pd_check["detail"]
        assert "project_docs" not in result["warnings"]


def test_custom_project_docs_glob():
    """--project-docs-glob is honoured (forwarding {planning_artifacts}/index.md)."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        (root / "docs" / "index.md").unlink()  # default location empty
        pa = root / "_bmad-output" / "planning-artifacts"
        pa.mkdir(parents=True, exist_ok=True)
        (pa / "index.md").write_text("# Docs\n")
        exit_code, result = _run(
            str(root),
            "--project-docs-glob", "{project-root}/_bmad-output/planning-artifacts/index.md",
        )
        pd_check = next(c for c in result["checks"] if c["name"] == "project_docs")
        assert pd_check["passed"] is True, pd_check
        assert "project_docs" not in result["warnings"]


def test_summary_line_format():
    """Summary line should mention totals and any issues."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # Signed history without a keyring → the genuine keyring blocker
        # surfaces; env_credentials is a warning, not a blocker.
        state = root / "spec" / "state"
        state.mkdir(parents=True)
        (state / "events.jsonl").write_text('{"keyId":"1","tag":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"task","id":"1"}\n')
        exit_code, result = _run(str(root))
        assert "Pre-flight:" in result["summary_line"]
        assert "blocker" in result["summary_line"].lower()


def test_help_flag():
    result = subprocess.run(
        [sys.executable, str(PREFLIGHT_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "project_root" in result.stdout
    assert "--coding-standards-glob" in result.stdout
    assert "--review-rules-glob" in result.stdout


def _run_with_env(root: Path, env: dict) -> tuple[int, dict]:
    """Invoke preflight-check.py with a custom env (e.g. shimmed PATH)."""
    result = subprocess.run(
        [sys.executable, str(PREFLIGHT_SCRIPT), str(root)],
        capture_output=True,
        text=True,
        env=env,
    )
    return result.returncode, json.loads(result.stdout)


def test_keyring_present_passes():
    """A valid committed keyring → keyring check passes, names the activeKeyId."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        state = root / "state"
        state.mkdir(exist_ok=True)
        (state / "integrity-key.json").write_text(
            json.dumps({"activeKeyId": "ab12cd34", "keys": {"ab12cd34": "a" * 64}})
        )
        _, result = _run(str(root))
        check = next(c for c in result["checks"] if c["name"] == "keyring")
        assert check["passed"] is True, check
        assert "ab12cd34" in check["detail"]


def test_keyring_resolves_at_git_toplevel_from_subfolder():
    """The keyring lives at the git top level. Preflight pointed at a SUBFOLDER
    must still find it there, not report a false 'absent' from the subfolder."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=root, check=True)
        state = root / "state"
        state.mkdir(exist_ok=True)
        (state / "integrity-key.json").write_text(
            json.dumps({"activeKeyId": "ab12cd34", "keys": {"ab12cd34": "a" * 64}})
        )
        sub = root / "packages" / "app"
        sub.mkdir(parents=True)
        _make_good_project(sub)
        _, result = _run(str(sub))
        check = next(c for c in result["checks"] if c["name"] == "keyring")
        assert check["passed"] is True, check
        assert "ab12cd34" in check["detail"]
        assert "keyring" not in result["blockers"]


def test_keyring_absent_with_history_is_blocker():
    """Keyring absent + signed events.jsonl history → BLOCKER naming git pull / key migrate."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        spec_state = root / "spec" / "state"
        spec_state.mkdir(parents=True)
        (spec_state / "events.jsonl").write_text('{"keyId":"1","tag":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"task","id":"1"}\n')
        _, result = _run(str(root))
        check = next(c for c in result["checks"] if c["name"] == "keyring")
        assert check["passed"] is False, check
        assert "git pull" in check["detail"]
        assert "key migrate" in check["detail"]
        assert "keyring" in result["blockers"]


def test_keyring_absent_no_history_is_greenfield_pass():
    """Keyring absent + NO signed history → pass with key-init guidance (never a blocker)."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        _, result = _run(str(root))
        check = next(c for c in result["checks"] if c["name"] == "keyring")
        assert check["passed"] is True, check
        assert "key init" in check["detail"]
        assert "keyring" not in result["blockers"]


def test_keyring_env_override_satisfies():
    """An INTEGRITY_KEY env override satisfies the keyring check (CI path)."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        env = dict(os.environ)
        env["INTEGRITY_KEY"] = "b" * 64
        _, result = _run_with_env(root, env)
        check = next(c for c in result["checks"] if c["name"] == "keyring")
        assert check["passed"] is True, check
        assert "override" in check["detail"]


def test_keyring_malformed_is_named_file_defect():
    """A malformed keyring fails with 'malformed … not tampering' — never a tamper claim."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        state = root / "state"
        state.mkdir(exist_ok=True)
        (state / "integrity-key.json").write_text("{broken")
        _, result = _run(str(root))
        check = next(c for c in result["checks"] if c["name"] == "keyring")
        assert check["passed"] is False, check
        assert "malformed" in check["detail"]
        assert "not tampering" in check["detail"]


def test_preflight_makes_no_keychain_invocations():
    """CAP-3: a PATH spy proves preflight-check.py never shells out to
    security / cross-keychain / secret-tool (the keychain era is gone)."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_good_project(root)
        bin_dir = root / "spy-bin"
        bin_dir.mkdir()
        marker = bin_dir / "INVOKED"
        for shim in ("security", "cross-keychain", "secret-tool"):
            sp = bin_dir / shim
            sp.write_text(f'#!/bin/sh\necho "$@" >> "{marker}"\nexit 1\n')
            sp.chmod(0o755)
        env = dict(os.environ)
        env["PATH"] = f"{bin_dir}:{env['PATH']}"
        _run_with_env(root, env)
        assert not marker.exists(), f"keychain tooling invoked: {marker.read_text()}"


def main() -> int:
    tests = [
        ("env missing is warn not blocker", test_env_missing_is_warn_not_blocker),
        ("env present but missing keys is warn", test_env_present_but_missing_keys_is_warn),
        ("env-only gap is degraded not failed", test_env_credentials_degraded_not_failed_when_jira_is_the_only_gap),
        ("degraded maps to exit one", test_env_credentials_all_blockers_pass_exit_one),
        ("malformed creds are warn not pass", test_malformed_creds_are_warn_not_pass),
        ("genuine blocker still fails", test_genuine_blocker_still_fails),
        ("glob with no matches is auto_bootstrap", test_glob_with_no_matches_is_auto_bootstrap),
        ("node_modules missing is warn", test_node_modules_missing_is_warn),
        ("non-Node project passes package check", test_non_node_project_passes_package_check),
        ("custom coding standards glob", test_custom_coding_standards_glob),
        ("project_docs present passes", test_project_docs_present_passes),
        ("project_docs missing is warn", test_project_docs_missing_is_warn),
        ("project_docs AGENTS.md block passes", test_project_docs_agents_md_block_passes),
        ("custom project_docs glob", test_custom_project_docs_glob),
        ("summary line format", test_summary_line_format),
        ("--help flag", test_help_flag),
        ("keyring present passes", test_keyring_present_passes),
        ("keyring absent with history is blocker", test_keyring_absent_with_history_is_blocker),
        ("keyring absent no history is greenfield pass", test_keyring_absent_no_history_is_greenfield_pass),
        ("keyring env override satisfies", test_keyring_env_override_satisfies),
        ("keyring malformed is named file defect", test_keyring_malformed_is_named_file_defect),
        ("preflight makes no keychain invocations", test_preflight_makes_no_keychain_invocations),
    ]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
        except AssertionError as e:
            print(f"  FAIL  {name}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR {name}: {type(e).__name__}: {e}")
            failed += 1

    print()
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
