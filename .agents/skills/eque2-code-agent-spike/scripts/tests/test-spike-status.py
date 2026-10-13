#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Unit tests for spike-status.py. Run: python3 test-spike-status.py (or pytest on this file)."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "spike_status", Path(__file__).resolve().parent.parent / "spike-status.py"
)
ss = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ss)

BRIEF = "---\nspike: {slug}\njournal-workstream: mcp-query-speed\n---\n# Experiment brief\n"


def created(name: str) -> str:
    return json.dumps({"event": "created", "name": name, "tag": "spike:s", "delete": f"docker rm -f {name}", "at": "t"})


def torn(name: str) -> str:
    return json.dumps({"event": "torn-down", "name": name, "proof": "docker ps -a -> none", "at": "t"})


def goal(root: Path, slug: str, files: dict[str, str]) -> Path:
    folder = root / "_bmad-output/goals" / f"{slug}.goal"
    folder.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        (folder / name).write_text(text)
    return folder


def gate(root: Path, exit_code: int, output: str = "") -> Path:
    """A skills root whose cancel.sh exits with `exit_code` and prints `output`."""
    script = root / "skills/eque2-code-goal-gate/cancel.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(f"#!/usr/bin/env bash\nprintf '%s\\n' '{output}'\nexit {exit_code}\n")
    return root / "skills"


def moved(main: Path, slug: str, worktree: Path, files: dict[str, str]) -> Path:
    (main / "_bmad-output/goals").mkdir(parents=True, exist_ok=True)
    (main / "_bmad-output/goals" / f"{slug}.moved").write_text(
        f"moved-to: {worktree}\nbranch:   goal/{slug}\nmoved-at: 2026-10-03T00:00:00Z\n"
    )
    return goal(worktree, slug, files)


def only(report: dict) -> dict:
    assert len(report["spikes"]) == 1, report
    return report["spikes"][0]


def test_non_spike_goal_is_ignored():
    with tempfile.TemporaryDirectory() as d:
        goal(Path(d), "plain-task", {"plan.md": "# Plan\n"})
        assert ss.build_report(Path(d), None)["spikes"] == []


def test_planned_spike_in_main_is_clean_and_has_no_loop():
    with tempfile.TemporaryDirectory() as d:
        goal(Path(d), "spike-a", {"experiment-brief.md": BRIEF.format(slug="spike-a")})
        s = only(ss.build_report(Path(d), None))
        assert (s["state"], s["loop"], s["sweep"], s["source"]) == ("planned", "n/a", "clean", "main")
        assert s["journal_workstream"] == "mcp-query-speed"


def test_approved_state_from_marker():
    with tempfile.TemporaryDirectory() as d:
        goal(Path(d), "spike-a", {"experiment-brief.md": BRIEF.format(slug="spike-a"), ".approved": "approved-by: user\n"})
        assert only(ss.build_report(Path(d), None))["state"] == "approved"


def test_outstanding_resource_with_idle_loop_is_torn_down():
    with tempfile.TemporaryDirectory() as d:
        main, wt = Path(d) / "main", Path(d) / "wt"
        moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a"),
                                    "resources.jsonl": created("pg") + "\n" + created("redis") + "\n" + torn("redis") + "\n"})
        s = only(ss.build_report(main, gate(Path(d), 1, "goal-gate: no loop is running here.")))
        assert (s["state"], s["loop"], s["sweep"]) == ("prepared", "idle", "tear-down")
        assert [r["name"] for r in s["ledger"]["outstanding"]] == ["pg"]
        assert s["ledger"]["outstanding"][0]["delete"] == "docker rm -f pg"
        assert s["ledger"]["torn_down"] == 1


def test_active_loop_on_this_folder_is_left_running():
    with tempfile.TemporaryDirectory() as d:
        main, wt = Path(d) / "main", Path(d) / "wt"
        folder = moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a"), "resources.jsonl": created("pg") + "\n"})
        s = only(ss.build_report(main, gate(Path(d), 0, f"goal folder: {folder}")))
        assert (s["loop"], s["sweep"]) == ("active", "leave-running")


def test_active_loop_on_another_folder_is_idle_for_this_spike():
    with tempfile.TemporaryDirectory() as d:
        main, wt = Path(d) / "main", Path(d) / "wt"
        moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a"), "resources.jsonl": created("pg") + "\n"})
        s = only(ss.build_report(main, gate(Path(d), 0, f"goal folder: {Path(d)}/elsewhere.goal")))
        assert (s["loop"], s["sweep"]) == ("idle", "tear-down")


