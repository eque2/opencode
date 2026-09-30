#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Unit tests for detect-quality-gate.py. Run: python3 test_detect_quality_gate.py (or pytest)."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "dqg", Path(__file__).resolve().parent.parent / "detect-quality-gate.py"
)
dqg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dqg)


def test_classify_specificity():
    # "format" and "typecheck" must win over the looser "lint"/"test" tokens
    assert dqg.classify("ruff format --check .") == "format"
    assert dqg.classify("ruff check .") == "lint"
    assert dqg.classify("mypy src") == "typecheck"
    assert dqg.classify("npm run test:unit") == "test"
    assert dqg.classify("build docs") is None


def test_scan_pyproject_tools():
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "pyproject.toml").write_text(
            "[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n"
        )
        cands = dqg.scan(Path(d))
        cmds = {k: [e["command"] for e in v] for k, v in cands.items()}
        assert "ruff check ." in cmds["lint"]
        assert "mypy ." in cmds["typecheck"]
        assert "pytest" in cmds["test"]
        assert "ruff format --check ." in cmds["format"]


def test_scan_empty_project_is_clean():
    with tempfile.TemporaryDirectory() as d:
        cands = dqg.scan(Path(d))
        assert all(v == [] for v in cands.values())


if __name__ == "__main__":
    test_classify_specificity()
    test_scan_pyproject_tools()
    test_scan_empty_project_is_clean()
    print("all tests passed")
