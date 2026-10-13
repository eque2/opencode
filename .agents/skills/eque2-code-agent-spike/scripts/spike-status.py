#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Report every spike goal in a checkout: its state, loop, verdict, ledger, and journal.

Spike runs this on activation (the orphan sweep) and before [ES] and [AS]. It is
read-only: it never tears anything down and never copies a file. It turns the
goal folders, the resource ledgers, and the gate's loop status into one JSON
report, so the model decides from facts instead of re-reading folders by hand.

A spike goal is a goal folder that holds `experiment-brief.md` (plan-goal copies
the brief in verbatim). Folders are found the way Hannibal's status scan finds
them: `_bmad-output/goals/<slug>.goal/` in the main checkout, or a
`<slug>.moved` stub whose `moved-to:` names the worktree. A stub whose worktree
is gone is `stale`; its files are then read from the stub's `branch:` with
`git show`, so a deleted worktree does not hide a live resource.

Resource ledger — `resources.jsonl` in the spike goal folder, one JSON object
per line, written by the spike loop:
    {"event": "created", "name": "...", "tag": "spike:<slug>", "delete": "<command>", "at": "<ISO-8601>"}
    {"event": "torn-down", "name": "...", "proof": "<command -> observed result>", "at": "<ISO-8601>"}
The sweep records its own teardowns in the main checkout at
`_bmad-output/goals/<slug>.sweep.jsonl` (same torn-down shape) and never edits
the loop's ledger. An entry is outstanding when it was created and neither
file holds a torn-down event for its name.

`sweep` per spike is the safety rule the sweep obeys:
    tear-down     outstanding resources and no loop running — tear them down
    leave-running outstanding resources and the spike's loop is running
    loop-unknown  outstanding resources and the loop state cannot be read — do not act
    clean         nothing outstanding
    check-by-tag  state `lost`: a `spike-` stub (never a `-promotion` one) whose
                  worktree and branch are both gone — only the resources'
                  `spike:<slug>` tag can find what is left
Each outstanding entry also carries `auto`: true only when its delete command is
one known delete verb (docker/podman rm, kubectl delete, helm uninstall,
gcloud/az/aws … delete, git branch -D, git worktree remove) with no `;`, `&`,
`|`, backtick, `$`, redirect, or newline, and every target names the entry's own
resource or tag. The sweep runs an `auto` delete unattended; any other delete —
`rm` and `find` included — is shown to the developer first.
`ledger.found` is false when the spike folder holds no resources.jsonl at all.

`main_checkout` (top level) is false when the report runs inside a linked
worktree — a spike's own worktree included. The sweep writes nothing then.

`criteria` per spike counts the spike goal's ACs.md with the gate's own
`acs-format-check.sh --authoring` (null when it cannot be read): `done` is true
only when every criterion is met and evidenced and none is blocked.

Usage:  spike-status.py <project-root> [--skills-root DIR] [-o FILE]
Output: JSON {"project_root", "main_checkout", "spikes": [...], "summary": {...}}
Exit:   0 report written, 2 error (unreadable project root, bad arguments).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

GOALS = Path("_bmad-output/goals")
JOURNALS = Path("_bmad-output/journals")
BRIEF = "experiment-brief.md"
LEDGER = "resources.jsonl"
FINDINGS = "findings.md"
ENTRY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-.+\.md$")
VERDICTS = {"adopt", "reject", "inconclusive"}
# cancel.sh status can take a moment on a busy gate dir; a hang must not stall activation.
LOOP_CHECK_TIMEOUT_S = 30