def test_active_loop_without_a_folder_is_treated_as_this_spike():
    with tempfile.TemporaryDirectory() as d:
        main, wt = Path(d) / "main", Path(d) / "wt"
        moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a"), "resources.jsonl": created("pg") + "\n"})
        s = only(ss.build_report(main, gate(Path(d), 0, "goal folder: <unrecorded>")))
        assert s["sweep"] == "leave-running"


def test_unreadable_loop_state_blocks_teardown():
    with tempfile.TemporaryDirectory() as d:
        main, wt = Path(d) / "main", Path(d) / "wt"
        moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a"), "resources.jsonl": created("pg") + "\n"})
        assert only(ss.build_report(main, gate(Path(d), 5)))["sweep"] == "loop-unknown"
        assert only(ss.build_report(main, None))["sweep"] == "loop-unknown"


def test_sweep_record_in_main_clears_outstanding():
    with tempfile.TemporaryDirectory() as d:
        main, wt = Path(d) / "main", Path(d) / "wt"
        moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a"), "resources.jsonl": created("pg") + "\n"})
        (main / "_bmad-output/goals/spike-a.sweep.jsonl").write_text(torn("pg") + "\n")
        s = only(ss.build_report(main, gate(Path(d), 1)))
        assert (s["sweep"], s["ledger"]["torn_down"]) == ("clean", 1)


def test_malformed_ledger_lines_are_reported_not_dropped_silently():
    with tempfile.TemporaryDirectory() as d:
        main, wt = Path(d) / "main", Path(d) / "wt"
        bad = "not json\n" + json.dumps({"event": "created"}) + "\n" + json.dumps({"event": "created", "name": "x"}) + "\n"
        moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a"), "resources.jsonl": bad})
        s = only(ss.build_report(main, gate(Path(d), 1)))
        assert [m["line"] for m in s["ledger"]["malformed"]] == [1, 2, 3]
        assert [r["name"] for r in s["ledger"]["outstanding"]] == ["x"]


def test_verdict_comes_from_findings_frontmatter():
    with tempfile.TemporaryDirectory() as d:
        goal(Path(d), "spike-a", {"experiment-brief.md": BRIEF.format(slug="spike-a"),
                                  "findings.md": "---\nverdict: Adopt\n---\n# Findings\n"})
        assert only(ss.build_report(Path(d), None))["verdict"] == "adopt"
        goal(Path(d), "spike-a", {"findings.md": "---\nverdict: maybe\n---\n"})
        assert only(ss.build_report(Path(d), None))["verdict"] is None


def test_journal_entry_on_spike_branch_but_not_in_main_is_listed():
    with tempfile.TemporaryDirectory() as d:
        main, wt = Path(d) / "main", Path(d) / "wt"
        moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a")})
        jw, jm = wt / "_bmad-output/journals/mcp-query-speed", main / "_bmad-output/journals/mcp-query-speed"
        jw.mkdir(parents=True)
        jm.mkdir(parents=True)
        (jw / "2026-10-03-spike-a.md").write_text("---\nverdict: failed\n---\n")
        (jw / "2026-09-01-old.md").write_text("old\n")
        (jm / "2026-09-01-old.md").write_text("old\n")
        (jw / "JOURNAL.md").write_text("- [2026-10-03 failed](2026-10-03-spike-a.md) — query batching is noise\n")
        s = only(ss.build_report(main, gate(Path(d), 1)))
        assert [e["file"] for e in s["journal_not_home"]] == ["2026-10-03-spike-a.md"]
        assert s["journal_not_home"][0]["index_line"].startswith("- [2026-10-03 failed]")


def test_stale_spike_is_read_from_its_branch():
    with tempfile.TemporaryDirectory() as d:
        main = Path(d) / "main"
        main.mkdir()
        git = ["git", "-C", str(main), "-c", "user.email=t@t", "-c", "user.name=t"]
        subprocess.run(git + ["init", "-q", "-b", "main"], check=True)
        subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "root"], check=True)
        subprocess.run(git + ["switch", "-q", "-c", "goal/spike-a"], check=True)
        goal(main, "spike-a", {"experiment-brief.md": BRIEF.format(slug="spike-a"), "resources.jsonl": created("pg") + "\n"})
        subprocess.run(git + ["add", "-A"], check=True)
        subprocess.run(git + ["commit", "-q", "-m", "spike"], check=True)
        subprocess.run(git + ["switch", "-q", "main"], check=True)
        (main / "_bmad-output/goals").mkdir(parents=True, exist_ok=True)
        (main / "_bmad-output/goals/spike-a.moved").write_text(
            f"moved-to: {Path(d) / 'gone'}\nbranch:   goal/spike-a\n"
        )
        s = only(ss.build_report(main, None))
        assert (s["state"], s["source"], s["loop"], s["sweep"]) == ("stale", "branch", "n/a", "tear-down")
        assert s["folder"] == "git:goal/spike-a:_bmad-output/goals/spike-a.goal"
        assert [r["name"] for r in s["ledger"]["outstanding"]] == ["pg"]


