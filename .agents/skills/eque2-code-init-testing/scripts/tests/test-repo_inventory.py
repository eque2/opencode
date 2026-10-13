"""Smoke test: build a tiny repo, inventory it, check the facts a plan relies on."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "repo_inventory.py"


def test_inventory_counts_and_layout():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "package.json").write_text(json.dumps({
            "name": "demo", "scripts": {"test": "vitest run", "typecheck": "tsc --noEmit"},
            "devDependencies": {"vitest": "3.0.0", "@vitest/coverage-v8": "3.0.0", "typescript": "5.6.0"},
        }))
        (root / "src/core/test").mkdir(parents=True)
        (root / "src/core/a.ts").write_text("export const a = 1\n\nexport const b = 2\n")
        (root / "src/core/test/a.test.ts").write_text("it('x', () => {})\n")
        (root / "src/core/b.test.ts").write_text("it('y', () => {})\n")
        (root / "node_modules/dep").mkdir(parents=True)
        (root / "node_modules/dep/package.json").write_text("{}")
        (root / "node_modules/dep/index.js").write_text("x\n" * 500)
        out = subprocess.run([sys.executable, str(SCRIPT), "--root", tmp], capture_output=True, text=True, check=True)
        d = json.loads(out.stdout)
    assert [p["name"] for p in d["packages"]] == ["demo"], d["packages"]
    assert d["packages"][0]["runners"] == {"vitest": "3.0.0"}
    assert d["packages"][0]["coverage"] == {"@vitest/coverage-v8": "3.0.0"}
    assert d["tree"]["totals"] == {"source_files": 1, "source_loc": 2, "test_files": 2, "test_loc": 2}
    assert d["tree"]["layout"] == {"in_test_dir": 1, "colocated": 1}
    assert d["tree"]["directories"]["src/core"]["source_files"] == 1
    assert d["bmad"]["testarch_skills_present"] == []


def test_inventory_dotnet_hooks_ci_and_agent_docs():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "core.hooksPath", ".githooks"], cwd=root, check=True)
        (root / "App.sln").write_text("")
        (root / "src/App").mkdir(parents=True)
        (root / "src/App/App.csproj").write_text('<Project Sdk="Microsoft.NET.Sdk"></Project>')
        (root / "src/App/Invoice.cs").write_text("class Invoice\n{\n}\n")
        (root / "tests/App.UnitTests").mkdir(parents=True)
        (root / "tests/App.UnitTests/App.UnitTests.csproj").write_text(
            '<Project><ItemGroup>'
            '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.0" />'
            '<PackageReference Include="xunit" Version="2.9.0" />'
            '<PackageReference Include="coverlet.collector" />'
            '</ItemGroup></Project>')
        (root / "tests/App.UnitTests/InvoiceSpecs.cs").write_text("class InvoiceSpecs {}\n")
        (root / "src/App/obj").mkdir()
        (root / "src/App/obj/Generated.cs").write_text("x\n" * 50)
        (root / ".githooks").mkdir()
        (root / ".githooks/pre-push").write_text("#!/bin/sh\n")
        (root / ".github/workflows").mkdir(parents=True)
        (root / ".github/workflows/ci.yml").write_text("on: push\n")
        (root / "pyproject.toml").write_text('[project.optional-dependencies]\ndev = ["pytest-cov>=5"]\n')
        (root / "AGENTS.md").write_text("<!-- bmad:context -->\n<!-- /bmad:context -->\n")
        (root / "CLAUDE.md").write_text("@AGENTS.md\n")
        out = subprocess.run([sys.executable, str(SCRIPT), "--root", tmp], capture_output=True, text=True, check=True)
        d = json.loads(out.stdout)
    assert d["dotnet"]["solutions"] == ["App.sln"]
    test_proj = next(p for p in d["dotnet"]["projects"] if p["name"] == "App.UnitTests")
    assert test_proj["is_test_project"] is True
    assert test_proj["runners"] == {"xunit": "2.9.0", "Microsoft.NET.Test.Sdk": "17.11.0"}
    assert test_proj["coverage"] == {"coverlet.collector": "central"}
    # A file in a *.UnitTests project counts as a test even without a Tests suffix; obj/ is skipped.
    assert d["tree"]["totals"]["test_files"] == 1 and d["tree"]["totals"]["source_files"] == 1
    assert d["python"]["tooling"] == ["pytest-cov"]
    assert d["hooks"]["managers"] == ["githooks-dir"]
    assert d["hooks"]["core_hooks_path"] == ".githooks"
    assert d["hooks"]["pre_push"] == ".githooks/pre-push"
    assert d["ci"] == {"github-actions": [".github/workflows/ci.yml"]}
    assert d["agent_docs"] == {"agents_md": True, "claude_md": True, "claude_imports_agents": True,
                               "bmad_context_block": True, "testing_block": False}


if __name__ == "__main__":
    test_inventory_counts_and_layout()
    test_inventory_dotnet_hooks_ci_and_agent_docs()
    print("ok")
