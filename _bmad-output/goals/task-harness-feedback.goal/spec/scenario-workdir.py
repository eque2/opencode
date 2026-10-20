#!/usr/bin/env python3
"""Post-step for definitions.json (owner ruling 6, context.md SD-21).

cs-generate-definitions.py writes workingDirectory "" for every scenario. That is the repository root, where the
root bunfig.toml blocks a test run. This step sets each scenario's workingDirectory to the package that holds its
testFile (packages/<name>), so the verifier runs `bun test ./test/...` from that package. testFile stays relative to
the repository root: the state CLI resolves it against the project root.

Usage: python3 scenario-workdir.py <spec folder>
Run it after every cs-generate-definitions.py run. It is idempotent and prints a JSON summary.
"""

import json
import re
import sys
from pathlib import Path

PACKAGE = re.compile(r"^(packages/[^/]+)/")


def main() -> int:
    spec = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    path = spec / "definitions.json"
    definitions = json.loads(path.read_text(encoding="utf-8"))
    counts: dict[str, int] = {}
    missing: list[str] = []
    for scenario in definitions["scenarios"]:
        match = PACKAGE.match(scenario["testFile"])
        if not match:
            missing.append(scenario["id"])
            continue
        scenario["workingDirectory"] = match.group(1)
        counts[match.group(1)] = counts.get(match.group(1), 0) + 1
    if missing:
        print(json.dumps({"status": "failed", "no_package": missing}))
        return 1
    path.write_text(json.dumps(definitions, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "ok", "workingDirectory": counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