def test_cli_rejects_missing_root_and_writes_json():
    assert ss.main(["/nonexistent/path/for/spike-status"]) == 2
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "report.json"
        assert ss.main([d, "-o", str(out)]) == 0
        assert json.loads(out.read_text())["summary"]["spikes"] == 0


REAL_GATE_ROOT = Path(__file__).resolve().parents[3]  # the skills root holding eque2-code-goal-gate


def test_delete_runs_unattended_only_when_it_names_its_resource_or_tag():
    assert ss.names_itself({"name": "pg", "tag": "spike:s", "delete": "docker rm -f pg"})
    assert ss.names_itself({"name": "x", "tag": "spike:s", "delete": "gcloud run services delete --filter labels.spike:s"})
    assert not ss.names_itself({"name": "pg", "tag": "spike:s", "delete": "docker system prune -af"})
    with tempfile.TemporaryDirectory() as d:
        main, wt = Path(d) / "main", Path(d) / "wt"
        prune = json.dumps({"event": "created", "name": "pg", "tag": "spike:s", "delete": "docker system prune -af", "at": "t"})
        moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a"),
                                    "resources.jsonl": created("redis") + "\n" + prune + "\n"})
        s = only(ss.build_report(main, gate(Path(d), 1)))
        assert {r["name"]: r["auto"] for r in s["ledger"]["outstanding"]} == {"redis": True, "pg": False}


def test_main_checkout_flag_tells_a_worktree_apart():
    with tempfile.TemporaryDirectory() as d:
        main = Path(d) / "m"
        main.mkdir()
        git = ["git", "-C", str(main), "-c", "user.email=t@t", "-c", "user.name=t"]
        subprocess.run(git + ["init", "-q", "-b", "main"], check=True)
        subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "root"], check=True)
        subprocess.run(git + ["worktree", "add", "-q", str(Path(d) / "wt"), "-b", "goal/x"], check=True)
        assert ss.is_main_checkout(main) is True
        assert ss.is_main_checkout(Path(d) / "wt") is False
        assert ss.build_report(main, None)["main_checkout"] is True
        plain = Path(d) / "plain"
        plain.mkdir()
        assert ss.is_main_checkout(plain) is None


def test_criteria_counts_come_from_the_gate_checker():
    if not (REAL_GATE_ROOT / "eque2-code-goal-gate" / "acs-format-check.sh").is_file():
        return  # installed without the goal gate beside it
    done = "## Done when\n\n- [x] Environment proven — `environment.md`\n      - evidence: `kubectl config current-context` -> staging\n"
    open_ = done + "- [ ] Baseline measured — `baseline.md`\n      - explanation: not run yet.\n"
    with tempfile.TemporaryDirectory() as d:
        for acs, expected in ((done, True), (open_, False)):
            main, wt = Path(d) / "main", Path(d) / "wt"
            shutil.rmtree(main, ignore_errors=True)
            shutil.rmtree(wt, ignore_errors=True)
            moved(main, "spike-a", wt, {"experiment-brief.md": BRIEF.format(slug="spike-a"), "ACs.md": acs})
            s = only(ss.build_report(main, REAL_GATE_ROOT))
            assert s["criteria"]["done"] is expected, s["criteria"]
        assert s["criteria"] | {"done": None} == {"total": 2, "checked": 1, "unchecked": 1, "blocked": 0, "done": None}


def test_stale_spike_criteria_are_counted_from_its_branch():
    if not (REAL_GATE_ROOT / "eque2-code-goal-gate" / "acs-format-check.sh").is_file():
        return
    with tempfile.TemporaryDirectory() as d:
        main = Path(d) / "main"
        main.mkdir()
        git = ["git", "-C", str(main), "-c", "user.email=t@t", "-c", "user.name=t"]
        subprocess.run(git + ["init", "-q", "-b", "main"], check=True)
        subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "root"], check=True)
        subprocess.run(git + ["switch", "-q", "-c", "goal/spike-a"], check=True)
        acs = "## Done when\n\n- [x] Environment proven — `environment.md`\n      - evidence: `kubectl config current-context` -> staging\n"
        goal(main, "spike-a", {"experiment-brief.md": BRIEF.format(slug="spike-a"), "ACs.md": acs})
        subprocess.run(git + ["add", "-A"], check=True)
        subprocess.run(git + ["commit", "-q", "-m", "spike"], check=True)
        subprocess.run(git + ["switch", "-q", "main"], check=True)
        (main / "_bmad-output/goals").mkdir(parents=True, exist_ok=True)
        (main / "_bmad-output/goals/spike-a.moved").write_text(f"moved-to: {Path(d) / 'gone'}\nbranch:   goal/spike-a\n")
        s = only(ss.build_report(main, REAL_GATE_ROOT))
        assert (s["state"], s["criteria"]["done"]) == ("stale", True)


