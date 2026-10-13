#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Merge module help entries into shared _bmad/module-help.csv.

Reads a source CSV with module help entries and merges them into a target CSV.
Uses an anti-zombie pattern: all existing rows matching the source module code
are removed before appending fresh rows.

Legacy cleanup: when --legacy-dir and --module-code are provided, deletes old
per-module module-help.csv files from {legacy-dir}/{module-code}/ and
{legacy-dir}/core/. Only the current module and core are touched.

Exit codes: 0=success, 1=validation error, 2=runtime error
"""

import argparse
import csv
import json
import sys
from io import StringIO
from pathlib import Path

# Canonical CSV header. Columns are positional; cols 9/10 use the canonical
# `preceded-by`/`followed-by` names that bmad-help parses (NOT the legacy
# `after`/`before` divergence). bmad-help reads sequencing BY COLUMN NAME.
HEADER = [
    "module",
    "skill",
    "display-name",
    "menu-code",
    "description",
    "action",
    "args",
    "phase",
    "preceded-by",
    "followed-by",
    "required",
    "output-location",
    "outputs",
]

# A prior broken eque2-code install wrote this divergent header (cols 9/10
# named after/before). Positionally identical to HEADER, so it is safe to
# forward-repair to canonical on merge (D10).
LEGACY_HEADER = HEADER[:8] + ["after", "before"] + HEADER[10:]


def parse_args():
    parser = argparse.ArgumentParser(
        description="Merge module help entries into shared _bmad/module-help.csv with anti-zombie pattern."
    )
    parser.add_argument(
        "--target",
        required=True,
        help="Path to the target _bmad/module-help.csv file",
    )
    parser.add_argument(
        "--source",
        required=True,
        help="Path to the source module-help.csv with entries to merge",
    )
    parser.add_argument(
        "--legacy-dir",
        help="Path to _bmad/ directory to check for legacy per-module CSV files.",
    )
    parser.add_argument(
        "--module-code",
        help="Module code (required with --legacy-dir for scoping cleanup).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print detailed progress to stderr",
    )
    return parser.parse_args()


def read_csv_rows(path: str) -> tuple[list[str], list[list[str]]]:
    """Read CSV file returning (header, data_rows).

    Returns empty header and rows if file doesn't exist.
    """
    file_path = Path(path)
    if not file_path.exists():
        return [], []

    with open(file_path, "r", encoding="utf-8", newline="") as f:
        content = f.read()

    reader = csv.reader(StringIO(content))
    rows = list(reader)

    if not rows:
        return [], []

    return rows[0], rows[1:]


def extract_module_codes(rows: list[list[str]]) -> set[str]:
    """Extract unique module codes from data rows."""
    codes = set()
    for row in rows:
        if row and row[0].strip():
            codes.add(row[0].strip())
    return codes


def filter_rows(rows: list[list[str]], module_code: str) -> list[list[str]]:
    """Remove all rows matching the given module code."""
    return [row for row in rows if not row or row[0].strip() != module_code]


def write_csv(path: str, header: list[str], rows: list[list[str]], verbose: bool = False) -> None:
    """Write header + rows to CSV file, creating parent dirs as needed."""
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)

    if verbose:
        print(f"Writing {len(rows)} data rows to {path}", file=sys.stderr)

    with open(file_path, "w", encoding="utf-8", newline="") as f:
        # LF line terminator (D12) — csv.writer defaults to \r\n, which would
        # leave the catalog CRLF. Keep it LF so it round-trips cleanly.
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(header)
        for row in rows:
            writer.writerow(row)


def cleanup_legacy_csvs(
    legacy_dir: str, module_code: str, verbose: bool = False
) -> list:
    """Delete legacy per-module module-help.csv files for this module and core only.

    Returns list of deleted file paths.
    """
    deleted = []
    for subdir in (module_code, "core"):
        legacy_path = Path(legacy_dir) / subdir / "module-help.csv"
        if legacy_path.exists():
            if verbose:
                print(f"Deleting legacy CSV: {legacy_path}", file=sys.stderr)
            legacy_path.unlink()
            deleted.append(str(legacy_path))
    return deleted


def reject_unsubstituted_token(args) -> None:
    """Fail loudly if any path argument still contains the literal {project-root} token.

    These args are real filesystem paths; the script does not expand {project-root}.
    A literal token resolves relative to cwd (often the skill dir) and silently writes
    a stray {project-root}/_bmad/... tree. Catch it here so the failure is never silent.
    """
    checks = [
        ("--target", args.target),
        ("--source", args.source),
        ("--legacy-dir", args.legacy_dir),
    ]
    offenders = [flag for flag, val in checks if val and "{project-root}" in val]
    if offenders:
        print(
            "Error: unsubstituted {project-root} token in path argument(s): "
            + ", ".join(offenders)
            + ". Substitute the absolute project root before invoking this script.",
            file=sys.stderr,
        )
        sys.exit(1)


def main():
    args = parse_args()
    reject_unsubstituted_token(args)

    # Read source entries
    source_header, source_rows = read_csv_rows(args.source)
    if not source_rows:
        print(f"Error: No data rows found in source {args.source}", file=sys.stderr)
        sys.exit(1)

    # Determine module codes being merged
    source_codes = extract_module_codes(source_rows)
    if not source_codes:
        print("Error: Could not determine module code from source rows", file=sys.stderr)
        sys.exit(1)

    # Source-purity guard (D10): the anti-zombie pass removes ALL target rows
    # matching each source module code. A stray foreign row in the source would
    # therefore wipe that module's legitimate base rows. When --module-code is
    # given, refuse any source that carries codes other than that one.
    if args.module_code and source_codes != {args.module_code}:
        print(
            f"Error: source {args.source} contains foreign module code(s) "
            f"{sorted(source_codes - {args.module_code})}; expected only "
            f"'{args.module_code}'. Aborting to avoid anti-zombie-wiping another "
            f"module's rows.",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.verbose:
        print(f"Source module codes: {source_codes}", file=sys.stderr)
        print(f"Source rows: {len(source_rows)}", file=sys.stderr)

    # Read existing target (may not exist)
    target_header, target_rows = read_csv_rows(args.target)
    target_existed = Path(args.target).exists()

    if args.verbose:
        print(f"Target exists: {target_existed}", file=sys.stderr)
        if target_existed:
            print(f"Existing target rows: {len(target_rows)}", file=sys.stderr)

    # Header-compatibility guard (D10). The merge is positional, so the written
    # header must match the column order of the appended rows.
    #   - target absent          → write the canonical HEADER (fresh-create).
    #   - target canonical       → keep it (the base catalog's own header).
    #   - target legacy a/b      → forward-repair to canonical (positionally identical).
    #   - target unknown order   → fail loud rather than misalign data.
    if target_existed and target_header:
        if target_header == HEADER:
            header = target_header
        elif target_header == LEGACY_HEADER:
            if args.verbose:
                print(
                    "Forward-repairing legacy after/before header to canonical "
                    "preceded-by/followed-by",
                    file=sys.stderr,
                )
            header = HEADER
        else:
            print(
                f"Error: target {args.target} has an unrecognized column order; "
                f"refusing to append positionally-merged rows that could misalign.\n"
                f"  target header: {target_header}\n"
                f"  expected:      {HEADER}",
                file=sys.stderr,
            )
            sys.exit(1)
    else:
        header = HEADER

    # Anti-zombie: remove all rows for each source module code
    filtered_rows = target_rows
    removed_count = 0
    for code in source_codes:
        before_count = len(filtered_rows)
        filtered_rows = filter_rows(filtered_rows, code)
        removed_count += before_count - len(filtered_rows)

    if args.verbose and removed_count > 0:
        print(f"Removed {removed_count} existing rows (anti-zombie)", file=sys.stderr)

    # Append source rows
    merged_rows = filtered_rows + source_rows

    # Write result
    write_csv(args.target, header, merged_rows, args.verbose)

    # Legacy cleanup: delete old per-module CSV files
    legacy_deleted = []
    if args.legacy_dir:
        if not args.module_code:
            print(
                "Error: --module-code is required when --legacy-dir is provided",
                file=sys.stderr,
            )
            sys.exit(1)
        legacy_deleted = cleanup_legacy_csvs(
            args.legacy_dir, args.module_code, args.verbose
        )

    # Output result summary as JSON
    result = {
        "status": "success",
        "target_path": str(Path(args.target).resolve()),
        "target_existed": target_existed,
        "module_codes": sorted(source_codes),
        "rows_removed": removed_count,
        "rows_added": len(source_rows),
        "total_rows": len(merged_rows),
        "legacy_csvs_deleted": legacy_deleted,
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
