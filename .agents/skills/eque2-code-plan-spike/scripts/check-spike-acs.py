#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Check that a spike plan's acceptance criteria are evidence of an answer, never the answer.

A spike that honestly fails must still be able to finish. A criterion such as
"p95 under 200 ms" can never be met when the answer is no, so the loop could
only stall. [PS] runs this on the brief before plan-goal, and on the full set
after plan-goal writes ACs.md and before the developer approves it; [ES] runs
it on the approved set and again on the prepared folder.

It complements, and never replaces, the gate's own format checker
(eque2-code-goal-gate/acs-format-check.sh), which owns checkbox syntax,
evidence lines, and the surrogate-name rule.

Brief rules (experiment-brief.md; fenced code blocks are skipped, because the
ledger and findings formats are filled by the loop at run time):
    brief-unfilled     a slot from assets/experiment-brief-template.md is still in
                       the brief (other <...> text, such as a generic type, is not
                       a slot; with the template missing, any <slot> counts)
    brief-no-options   the brief declares no option (`### O<n>:` heading)
    brief-surrogate    the `spike` slug or `journal-workstream` contains a word the
                       gate refuses in a criterion path. Criterion 6 always names
                       the workstream's folder; the slug matters when plan-goal
                       writes full folder paths, so that half is conservative

