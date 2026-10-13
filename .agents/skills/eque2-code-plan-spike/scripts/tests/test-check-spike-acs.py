#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Unit tests for check-spike-acs.py. Run: python3 test-check-spike-acs.py (or pytest on this file)."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "csa", Path(__file__).resolve().parent.parent / "check-spike-acs.py"
)
csa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(csa)

BRIEF = "---\nspike: spike-a\n---\n## Options\n\n### O1: batch reads\n\n### O2: add an index\n"

GOOD = """# Acceptance criteria

## Done when

- [ ] [D4] The target environment is named and proven non-production before the first change — `environment.md`
      - explanation: not started.
- [ ] [D2] The baseline is measured over 7 runs, its variance recorded, pinned to the commit SHA and fixture hash — `baseline.md`
      - explanation: not started.
- [ ] O1 is measured against the baseline, or marked inconclusive when its budget ran out — `results.md`
      - explanation: not started.
- [ ] O2 is measured against the baseline, or marked inconclusive when its budget ran out — `results.md`
      - explanation: not started.
- [ ] [D3] The verdict is written with the numbers, against the approved verdict rule — `findings.md`
      - explanation: not started.
- [ ] A journal entry is written through eque2-code-journal, win or lose — `_bmad-output/journals/mcp-query-speed/JOURNAL.md`
      - explanation: not started.
- [ ] Every resource in the ledger is torn down, with proof — `resources.jsonl`
      - explanation: not started.
- [ ] The repository lint, type-check, and tests pass — `.githooks/pre-push`
      - explanation: not started.
"""


def folder(acs: str, brief: str = BRIEF) -> tempfile.TemporaryDirectory:
    d = tempfile.TemporaryDirectory()
    (Path(d.name) / "ACs.md").write_text(acs)
    (Path(d.name) / "experiment-brief.md").write_text(brief)
    return d


def rules(acs: str, brief: str = BRIEF) -> list[str]:
    with folder(acs, brief) as d:
        return [f["rule"] for f in csa.check(Path(d))["findings"]]


def test_evidence_shaped_set_is_clean():
    with folder(GOOD) as d:
        result = csa.check(Path(d))
    assert result["ok"], result["findings"]
    assert (result["criteria"], result["options"]) == (8, ["O1", "O2"])


def test_environment_must_be_first():
    lines = GOOD.splitlines(keepends=True)
    env, baseline = lines[4:6], lines[6:8]
    swapped = "".join(lines[:4] + baseline + env + lines[8:])
    assert "environment-first" in rules(swapped)


def test_each_required_evidence_file_is_needed():
    for name in ("baseline.md", "findings.md", "JOURNAL.md", "resources.jsonl"):
        cut = "\n".join(line for line in GOOD.splitlines() if f"{name}`" not in line)
        assert "evidence-missing" in rules(cut), name


def test_every_option_needs_a_results_criterion():
    cut = GOOD.replace("- [ ] O2 is measured", "- [ ] The second change is measured")
    assert rules(cut) == ["option-missing"]


def test_option_named_on_another_file_does_not_count():
    cut = GOOD.replace("O2 is measured against the baseline, or marked inconclusive when its budget ran out — `results.md`",
                       "O2 is measured against the baseline — `notes.md`")
    assert rules(cut) == ["option-missing"]


def test_targets_are_refused():
    for target in ("p95 is under 200 ms", "latency drops by 20%", "throughput is at least 1500 rps",
                   "the query is 3x faster", "p99 < 1.5s", "memory stays within 512 MB"):
        acs = GOOD.replace("The verdict is written with the numbers", f"The verdict is written and {target}")
        assert rules(acs) == ["target-in-ac"], target


def test_evidence_wording_is_not_a_target():
    for wording in ("measured over 7 runs", "re-run 5 times", "budget of 3 attempts", "the 2 options"):
        acs = GOOD.replace("measured over 7 runs", wording)
        assert rules(acs) == [], wording


def test_numbers_inside_backticks_are_ignored():
    acs = GOOD.replace("`.githooks/pre-push`", "`bench/run.sh --p95-under 200ms`")
    assert rules(acs) == []


def test_indented_examples_are_not_criteria():
    acs = GOOD + "\n## Notes\n\n  - [ ] p95 under 200 ms — `results.md`\n"
    assert rules(acs) == []


def test_cli_exit_codes():
    with tempfile.TemporaryDirectory() as d:
        assert csa.main([d]) == 2
    with folder(GOOD) as d:
        out = Path(d) / "out.json"
        assert csa.main([d, "-o", str(out)]) == 0
        assert json.loads(out.read_text())["ok"] is True
    with folder(GOOD.replace("`environment.md`", "`env.md`")) as d:
        assert csa.main([d, "-o", str(Path(d) / "out.json")]) == 1


TEMPLATE = Path(__file__).resolve().parents[2] / "assets" / "experiment-brief-template.md"
GATE_CHECK = Path(__file__).resolve().parents[3] / "eque2-code-goal-gate" / "acs-format-check.sh"


