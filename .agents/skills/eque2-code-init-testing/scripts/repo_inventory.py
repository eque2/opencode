#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Inventory a repository for a test implementation plan. Stdlib only.

Emits one JSON document describing what the plan author must not guess:
packages (npm, .NET, Python) and their test tooling, per-directory
source/test file and LOC counts, the test layout convention already in use,
the git hook manager and CI pipelines, the agent instruction files, which
BMAD TEA skills the repository carries, and the docs to read before writing.

    python3 repo_inventory.py [--root DIR] [--scope SUBPATH] [-o FILE]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

SOURCE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".cs"}
TEST_NAME = re.compile(r"(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|/)test_[^/]+\.py$|_test\.py$|Tests?\.cs$")
TEST_DIRS = {"test", "tests", "__tests__", "spec", "specs"}
TEST_PROJECT_DIR = re.compile(r"\.\w*Tests?$")  # .NET: MyApp.Tests, MyApp.IntegrationTests
SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "coverage", "out", ".next", ".nx",
    ".claude", ".agents", ".codex", "_bmad", "_bmad-output", ".venv", "venv",
    "__pycache__", ".turbo", ".cache", "storybook-static", "public", "bin", "obj", "TestResults",
}
RUNNERS = ("vitest", "jest", "mocha", "ava", "@playwright/test", "cypress", "pytest")
COVERAGE = ("@vitest/coverage-v8", "@vitest/coverage-istanbul", "c8", "nyc", "istanbul", "pytest-cov")
DOTNET_RUNNERS = ("xunit", "xunit.v3", "NUnit", "MSTest.TestFramework", "MSTest", "Microsoft.NET.Test.Sdk")
DOTNET_COVERAGE = ("coverlet.collector", "coverlet.msbuild", "Microsoft.Testing.Extensions.CodeCoverage")
PACKAGE_REF = re.compile(r'<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?')
CI_FILES = {"github-actions": ".github/workflows/*.y*ml", "azure-pipelines": "azure-pipelines*.y*ml",
            "gitlab-ci": ".gitlab-ci.yml", "jenkins": "Jenkinsfile", "bitbucket": "bitbucket-pipelines.yml",
            "circleci": ".circleci/config.yml"}
NOTABLE = ("typescript", "effect", "react", "vue", "svelte", "angular", "next", "express", "fastify", "hono")
TEA_SKILLS = ("test-design", "framework", "automate", "test-review", "trace", "ci", "atdd", "nfr")
DOC_GLOBS = ("CLAUDE.md", "AGENTS.md", "README.md", "CONTRIBUTING.md", "migration*.md",
             "docs/testing*", "docs/**/test*.md", "TESTING.md")


def sh(cmd: list[str], cwd: Path) -> str:
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=20).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def is_test(rel: str) -> bool:
    parts = rel.split("/")[:-1]
    return bool(TEST_NAME.search(rel)) or any(p in TEST_DIRS or TEST_PROJECT_DIR.search(p) for p in parts)


