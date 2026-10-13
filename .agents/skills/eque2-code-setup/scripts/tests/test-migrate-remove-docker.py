#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for migrate-remove-docker.py — the MCP-registration + Docker-artefact
cleanup migration for a pre-remove-docker install (remove-docker workstream,
Epic 2, Story 2.1, CAP-7).

Covers:
- All 3 server names removed via `claude mcp remove` for both scopes.
- events.jsonl verification failure aborts BEFORE any docker image/volume
  removal (asserted via a fake docker binary that records invocations).
- events.jsonl verification success proceeds to docker removal.
- No docker on PATH -> non-fatal, exits 0, dockerRemoved is empty.
- Structural guard: the script's source contains no keychain-related tokens.

Run:  uv run pytest scripts/tests/test-migrate-remove-docker.py
"""

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
MIGRATE_SCRIPT = SCRIPT_DIR.parent / "migrate-remove-docker.py"


def _write_fake_bin(path: Path, log_path: Path, extra_body: str = "") -> None:
    """Write an executable shell shim that appends its argv to log_path (one
    JSON line per invocation) and exits 0, so tests can assert what a
    subprocess call site actually invoked without touching real Docker/claude."""
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        f"with open({str(log_path)!r}, 'a') as f:\n"
        "    f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        f"{extra_body}\n"
        "sys.exit(0)\n"
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _run(*args):
    r = subprocess.run(
        [sys.executable, str(MIGRATE_SCRIPT), *map(str, args)],
        capture_output=True,
        text=True,
    )
    return r


def _read_log(log_path: Path) -> list[list[str]]:
    if not log_path.exists():
        return []
    return [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()]


def test_removes_all_three_server_registrations(tmp_path):
    claude_log = tmp_path / "claude.log"
    claude_bin = tmp_path / "claude"
    _write_fake_bin(claude_bin, claude_log)
    docker_bin = tmp_path / "docker"
    _write_fake_bin(docker_bin, tmp_path / "docker.log")

    r = _run(
        "--project-root", tmp_path,
        "--claude-bin", claude_bin,
        "--docker-bin", docker_bin,
    )
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)

    servers_removed = {entry["server"] for entry in out["mcpRemoved"]}
    assert servers_removed == {"eque2-code-state", "eque2-tests", "eque2-xray"}
    # Each server removed at both scopes.
    scopes_per_server = {}
    for entry in out["mcpRemoved"]:
        scopes_per_server.setdefault(entry["server"], set()).add(entry["scope"])
    for server, scopes in scopes_per_server.items():
        assert scopes == {"local", "user"}, f"{server} missing a scope: {scopes}"

    invocations = _read_log(claude_log)
    assert len(invocations) == 6  # 3 servers x 2 scopes


def test_verification_failure_aborts_before_docker_removal(tmp_path):
    claude_bin = tmp_path / "claude"
    _write_fake_bin(claude_bin, tmp_path / "claude.log")
    docker_log = tmp_path / "docker.log"
    docker_bin = tmp_path / "docker"
    _write_fake_bin(docker_bin, docker_log)

    # Fake state CLI that always reports a failing health check.
    state_cli = tmp_path / "fake-state.ts"
    state_cli.write_text("")

    specs_root = tmp_path / "features"
    spec_dir = specs_root / "demo"
    state_dir = spec_dir / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "events.jsonl").write_text('{"tag":"deadbeef"}\n')

    # Monkeypatch via PATH: put a fake `npx` ahead of the real one that always
    # returns a failing health payload, regardless of args.
    fake_npx_dir = tmp_path / "fakebin"
    fake_npx_dir.mkdir()
    fake_npx = fake_npx_dir / "npx"
    fake_npx.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "print(json.dumps({'command': 'health', 'ok': False}))\n"
    )
    fake_npx.chmod(fake_npx.stat().st_mode | stat.S_IEXEC)

    env = {**os.environ, "PATH": f"{fake_npx_dir}:{os.environ.get('PATH', '')}"}
    r = subprocess.run(
        [
            sys.executable, str(MIGRATE_SCRIPT),
            "--project-root", str(tmp_path),
            "--claude-bin", str(claude_bin),
            "--docker-bin", str(docker_bin),
            "--state-cli", str(state_cli),
            "--specs-root", str(specs_root),
        ],
        capture_output=True, text=True, env=env,
    )
    assert r.returncode == 1, r.stdout + r.stderr
    out = json.loads(r.stdout)
    assert out["aborted"] is True
    assert out["dockerRemoved"] == []
    assert str(spec_dir) in out["verificationFailed"]
    # Docker binary must never have been invoked.
    assert not docker_log.exists() or _read_log(docker_log) == []


def test_verification_success_proceeds_to_docker_removal(tmp_path):
    claude_bin = tmp_path / "claude"
    _write_fake_bin(claude_bin, tmp_path / "claude.log")
    docker_log = tmp_path / "docker.log"
    docker_bin = tmp_path / "docker"
    # Fake docker: for `images --format ...` print nothing; volume rm / image rm succeed.
    docker_bin.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        f"with open({str(docker_log)!r}, 'a') as f:\n"
        "    f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        "if sys.argv[1:2] == ['images']:\n"
        "    print('')\n"
        "sys.exit(0)\n"
    )
    docker_bin.chmod(docker_bin.stat().st_mode | stat.S_IEXEC)

    state_cli = tmp_path / "fake-state.ts"
    state_cli.write_text("")

    specs_root = tmp_path / "features"
    spec_dir = specs_root / "demo"
    state_dir = spec_dir / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "events.jsonl").write_text('{"tag":"deadbeef"}\n')

    fake_npx_dir = tmp_path / "fakebin"
    fake_npx_dir.mkdir()
    fake_npx = fake_npx_dir / "npx"
    fake_npx.write_text(
        "#!/usr/bin/env python3\n"
        "import json\n"
        "print(json.dumps({'command': 'health', 'ok': True}))\n"
    )
    fake_npx.chmod(fake_npx.stat().st_mode | stat.S_IEXEC)

    env = {**os.environ, "PATH": f"{fake_npx_dir}:{os.environ.get('PATH', '')}"}
    r = subprocess.run(
        [
            sys.executable, str(MIGRATE_SCRIPT),
            "--project-root", str(tmp_path),
            "--claude-bin", str(claude_bin),
            "--docker-bin", str(docker_bin),
            "--state-cli", str(state_cli),
            "--specs-root", str(specs_root),
        ],
        capture_output=True, text=True, env=env,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    out = json.loads(r.stdout)
    assert out["aborted"] is False
    assert str(spec_dir) in out["verified"]
    # Docker binary WAS invoked (volume rm at least).
    invocations = _read_log(docker_log)
    assert any(inv[:2] == ["volume", "rm"] for inv in invocations)


def test_no_docker_on_path_is_non_fatal(tmp_path):
    claude_bin = tmp_path / "claude"
    _write_fake_bin(claude_bin, tmp_path / "claude.log")

    r = _run(
        "--project-root", tmp_path,
        "--claude-bin", claude_bin,
        "--docker-bin", tmp_path / "definitely-not-a-real-docker-binary",
    )
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["dockerRemoved"] == []
    assert out["aborted"] is False


# MIGRATE-LEGACY-READ-SANCTIONED (test fixtures for the cleanup-only sweep —
# fake blobs, no key material).
def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


def _sops_fixture(tmp_path, keyring_tracked: bool):
    """Repo with a stale SOPS blob + eque2 .sops.yaml; keyring optionally tracked."""
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.name", "T")
    _git(tmp_path, "config", "user.email", "t@example.com")
    state = tmp_path / "state"
    state.mkdir()
    (state / ".integrity-key.sops.json").write_text('{"integrityKey":"ENC[notreal]"}')
    (tmp_path / ".sops.yaml").write_text("creation_rules:\n  - path_regex: state/.integrity-key.sops.json\n")
    (state / "integrity-key.json").write_text('{"activeKeyId":"k1","keys":{"k1":"' + "ab" * 32 + '"}}')
    if keyring_tracked:
        _git(tmp_path, "add", "state/integrity-key.json")
        _git(tmp_path, "commit", "-qm", "keyring")
    claude_bin = tmp_path / "claude"
    _write_fake_bin(claude_bin, tmp_path / "claude.log")
    return claude_bin


def test_sops_sweep_removes_blob_when_keyring_tracked(tmp_path):
    claude_bin = _sops_fixture(tmp_path, keyring_tracked=True)
    r = _run("--project-root", tmp_path, "--claude-bin", claude_bin,
             "--docker-bin", tmp_path / "no-docker")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert set(out["legacyKeyArtifactsRemoved"]) == {"state/.integrity-key.sops.json", ".sops.yaml"}
    assert not (tmp_path / "state" / ".integrity-key.sops.json").exists()
    assert not (tmp_path / ".sops.yaml").exists()
    assert (tmp_path / "state" / "integrity-key.json").exists()  # keyring untouched


def test_sops_sweep_refuses_when_keyring_untracked(tmp_path):
    claude_bin = _sops_fixture(tmp_path, keyring_tracked=False)
    r = _run("--project-root", tmp_path, "--claude-bin", claude_bin,
             "--docker-bin", tmp_path / "no-docker")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["legacyKeyArtifactsRemoved"] == []
    assert (tmp_path / "state" / ".integrity-key.sops.json").exists()  # blob preserved
    assert any("not git-tracked" in w for w in out["warnings"])


def test_sops_sweep_leaves_foreign_sops_yaml(tmp_path):
    claude_bin = _sops_fixture(tmp_path, keyring_tracked=True)
    (tmp_path / ".sops.yaml").write_text("creation_rules:\n  - path_regex: secrets/.*\n")
    r = _run("--project-root", tmp_path, "--claude-bin", claude_bin,
             "--docker-bin", tmp_path / "no-docker")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert ".sops.yaml" not in out["legacyKeyArtifactsRemoved"]
    assert (tmp_path / ".sops.yaml").exists()  # not ours — preserved


def test_sops_sweep_dry_run_removes_nothing(tmp_path):
    claude_bin = _sops_fixture(tmp_path, keyring_tracked=True)
    r = _run("--project-root", tmp_path, "--claude-bin", claude_bin,
             "--docker-bin", tmp_path / "no-docker", "--dry-run")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert set(out["legacyKeyArtifactsRemoved"]) == {"state/.integrity-key.sops.json", ".sops.yaml"}
    assert (tmp_path / "state" / ".integrity-key.sops.json").exists()
    assert (tmp_path / ".sops.yaml").exists()


def test_source_contains_no_keychain_tokens():
    text = MIGRATE_SCRIPT.read_text()
    forbidden = ["security find-generic-password", "security add-generic-password", "secret-tool"]
    for token in forbidden:
        assert token not in text, f"migrate-remove-docker.py must never touch the keychain (found: {token!r})"
    # The word "keychain" itself is allowed ONLY inside a comment/docstring
    # paragraph explaining that this script does NOT touch it — assert a
    # negation marker appears within 2 lines of every occurrence (prose wraps
    # across lines, so a strict same-line check is too brittle).
    lines = text.splitlines()
    markers = ("NEVER", "Never", "never", "deliberately", "Deliberately")
    for lineno, line in enumerate(lines):
        if "keychain" in line.lower():
            window = lines[max(0, lineno - 2):lineno + 3]
            assert any(marker in w for w in window for marker in markers), (
                f"line {lineno + 1} mentions keychain without a nearby non-interaction marker: {line!r}"
            )


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-q"]))