class FsReader:
    """Reads files under a checkout directory."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def text(self, rel: Path) -> str | None:
        try:
            return (self.root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None

    def names(self, rel: Path) -> list[str]:
        try:
            return sorted(p.name for p in (self.root / rel).iterdir() if p.is_file())
        except OSError:
            return []

    def describe(self, rel: Path) -> str:
        return str(self.root / rel)


class GitReader:
    """Reads committed files from a branch, for a stale spike whose worktree is gone."""

    def __init__(self, repo: Path, branch: str) -> None:
        self.repo, self.branch = repo, branch

    def _git(self, *args: str) -> str | None:
        try:
            out = subprocess.run(
                ["git", "-C", str(self.repo), *args],
                capture_output=True, text=True, timeout=LOOP_CHECK_TIMEOUT_S,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        return out.stdout if out.returncode == 0 else None

    def text(self, rel: Path) -> str | None:
        return self._git("show", f"{self.branch}:{rel.as_posix()}")

    def names(self, rel: Path) -> list[str]:
        out = self._git("ls-tree", "--name-only", self.branch, rel.as_posix() + "/")
        return sorted(Path(line).name for line in (out or "").splitlines() if line)

    def describe(self, rel: Path) -> str:
        return f"git:{self.branch}:{rel.as_posix()}"


def frontmatter(text: str | None) -> dict[str, str]:
    """Return the `key: value` pairs of a leading `---` block."""
    if not text or not text.startswith("---"):
        return {}
    fields: dict[str, str] = {}
    for line in text.splitlines()[1:]:
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip()] = value.strip()
    return fields


def parse_stub(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip()] = value.strip()
    return fields


def read_events(text: str | None, source: str) -> tuple[list[dict], list[dict]]:
    """Parse a JSONL ledger into (events, malformed-line records)."""
    events, malformed = [], []
    for number, line in enumerate((text or "").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            malformed.append({"source": source, "line": number, "reason": "not JSON"})
            continue
        if not isinstance(event, dict) or event.get("event") not in {"created", "torn-down"} \
                or not isinstance(event.get("name"), str) or not event["name"]:
            malformed.append({"source": source, "line": number, "reason": "missing event or name"})
            continue
        if event["event"] == "created" and not event.get("delete"):
            malformed.append({"source": source, "line": number, "reason": "created without delete"})
        events.append(event)
    return events, malformed


# A delete runs unattended only through a known delete verb whose every target
# names the entry's own resource or tag. Anything else — chaining, substitution,
# `rm`, `find`, a target that names something else — falls back to the developer.
# ponytail: a short allow-list; a delete verb it lacks only asks the developer.
COMPOUND = re.compile(r";|&|\||`|\$|\n|>|<")
DELETE_VERBS = {
    ("docker", "rm"), ("docker", "container", "rm"), ("docker", "rmi"), ("docker", "image", "rm"),
    ("docker", "volume", "rm"), ("docker", "network", "rm"),
    ("podman", "rm"), ("podman", "rmi"), ("podman", "volume", "rm"), ("podman", "network", "rm"),
    ("kubectl", "delete"), ("helm", "uninstall"), ("git", "branch", "-D"), ("git", "worktree", "remove"),
}
CLOUD_CLIS = {"gcloud", "az", "aws"}  # <cli> <subcommands…> delete (aws: delete-* / terminate-*)
# Flags whose next token is their value (a location or scope, never a delete target).
VALUE_FLAGS = {"--zone", "--region", "--project", "--location", "-n", "--namespace", "--context",
               "--kubeconfig", "--resource-group", "-g", "--profile", "--filter"}


def delete_verb_end(tokens: list[str]) -> int | None:
    for verb in DELETE_VERBS:
        if tuple(tokens[:len(verb)]) == verb:
            return len(verb)
    if tokens[0] in CLOUD_CLIS:
        for i, tok in enumerate(tokens[1:], start=1):
            if tok.startswith("-"):
                return None
            if tok == "delete" or (tokens[0] == "aws" and tok.startswith(("delete-", "terminate-"))):
                return i + 1
    return None


def names_value(token: str, values: list[str]) -> bool:
    return any(token == v or (token.endswith(v) and token[-len(v) - 1] in "=./:") for v in values)


def names_itself(entry: dict) -> bool:
    """True when the delete runs a known delete verb and every target names its own resource or tag.

    A token names a value when it equals it or ends with it after `=`, `.`, `/` or `:`
    (`labels.spike:x` names tag `spike:x`); `pgbouncer` does not name resource `pg`.
    The value after a scope flag (`--zone`, `-n`, `--filter`, …) is not a target, but a
    `--filter` value must still name the tag. `kubectl delete` may name a kind first.
    """
    command = entry.get("delete") or ""
    if not command.strip() or COMPOUND.search(command):
        return False
    try:
        tokens = shlex.split(command)
    except ValueError:
        return False
    end = delete_verb_end(tokens) if tokens else None
    if end is None:
        return False
    values = [v for v in (entry.get("name"), entry.get("tag")) if v]
    rest, targets, filtered, i = tokens[end:], [], False, 0
    while i < len(rest):
        tok = rest[i]
        if not tok.startswith("-"):
            targets.append(tok)
            i += 1
            continue
        flag, eq, inline = tok.partition("=")
        takes_value = flag in VALUE_FLAGS and not eq
        value = inline if eq else (rest[i + 1] if takes_value and i + 1 < len(rest) else None)
        if flag == "--filter":
            if value is None or not names_value(value, values):
                return False
            filtered = True
        i += 2 if takes_value else 1
    if tokens[0] == "kubectl" and targets and re.fullmatch(r"[a-z][a-z0-9.-]*", targets[0]) \
            and not names_value(targets[0], values):
        targets = targets[1:]  # the kind, e.g. `kubectl delete pod <name>`
    return (bool(targets) or filtered) and all(names_value(tok, values) for tok in targets)


def ledger_report(loop_events: list[dict], sweep_events: list[dict]) -> dict:
    created: dict[str, dict] = {}
    torn: set[str] = set()
    for event in loop_events + sweep_events:
        if event["event"] == "created":
            created.setdefault(event["name"], event)
        else:
            torn.add(event["name"])
    outstanding = [
        {k: created[n].get(k) for k in ("name", "tag", "delete", "at")} | {"auto": names_itself(created[n])}
        for n in created if n not in torn
    ]
    return {"outstanding": outstanding, "torn_down": len(torn & set(created))}


def branch_exists(repo: Path, branch: str) -> bool:
    try:
        out = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"],
                             capture_output=True, text=True, timeout=LOOP_CHECK_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return True  # cannot tell: treat as live, so the record is read, never called lost
    return out.returncode == 0


def lost_record(slug: str, stub: dict) -> dict:
    """A spike-named stub whose worktree and branch are both gone: only its tag can find what is left."""
    return {
        "slug": slug, "worktree": None, "branch": stub.get("branch") or None, "state": "lost",
        "source": "none", "folder": None, "journal_workstream": None, "verdict": None,
        "ledger": {"outstanding": [], "torn_down": 0, "malformed": [], "found": False},
        "loop": "n/a", "criteria": None, "sweep": "check-by-tag", "journal_not_home": [],
    }


def loop_state(checkout: Path, folder: Path, skills_root: Path | None) -> str:
    """active | idle | unknown — via the gate's own `cancel.sh status`."""
    cancel = skills_root / "eque2-code-goal-gate" / "cancel.sh" if skills_root else None
    if cancel is None or not cancel.is_file():
        return "unknown"
    env = {k: v for k, v in os.environ.items() if k != "GOAL_GATE_DIR"}
    try:
        out = subprocess.run(
            ["bash", str(cancel), "status", str(checkout)],
            capture_output=True, text=True, timeout=LOOP_CHECK_TIMEOUT_S, env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    if out.returncode == 1:
        return "idle"
    if out.returncode != 0:
        return "unknown"
    # An active loop names its folder. One that names another folder is not this
    # spike's loop; one that names none is treated as this spike's (fail safe).
    match = re.search(r"goal folder:\s*(.+)", out.stdout + out.stderr)
    if match and match.group(1).strip() not in ("", "<unrecorded>"):
        try:
            if Path(match.group(1).strip().rstrip("/")).resolve() != folder.resolve():
                return "idle"
        except OSError:
            return "active"
    return "active"


def criteria_counts(acs_text: str | None, skills_root: Path | None) -> dict | None:
    """Count the spike goal's criteria with the gate's checker; None when it cannot run.

    The text is checked from a temporary copy, so a stale spike's ACs.md read from
    its branch is counted the same way as one on disk.
    """
    checker = skills_root / "eque2-code-goal-gate" / "acs-format-check.sh" if skills_root else None
    if checker is None or not checker.is_file() or acs_text is None:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        acs = Path(tmp) / "ACs.md"
        acs.write_text(acs_text, encoding="utf-8")
        try:
            out = subprocess.run(["bash", str(checker), "--authoring", str(acs)],
                                 capture_output=True, text=True, timeout=LOOP_CHECK_TIMEOUT_S)
        except (OSError, subprocess.TimeoutExpired):
            return None
    if out.returncode != 0:
        return None
    counts = {k: int(v) for k, v in re.findall(r"^(total|checked|unchecked|blocked)=(\d+)$", out.stdout, re.MULTILINE)}
    if set(counts) != {"total", "checked", "unchecked", "blocked"}:
        return None
    return counts | {"done": counts["total"] > 0 and counts["unchecked"] == 0 and counts["blocked"] == 0}


def journal_not_home(reader, project_root: Path, workstream: str) -> list[dict]:
    rel = JOURNALS / workstream
    home = set(FsReader(project_root).names(rel))
    index = reader.text(rel / "JOURNAL.md") or ""
    missing = []
    for name in reader.names(rel):
        if ENTRY_RE.match(name) and name not in home:
            line = next((row for row in index.splitlines() if f"({name})" in row), None)
            missing.append({"file": name, "source": reader.describe(rel / name), "index_line": line})
    return missing


def spike_record(project_root: Path, slug: str, skills_root: Path | None) -> dict | None:
    goals = project_root / GOALS
    stub = goals / f"{slug}.moved"
    record: dict = {"slug": slug, "worktree": None, "branch": None}
    if stub.is_file():
        fields = parse_stub(stub.read_text(encoding="utf-8", errors="replace"))
        worktree, branch = fields.get("moved-to", ""), fields.get("branch", "")
        record["branch"] = branch or None
        if worktree and Path(worktree).is_dir():
            reader, record["state"], record["worktree"] = FsReader(Path(worktree)), "prepared", worktree
            record["source"], checkout = "worktree", Path(worktree)
        elif branch and branch_exists(project_root, branch):
            reader, record["state"], record["source"], checkout = GitReader(project_root, branch), "stale", "branch", None
        else:
            # ponytail: a stub naming neither a live worktree nor a live branch cannot prove it
            # was a spike; the `spike-` slug from [PS] is the only clue. A promotion is not a spike.
            spike_like = slug.startswith("spike-") and not slug.endswith("-promotion")
            return lost_record(slug, fields) if spike_like else None
    else:
        reader, record["source"], checkout = FsReader(project_root), "main", project_root
        folder = goals / f"{slug}.goal"
        record["state"] = ("prepared-in-place" if (folder / "goal.md").is_file()
                           else "approved" if (folder / ".approved").is_file() else "planned")
    rel_folder = GOALS / f"{slug}.goal"
    brief = reader.text(rel_folder / BRIEF)
    if brief is None:
        return None  # not a spike goal
    record["folder"] = reader.describe(rel_folder)
    record["journal_workstream"] = frontmatter(brief).get("journal-workstream") or None
    verdict = frontmatter(reader.text(rel_folder / FINDINGS)).get("verdict", "").lower()
    record["verdict"] = verdict if verdict in VERDICTS else None

    ledger_text = reader.text(rel_folder / LEDGER)
    loop_events, malformed = read_events(ledger_text, reader.describe(rel_folder / LEDGER))
    sweep_path = goals / f"{slug}.sweep.jsonl"
    sweep_text = sweep_path.read_text(encoding="utf-8", errors="replace") if sweep_path.is_file() else None
    sweep_events, sweep_bad = read_events(sweep_text, str(sweep_path))
    record["ledger"] = ledger_report(loop_events, sweep_events) | {
        "malformed": malformed + sweep_bad, "found": ledger_text is not None,
    }

    if record["state"] in ("prepared", "prepared-in-place") and checkout is not None:
        record["loop"] = loop_state(checkout, checkout / rel_folder, skills_root)
    else:
        record["loop"] = "n/a"
    record["criteria"] = criteria_counts(reader.text(rel_folder / "ACs.md"), skills_root)
    if not record["ledger"]["outstanding"]:
        record["sweep"] = "clean"
    elif record["loop"] in ("idle", "n/a"):
        record["sweep"] = "tear-down"
    elif record["loop"] == "active":
        record["sweep"] = "leave-running"
    else:
        record["sweep"] = "loop-unknown"

    workstream = record["journal_workstream"]
    record["journal_not_home"] = (
        journal_not_home(reader, project_root, workstream)
        if workstream and record["source"] != "main" else []
    )
    return record


def default_skills_root(project_root: Path) -> Path | None:
    for candidate in (project_root / ".claude/skills", project_root / ".agents/skills"):
        if (candidate / "eque2-code-goal-gate").is_dir():
            return candidate
    return None


def is_main_checkout(path: Path) -> bool | None:
    """True in a main checkout, False in a linked worktree, None outside git."""
    try:
        out = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
            capture_output=True, text=True, timeout=LOOP_CHECK_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    dirs = out.stdout.split()
    if out.returncode != 0 or len(dirs) != 2:
        return None
    return Path(dirs[0]).resolve() == Path(dirs[1]).resolve()


def build_report(project_root: Path, skills_root: Path | None) -> dict:
    goals = project_root / GOALS
    slugs = set()
    if goals.is_dir():
        for entry in goals.iterdir():
            if entry.is_dir() and entry.name.endswith(".goal"):
                slugs.add(entry.name[: -len(".goal")])
            elif entry.is_file() and entry.name.endswith(".moved"):
                slugs.add(entry.name[: -len(".moved")])
    spikes = [r for s in sorted(slugs) if (r := spike_record(project_root, s, skills_root))]
    return {
        "project_root": str(project_root),
        "main_checkout": is_main_checkout(project_root),
        "spikes": spikes,
        "summary": {
            "spikes": len(spikes),
            "to_tear_down": sum(len(s["ledger"]["outstanding"]) for s in spikes if s["sweep"] == "tear-down"),
            "left_running": sum(1 for s in spikes if s["sweep"] == "leave-running"),
            "loop_unknown": sum(1 for s in spikes if s["sweep"] == "loop-unknown"),
            "journal_entries_not_home": sum(len(s["journal_not_home"]) for s in spikes),
            "malformed_ledger_lines": sum(len(s["ledger"]["malformed"]) for s in spikes),
            "lost": sum(1 for s in spikes if s["state"] == "lost"),
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("project_root", help="main checkout root (where _bmad-output/goals/ lives)")
    parser.add_argument("--skills-root", help="installed skills root (default: .claude/skills or .agents/skills)")
    parser.add_argument("-o", "--output", help="write the JSON report here instead of stdout")
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    if not project_root.is_dir():
        print(f"spike-status: not a directory: {project_root}", file=sys.stderr)
        return 2
    skills_root = Path(args.skills_root).resolve() if args.skills_root else default_skills_root(project_root)
    report = json.dumps(build_report(project_root, skills_root), indent=2)
    if args.output:
        Path(args.output).write_text(report + "\n", encoding="utf-8")
    else:
        print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