def read_json(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def package_info(pkg_dir: Path, root: Path) -> dict:
    pj = read_json(pkg_dir / "package.json")
    deps = {**pj.get("dependencies", {}), **pj.get("devDependencies", {})}
    scripts = pj.get("scripts", {})
    configs = sorted(str(p.relative_to(root)) for p in pkg_dir.glob("*.config.*")
                     if re.match(r"(vitest|jest|playwright|cypress|vite)\.config", p.name))
    return {
        "name": pj.get("name") or pkg_dir.name,
        "path": str(pkg_dir.relative_to(root)) or ".",
        "runners": {k: deps[k] for k in RUNNERS if k in deps},
        "coverage": {k: deps[k] for k in COVERAGE if k in deps},
        "notable": {k: deps[k] for k in NOTABLE if k in deps},
        "scripts": {k: v for k, v in scripts.items() if re.search(r"test|cov|typecheck|lint|check", k)},
        "test_configs": configs,
        "tsconfig": (pkg_dir / "tsconfig.json").exists(),
    }


def dotnet_project(csproj: Path, root: Path) -> dict:
    text = csproj.read_text(encoding="utf-8", errors="ignore")
    refs = {name: version for name, version in PACKAGE_REF.findall(text)}
    return {
        "name": csproj.stem,
        "path": str(csproj.relative_to(root)),
        "is_test_project": "Microsoft.NET.Test.Sdk" in refs or "<IsTestProject>true" in text,
        "runners": {k: refs[k] or "central" for k in DOTNET_RUNNERS if k in refs},
        "coverage": {k: refs[k] or "central" for k in DOTNET_COVERAGE if k in refs},
    }


def find_files(root: Path, names: set[str] = frozenset(), suffixes: set[str] = frozenset()) -> list[Path]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        found += [Path(dirpath) / f for f in filenames if f in names or Path(f).suffix in suffixes]
    return sorted(found)


def python_info(root: Path) -> dict:
    files = [f for f in ("pyproject.toml", "setup.cfg", "requirements-dev.txt", "requirements.txt", "tox.ini")
             if (root / f).exists()]
    text = " ".join((root / f).read_text(encoding="utf-8", errors="ignore") for f in files)
    return {"files": files, "tooling": [t for t in ("pytest", "pytest-cov", "coverage", "mypy", "pyright")
                                        if re.search(rf"(?<![\w-]){re.escape(t)}(?![\w-])", text)]}


def hooks(root: Path) -> dict:
    pj = read_json(root / "package.json")
    managers = [name for name, hit in (
        ("husky", (root / ".husky").is_dir()),
        ("lefthook", any((root / f).exists() for f in ("lefthook.yml", ".lefthook.yml", "lefthook.yaml"))),
        ("pre-commit", (root / ".pre-commit-config.yaml").exists()),
        ("simple-git-hooks", "simple-git-hooks" in pj),
        ("githooks-dir", (root / ".githooks").is_dir()),
    ) if hit]
    hooks_path = sh(["git", "config", "--get", "core.hooksPath"], root) or None
    candidates = [root / ".husky" / "pre-push", root / ".githooks" / "pre-push"]
    if hooks_path:
        candidates.append(root / hooks_path / "pre-push")
    return {
        "managers": managers,
        "core_hooks_path": hooks_path,
        "pre_push": next((str(p.relative_to(root)) for p in candidates if p.is_file()), None),
        "prepare_script": pj.get("scripts", {}).get("prepare"),
    }


def ci(root: Path) -> dict:
    return {platform: sorted(str(p.relative_to(root)) for p in root.glob(pattern))
            for platform, pattern in CI_FILES.items() if any(root.glob(pattern))}


def agent_docs(root: Path) -> dict:
    agents = root / "AGENTS.md"
    claude = root / "CLAUDE.md"
    agents_text = agents.read_text(encoding="utf-8", errors="ignore") if agents.exists() else ""
    claude_text = claude.read_text(encoding="utf-8", errors="ignore") if claude.exists() else ""
    return {
        "agents_md": agents.exists(),
        "claude_md": claude.exists(),
        "claude_imports_agents": bool(re.search(r"^@AGENTS\.md\s*$", claude_text, re.M)),
        "bmad_context_block": "<!-- bmad:context -->" in agents_text,
        "testing_block": "<!-- eque2:testing -->" in agents_text,
    }


def walk(root: Path, scope: Path) -> dict:
    """Per-directory counts, keyed at depth <= 3 under the scope."""
    dirs: dict[str, dict] = defaultdict(lambda: {"source_files": 0, "source_loc": 0, "test_files": 0, "test_loc": 0})
    layout = {"in_test_dir": 0, "colocated": 0}
    zero_cov_candidates: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(scope):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            p = Path(dirpath) / fn
            if p.suffix not in SOURCE_EXT or fn.endswith(".d.ts") or fn.endswith(".gen.ts"):
                continue
            rel = str(p.relative_to(root))
            try:
                loc = sum(1 for line in p.open(encoding="utf-8", errors="ignore") if line.strip())
            except OSError:
                continue
            rel_scope = p.relative_to(scope).parts
            key = "/".join(rel_scope[:-1][:3]) or "."
            if is_test(rel):
                dirs[key]["test_files"] += 1
                dirs[key]["test_loc"] += loc
                parent = rel.split("/")[-2] if "/" in rel else ""
                layout["in_test_dir" if parent in TEST_DIRS else "colocated"] += 1
            else:
                dirs[key]["source_files"] += 1
                dirs[key]["source_loc"] += loc
                if loc >= 100:
                    zero_cov_candidates.append({"file": rel, "loc": loc})
    totals = {k: sum(d[k] for d in dirs.values()) for k in ("source_files", "source_loc", "test_files", "test_loc")}
    return {
        "directories": dict(sorted(dirs.items())),
        "totals": totals,
        "layout": layout,
        "large_source_files": sorted(zero_cov_candidates, key=lambda x: -x["loc"])[:40],
    }


def bmad(root: Path) -> dict:
    skill_dirs = [root / ".claude" / "skills", root / ".agents" / "skills"]
    present = [s for s in TEA_SKILLS if any((d / f"bmad-testarch-{s}").is_dir() for d in skill_dirs)]
    tea_cfg = root / "_bmad" / "tea" / "config.yaml"
    cfg = {}
    if tea_cfg.exists():
        for line in tea_cfg.read_text(encoding="utf-8", errors="ignore").splitlines():
            m = re.match(r"^(\w+):\s*['\"]?([^'\"#]+)", line)
            if m and ("output" in m.group(1) or "artifacts" in m.group(1)):
                cfg[m.group(1)] = m.group(2).strip()
    return {
        "testarch_skills_present": present,
        "testarch_skills_missing": [s for s in TEA_SKILLS if s not in present],
        "tea_config": cfg,
    }


def docs(root: Path) -> list[str]:
    out: set[str] = set()
    for g in DOC_GLOBS:
        for p in root.glob(g):
            if p.is_file() and not any(part in SKIP_DIRS for part in p.relative_to(root).parts):
                out.add(str(p.relative_to(root)))
    return sorted(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=".", help="repository root (default: cwd)")
    ap.add_argument("--scope", default="", help="subpath to inventory (default: whole repo)")
    ap.add_argument("-o", "--output", help="write JSON here instead of stdout")
    a = ap.parse_args()
    root = Path(a.root).resolve()
    scope = (root / a.scope).resolve() if a.scope else root
    if not scope.is_dir():
        print(f"scope not found: {scope}", file=sys.stderr)
        return 2
    result = {
        "root": str(root),
        "scope": str(scope.relative_to(root)) or ".",
        "git_head": sh(["git", "rev-parse", "--short", "HEAD"], root),
        "git_branch": sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], root),
        "package_manager": next((n for n, f in (("pnpm", "pnpm-lock.yaml"), ("yarn", "yarn.lock"),
                                                 ("npm", "package-lock.json"), ("bun", "bun.lockb"),
                                                 ("uv", "uv.lock"), ("poetry", "poetry.lock"))
                                 if (root / f).exists()), None),
        "monorepo_markers": [f for f in ("nx.json", "pnpm-workspace.yaml", "turbo.json", "lerna.json")
                             if (root / f).exists()],
        "packages": [package_info(p.parent, root) for p in find_files(root, names={"package.json"})],
        "dotnet": {"solutions": [str(p.relative_to(root)) for p in find_files(root, suffixes={".sln", ".slnx"})],
                   "projects": [dotnet_project(p, root) for p in find_files(root, suffixes={".csproj"})]},
        "python": python_info(root),
        "hooks": hooks(root),
        "ci": ci(root),
        "agent_docs": agent_docs(root),
        "tree": walk(root, scope),
        "bmad": bmad(root),
        "docs_to_read": docs(root),
    }
    text = json.dumps(result, indent=2)
    if a.output:
        Path(a.output).write_text(text + "\n", encoding="utf-8")
        print(f"wrote {a.output}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
