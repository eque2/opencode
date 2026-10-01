#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Install eque2-code's AI PR-review GitHub Actions into a target repo's .github/.

Copies every file under the skill's `assets/github/` to the same relative path
under `<project-root>/.github/`. The target repo owns these files once they
land, so a file the user has changed is never overwritten:

  * missing                           -> installed
  * identical to the shipped copy     -> unchanged
  * matches what setup last installed -> updated (the user never touched it;
                                         this is how upgrades propagate)
  * anything else                     -> kept (the user's edit wins; reported)

"What setup last installed" is a sha256 per file in
`.github/.eque2-code-review.json`, rewritten on every run. Without that record
an unmodified copy from an older release is indistinguishable from a user
edit, and upgrades would never reach it.

Output: JSON with `installed`, `updated`, `unchanged`, `kept` path lists.
Exit codes: 0=success, 1=validation error, 2=runtime error
"""

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

MANIFEST = ".eque2-code-review.json"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(source: Path, github: Path) -> dict:
    manifest_path = github / MANIFEST
    previous = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
    result = {"installed": [], "updated": [], "unchanged": [], "kept": []}
    record = {}

    for src in sorted(p for p in source.rglob("*") if p.is_file()):
        rel = src.relative_to(source).as_posix()
        dest = github / rel
        shipped = sha(src)
        if not dest.exists():
            action = "installed"
        elif sha(dest) == shipped:
            action = "unchanged"
        elif sha(dest) == previous.get(rel):
            action = "updated"
        else:
            result["kept"].append(rel)
            # Keep the old record so a later revert to it still counts as untouched.
            if rel in previous:
                record[rel] = previous[rel]
            continue
        if action != "unchanged":
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)
            # jira-integration executes fetch-jira-tickets.sh directly, and a
            # marketplace install does not reliably preserve file modes.
            if dest.suffix == ".sh":
                dest.chmod(0o755)
        result[action].append(rel)
        record[rel] = shipped

    github.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project-root", required=True, help="Absolute path to the target repo")
    parser.add_argument("--source", default=str(Path(__file__).resolve().parent.parent / "assets" / "github"),
                        help="Directory to copy from (default: the skill's assets/github)")
    args = parser.parse_args()

    root, source = Path(args.project_root), Path(args.source)
    if not root.is_absolute() or not root.is_dir():
        print(json.dumps({"error": f"--project-root must be an existing absolute directory: {root}"}))
        return 1
    if not source.is_dir():
        print(json.dumps({"error": f"source directory missing: {source}"}))
        return 1
    try:
        print(json.dumps(install(source, root / ".github"), indent=2))
    except OSError as e:
        print(json.dumps({"error": str(e)}))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