def test_help_documents_the_safety_fields():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.suppress(SystemExit):
        ss.main(["--help"])
    for word in ("tear-down", "leave-running", "loop-unknown", "check-by-tag", "lost", "ledger.found",
                 "auto", "main_checkout", "resources.jsonl"):
        assert word in buf.getvalue(), word


def test_auto_runs_only_known_delete_verbs_aimed_at_their_own_resource():
    entry = {"name": "pg", "tag": "spike:s"}
    for command, expected in (
        ("docker rm -f pg", True),
        ("docker rm pg --force", True),
        ("docker volume rm pg", True),
        ("gcloud run services delete pg --region us-east1", True),
        ("gcloud run services delete --filter=labels.spike:s", True),
        ("aws rds delete-db-instance --db-instance-identifier pg", True),
        ("kubectl delete pod pg -n spikes", True),
        ("gcloud run services delete other --filter=labels.spike:s", False),
        ("gcloud run services delete --filter=labels.other", False),
        ("kubectl delete pod other", False),
        ("docker rm -f other pg", False),
        ("docker rm -f pgbouncer", False),
        ("docker rm -f pg; rm -rf /", False),
        ("docker rm -f pg && docker system prune -af", False),
        ("docker rm -f pg & docker system prune -af", False),
        ("docker rm -f $(docker ps -q)", False),
        ("docker rm -f pg | tee log", False),
        ("docker rm -f pg > /dev/null", False),
        ("docker rm -f 'pg", False),
        ("rm -rf / pg", False),
        ("rm -rf . pg", False),
        ("rm -rf .. pg", False),
        ('rm -rf "$HOME" pg', False),
        ("rm -rf $PWD pg", False),
        ("find . -delete -name pg", False),
        ("bash -c 'docker rm pg' pg", False),
        ("docker system prune -af", False),
        ("docker rm -f spike-*", False),
        ("pg", False),
        ("", False),
    ):
        assert ss.names_itself(entry | {"delete": command}) is expected, command


def test_lost_spike_stub_is_reported_for_a_tag_search():
    with tempfile.TemporaryDirectory() as d:
        goals = Path(d) / "_bmad-output/goals"
        goals.mkdir(parents=True)
        (goals / "spike-gone.moved").write_text(f"moved-to: {Path(d) / 'nowhere'}\nbranch:   goal/spike-gone\n")
        (goals / "plain-gone.moved").write_text(f"moved-to: {Path(d) / 'nowhere'}\nbranch:   goal/plain-gone\n")
        (goals / "spike-gone-promotion.moved").write_text(f"moved-to: {Path(d) / 'nowhere'}\nbranch:   goal/spike-gone-promotion\n")
        report = ss.build_report(Path(d), None)
        s = only(report)
        assert (s["slug"], s["state"], s["sweep"], s["ledger"]["found"]) == ("spike-gone", "lost", "check-by-tag", False)
        assert report["summary"]["lost"] == 1


def test_a_live_branch_without_a_brief_is_not_a_spike():
    with tempfile.TemporaryDirectory() as d:
        main = Path(d) / "main"
        main.mkdir()
        git = ["git", "-C", str(main), "-c", "user.email=t@t", "-c", "user.name=t"]
        subprocess.run(git + ["init", "-q", "-b", "main"], check=True)
        subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "root"], check=True)
        subprocess.run(git + ["branch", "goal/spike-q-promotion"], check=True)
        goals = main / "_bmad-output/goals"
        goals.mkdir(parents=True)
        (goals / "spike-q-promotion.moved").write_text(f"moved-to: {Path(d) / 'gone'}\nbranch:   goal/spike-q-promotion\n")
        assert ss.build_report(main, None)["spikes"] == []


def test_ledger_found_tells_no_ledger_from_an_empty_one():
    with tempfile.TemporaryDirectory() as d:
        goal(Path(d), "spike-a", {"experiment-brief.md": BRIEF.format(slug="spike-a")})
        assert only(ss.build_report(Path(d), None))["ledger"]["found"] is False
        goal(Path(d), "spike-a", {"resources.jsonl": ""})
        assert only(ss.build_report(Path(d), None))["ledger"]["found"] is True


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
