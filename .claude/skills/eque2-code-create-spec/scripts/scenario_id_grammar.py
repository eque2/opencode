"""
scenario_id_grammar.py — the scenario id grammar for the create-spec scripts.

The grammar is defined ONCE, in the eque2-code schemas package, and ships as
the `pattern` of a scenario id in
`eque2-code-setup/schemas/actor-definitions.v1.schema.json`. The reporter, the
state CLI and these scripts all read that one definition, so a spec can never
declare an id the reporter cannot route (the DELIVERY-2 defect, 2026-09-28).
No prefix allow-list: the grammar is open.

Shared by cs-generate-definitions.py and cs-readiness-check.py. Loading never
happens at import of this module; a caller calls `load_grammar()` and handles
`GrammarUnavailable` so it can report a missing schema in its normal JSON
failure shape instead of crashing.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path

ACTOR_DEFINITIONS_SCHEMA = (
    Path(__file__).resolve().parent.parent.parent
    / "eque2-code-setup" / "schemas" / "actor-definitions.v1.schema.json"
)


class GrammarUnavailable(RuntimeError):
    """The shipped schema is missing or does not carry an anchored id pattern."""


@dataclass(frozen=True)
class Grammar:
    source: str
    """The UNANCHORED grammar, for embedding in a larger pattern."""
    id_re: re.Pattern[str]
    """A whole scenario id. Anchored with \\A…\\Z, so "S1\\n" does not match (as in JS)."""
    file_re: re.Pattern[str]
    """verify-{FEATURE}-{ID}.spec.ts — same shape as the reporter's SCENARIO_FILE_PATTERN."""

    def is_id(self, value: str) -> bool:
        return self.id_re.fullmatch(value) is not None

    def routed_id(self, basename: str) -> str | None:
        m = self.file_re.fullmatch(basename)
        return m.group(1) if m else None


def load_scenario_id_source(schema_path: Path = ACTOR_DEFINITIONS_SCHEMA) -> str:
    """Return the UNANCHORED scenario id grammar from the actor-definitions schema."""
    try:
        data = json.loads(schema_path.read_text(encoding="utf-8"))
        pattern = data["properties"]["scenarios"]["items"]["properties"]["id"]["pattern"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise GrammarUnavailable(
            f"cannot read the scenario id grammar from {schema_path}: {e}. "
            "Re-install eque2-code so eque2-code-setup/schemas/ is present."
        ) from e
    if not (isinstance(pattern, str) and pattern.startswith("^") and pattern.endswith("$")):
        raise GrammarUnavailable(f"scenario id pattern in {schema_path} is not anchored: {pattern!r}")
    return pattern[1:-1]


def load_grammar(schema_path: Path = ACTOR_DEFINITIONS_SCHEMA) -> Grammar:
    source = load_scenario_id_source(schema_path)
    return Grammar(
        source=source,
        id_re=re.compile(rf"\A(?:{source})\Z", re.ASCII),
        file_re=re.compile(rf"\Averify-[A-Za-z0-9_.-]+-({source})\.spec\.ts\Z", re.ASCII),
    )