def template_criteria() -> str:
    """Render the template's own criteria list as ACs.md lines, filling only Spike's slots."""
    section = TEMPLATE.read_text().split("## Spike goal acceptance criteria", 1)[1]
    items = re.findall(r"^\d+\. (.*(?:\n   .*)*)", section, re.MULTILINE)
    lines = []
    for item in items:
        text = " ".join(part.strip() for part in item.splitlines())
        text = text.replace("<journal-workstream>", "mcp-query-speed").replace("<run count>", "7")
        if "`" not in text:  # the quality gate plan-goal adds, named by the repo's real command
            text = "The repository lint, type-check, and tests pass — `.githooks/pre-push`"
        if text.startswith("One criterion per option: O<n>"):
            for option in ("O1", "O2"):
                lines.append(text.replace("One criterion per option: O<n>", option))
            continue
        lines.append(text)
    assert len(lines) == 9, lines
    return "## Done when\n\n" + "".join(f"- [ ] {line}\n      - explanation: not started.\n" for line in lines)


def test_template_criteria_pass_this_checker():
    with folder(template_criteria()) as d:
        result = csa.check(Path(d))
    assert result["ok"], result["findings"]


def test_template_criteria_pass_the_gate_format_check():
    if not GATE_CHECK.is_file():
        return  # installed without the goal gate beside it; the gate's own suite covers its rules
    with folder(template_criteria()) as d:
        out = subprocess.run(["bash", str(GATE_CHECK), "--authoring", str(Path(d) / "ACs.md")],
                             capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert "total=9" in out.stdout


def test_unfilled_template_is_flagged_and_its_formats_are_not():
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "experiment-brief.md").write_text(TEMPLATE.read_text())
        result = csa.check(Path(d))
    assert result["stage"] == "brief"
    unfilled = [f["detail"] for f in result["findings"] if f["rule"] == "brief-unfilled"]
    assert any("<e.g. an option improves" in u for u in unfilled), unfilled  # a slot that wraps lines
    assert not any("ISO-8601" in u or "unique name" in u for u in unfilled), unfilled  # the loop's formats


def test_comparisons_in_prose_are_not_slots():
    with tempfile.TemporaryDirectory() as d:
        brief = BRIEF + "\n## Verdict rule\n\n- reject — every option < 5% better and CV > 10%.\n"
        (Path(d) / "experiment-brief.md").write_text(brief)
        assert csa.check(Path(d))["ok"]


def test_brief_stage_runs_before_acs_exist():
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "experiment-brief.md").write_text(BRIEF)
        result = csa.check(Path(d))
    assert (result["ok"], result["stage"], result["options"]) == (True, "brief", ["O1", "O2"])


def test_brief_slots_and_missing_options_are_found():
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "experiment-brief.md").write_text(
            "## Hypothesis\n\n<One sentence that the experiment can prove false.>\n\n```\n<the verdict rule>\n```\n")
        rules_found = [f["rule"] for f in csa.check(Path(d))["findings"]]
    assert rules_found == ["brief-unfilled", "brief-no-options"]


def test_help_lists_every_rule():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.suppress(SystemExit):
        csa.main(["--help"])
    for rule in ("brief-unfilled", "brief-no-options", "environment-first", "evidence-missing",
                 "option-missing", "target-in-ac"):
        assert rule in buf.getvalue(), rule


def test_only_template_slots_count_as_unfilled():
    with tempfile.TemporaryDirectory() as d:
        brief = BRIEF + "\nThe cache maps `Map<String, Plan>` and <b>bold</b> text.\n- **Budget:** <wall-clock time or number of attempts>\n"
        (Path(d) / "experiment-brief.md").write_text(brief)
        unfilled = [f["detail"] for f in csa.check(Path(d))["findings"] if f["rule"] == "brief-unfilled"]
    assert len(unfilled) == 1 and "<wall-clock time or number of attempts>" in unfilled[0], unfilled


def test_any_slot_counts_when_the_template_is_missing():
    saved = csa.TEMPLATE
    csa.TEMPLATE = Path("/nonexistent/experiment-brief-template.md")
    try:
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "experiment-brief.md").write_text(BRIEF + "\n<anything here>\n")
            assert [f["rule"] for f in csa.check(Path(d))["findings"]] == ["brief-unfilled"]
    finally:
        csa.TEMPLATE = saved


def test_surrogate_word_in_slug_or_workstream_is_flagged():
    for front, expected in (("spike: spike-mock-db\njournal-workstream: db", 1),
                            ("spike: spike-db\njournal-workstream: example-ws", 1),
                            ("spike: spike-outstanding-locks\njournal-workstream: locks", 0)):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "experiment-brief.md").write_text(f"---\n{front}\n---\n### O1: x\n")
            found = [f for f in csa.check(Path(d))["findings"] if f["rule"] == "brief-surrogate"]
            assert len(found) == expected, (front, found)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001 — report every failure, then exit non-zero
                failures += 1
                print(f"FAIL {name}: {exc!r}")
    sys.exit(1 if failures else 0)