Criteria rules (criteria are top-level `- [ ]`, `- [x]`, `- [!]` lines in
ACs.md; a criterion's specified system is its first backticked span). They run
only when ACs.md exists:
    environment-first  criterion 1's system is `environment.md` (non-production proof before any change)
    evidence-missing   a criterion exists whose system ends with each of:
                       baseline.md, findings.md, JOURNAL.md, resources.jsonl
    option-missing     every option id in the brief appears in a criterion
                       whose system is `results.md`
    target-in-ac       no criterion text (backticked spans removed) states a target:
                       a comparison followed by a number with a performance unit,
                       such as "under 200 ms", "at least 10%", "by 20%", "3x faster"

target-in-ac is a pattern match. A hit on wording that is not a target (for
example a timebox) is fixed by moving the number into the brief, or by putting
the condition in a backticked span after the evidence file — never before it,
because the first backticked span is the criterion's system. It is never fixed
by weakening the criterion.

Usage:  check-spike-acs.py <spike-goal-folder> [-o FILE]
Output: JSON {"ok", "stage": "brief"|"criteria", "criteria", "options", "findings": [...]}
Exit:   0 clean, 1 findings, 2 error (missing experiment-brief.md).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

CRITERION = re.compile(r"^- \[( |x|!)\] (.*)$")
BACKTICK = re.compile(r"`([^`]*)`")
# Fences may be indented inside a list item; a slot may wrap lines but never starts or ends
# with a space, so a comparison written as "x < 5 ... y > 3" is never read as a slot.
FENCE = re.compile(r"^[ \t]*(```|~~~).*?^[ \t]*\1[ \t]*$", re.MULTILINE | re.DOTALL)
SLOT = re.compile(r"<[^\s<>][^<>]{0,400}?[^\s<>]>")
OPTION_HEADING = re.compile(r"^###\s+(O\d+)\b", re.MULTILINE)
REQUIRED = ("baseline.md", "findings.md", "JOURNAL.md", "resources.jsonl")
TEMPLATE = Path(__file__).resolve().parent.parent / "assets" / "experiment-brief-template.md"
# The gate's surrogate list (eque2-code-goal-gate/acs-format-check.sh, acs_reference_is_surrogate).
SURROGATE = re.compile(
    r"mock|stub|fake|dummy|surrogate|stand-in|placeholder|sample|example|simulated|toy"
    r"|(?<![a-z])standin(?![a-z])",  # the gate bounds `standin` so "outstanding" passes
    re.IGNORECASE,
)

_UNIT = r"(?:ms|msec|milliseconds?|µs|us|ns|s|secs?|seconds?|minutes?|mins?|%|x|×|kb|mb|gb|tb|rps|qps|ops|req/s|requests/s|tps)"
_NUMBER = r"~?\d+(?:\.\d+)?\s*" + _UNIT + r"(?![a-z])"
_COMPARATOR = (
    r"(?:<=|>=|≤|≥|<|>|\bunder\b|\bbelow\b|\babove\b|\bover\b|\bless than\b|\bmore than\b|"
    r"\bfewer than\b|\bat least\b|\bat most\b|\bno more than\b|\bwithin\b|\bby\b|"
    r"\bfaster than\b|\bslower than\b|\bimproves?\b|\breduces?\b|\bcuts?\b)"
)
TARGET = re.compile(
    _COMPARATOR + r"\s*" + _NUMBER + r"|\b\d+(?:\.\d+)?\s*(?:x|×)\s*(?:faster|slower|quicker|fewer|more)\b",
    re.IGNORECASE,
)


def criteria(acs: str) -> list[dict]:
    found = []
    for line in acs.splitlines():
        match = CRITERION.match(line)
        if not match:
            continue
        text = match.group(2)
        spans = BACKTICK.findall(text)
        found.append({
            "number": len(found) + 1,
            "text": text,
            "system": spans[0].strip() if spans else "",
            "prose": BACKTICK.sub(" ", text),
        })
    return found


def system_is(criterion: dict, name: str) -> bool:
    return criterion["system"].rstrip("/").split("/")[-1] == name


def unfenced_slots(text: str) -> list[tuple[int, str]]:
    """(line number, whitespace-normalised slot) for every slot outside fenced blocks."""
    unfenced = FENCE.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    return [(unfenced.count("\n", 0, s.start()) + 1, " ".join(s.group(0).split()))
            for s in SLOT.finditer(unfenced)]


def template_slots() -> set[str] | None:
    try:
        return {slot for _, slot in unfenced_slots(TEMPLATE.read_text(encoding="utf-8"))}
    except OSError:
        return None


def check_brief(brief: str) -> list[dict]:
    findings = []
    known = template_slots()
    for number, text in unfenced_slots(brief):
        if known is None or text in known:
            findings.append({"rule": "brief-unfilled", "criterion": None,
                             "detail": f"line {number}: {text} is still a slot"})
    fields = {}
    if brief.startswith("---"):
        for line in brief.splitlines()[1:]:
            if line.strip() == "---":
                break
            key, sep, value = line.partition(":")
            if sep:
                fields[key.strip()] = value.strip()
    for key in ("spike", "journal-workstream"):
        hit = SURROGATE.search(fields.get(key, ""))
        if hit and not SLOT.fullmatch(fields[key]):
            findings.append({"rule": "brief-surrogate", "criterion": None,
                             "detail": f"`{key}: {fields[key]}` contains '{hit.group(0)}', which the gate refuses in a criterion path"})
    if not OPTION_HEADING.search(brief):
        findings.append({"rule": "brief-no-options", "criterion": None,
                         "detail": "the brief declares no option; each needs a `### O<n>: <name>` heading"})
    return findings


def check_criteria(items: list[dict], options: list[str]) -> list[dict]:
    findings: list[dict] = []
    if not items or not system_is(items[0], "environment.md"):
        findings.append({
            "rule": "environment-first", "criterion": 1 if items else None,
            "detail": "criterion 1 must name `environment.md`: the target environment proven non-production before the first change",
        })
    for name in REQUIRED:
        if not any(system_is(c, name) for c in items):
            findings.append({"rule": "evidence-missing", "criterion": None,
                             "detail": f"no criterion names `{name}` as its system"})
    results = [c for c in items if system_is(c, "results.md")]
    for option in options:
        if not any(re.search(rf"\b{option}\b", c["text"]) for c in results):
            findings.append({"rule": "option-missing", "criterion": None,
                             "detail": f"option {option} has no criterion naming `results.md`"})
    for c in items:
        hit = TARGET.search(c["prose"])
        if hit:
            findings.append({
                "rule": "target-in-ac", "criterion": c["number"],
                "detail": f"states a target ({hit.group(0).strip()!r}); move the number to the verdict rule and phrase the criterion as evidence",
            })
    return findings


def check(folder: Path) -> dict:
    brief = (folder / "experiment-brief.md").read_text(encoding="utf-8")
    options = sorted(set(OPTION_HEADING.findall(brief)), key=lambda o: int(o[1:]))
    findings = check_brief(brief)
    acs_path = folder / "ACs.md"
    items = criteria(acs_path.read_text(encoding="utf-8")) if acs_path.is_file() else []
    if acs_path.is_file():
        findings += check_criteria(items, options)
    return {
        "ok": not findings,
        "stage": "criteria" if acs_path.is_file() else "brief",
        "criteria": len(items),
        "options": options,
        "findings": findings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("folder", help="the spike goal folder (holds experiment-brief.md, and ACs.md once plan-goal wrote it)")
    parser.add_argument("-o", "--output", help="write the JSON result here instead of stdout")
    args = parser.parse_args(argv)

    folder = Path(args.folder)
    if not (folder / "experiment-brief.md").is_file():
        print(f"check-spike-acs: missing {folder / 'experiment-brief.md'}", file=sys.stderr)
        return 2
    result = check(folder)
    out = json.dumps(result, indent=2)
    if args.output:
        Path(args.output).write_text(out + "\n", encoding="utf-8")
    else:
        print(out)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
