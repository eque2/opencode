#!/usr/bin/env bash
# charter-check.sh — the charter and its acceptance contract agree (T4.2, S5).
#
# Usage:
#   charter-check.sh <goal-folder>
#   charter-check.sh --help
#
# WHY THIS EXISTS. `goal.md` carries a POINTER to `ACs.md` and a summary of it;
# `ACs.md` carries the criteria. The gate reads only `ACs.md`. So a charter that
# restates the checklist, or claims a count that no longer matches, produces the
# quietest possible failure: the charter says one thing, the gate enforces
# another, and a human reading the charter is reading a document that stopped
# being true without anything breaking.
#
# Counting is DELEGATED to parse-acs.sh, the single source of verdict truth.
# Re-implementing the count here would create a second answer to the one
# question this script exists to check the agreement of.
#
# Exit codes:
#   0   the charter and its criteria file agree
#   2   invalid input (not a prepared goal folder)
#   3   the criteria file could not be parsed, so agreement is UNKNOWN — which
#       is reported, never assumed to be agreement
#   4   drift: the charter disagrees with its criteria file — a restated
#       checkbox (any state, blocked included), a missing ./ACs.md link, or a
#       claimed "(N criteria)" / "(N blocked)" count that no longer matches
#   64  usage error

CC_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CC_PARSE_ACS="${GOAL_GATE_PARSE_ACS:-$CC_SELF_DIR/parse-acs.sh}"

cc_die() {
	local code="$1"
	shift
	printf 'charter-check: %s\n' "$*" >&2
	return "$code"
}

cc_main() {
	local folder="${1-}" charter acs total blocked claimed claimed_blocked problems=0

	case "$folder" in
	-h | --help)
		sed -n '2,/^#   64  usage error$/p' "$0"
		return 0
		;;
	esac

	if [ -z "$folder" ]; then
		cc_die 64 "usage: charter-check.sh <goal-folder>" || return
	fi
	if [ ! -d "$folder" ]; then
		cc_die 2 "not a directory: $folder" || return
	fi

	charter="$folder/goal.md"
	acs="$folder/ACs.md"

	for f in "$charter" "$acs"; do
		if [ ! -f "$f" ]; then
			cc_die 2 "not a prepared goal folder — missing $(basename -- "$f"): $folder" || return
		fi
		if [ ! -r "$f" ]; then
			cc_die 2 "cannot read $(basename -- "$f"): $f" || return
		fi
	done

	# --- the count, from the one source of truth --------------------------
	local parse_out parse_rc=0
	parse_out="$(bash "$CC_PARSE_ACS" "$acs" 2>/dev/null)" || parse_rc=$?

	case "$parse_rc" in
	0 | 1) : ;;
	*)
		cc_die 3 "$acs could not be parsed (parse-acs exit $parse_rc), so whether the charter agrees with it is UNKNOWN. Reported rather than assumed." || return
		;;
	esac

	total="$(printf '%s\n' "$parse_out" | sed -n 's/^total=//p')"
	case "$total" in
	'' | *[!0-9]*)
		cc_die 3 "parse-acs produced no usable total for $acs, so agreement is UNKNOWN." || return
		;;
	esac

	# Taken from the parser's output, never inferred here — a second answer to
	# "how many are blocked?" is exactly the drift this script exists to catch.
	# An older parser emits no `blocked=` at all; that reads as zero, which keeps
	# a two-state charter behaving precisely as it did before.
	blocked="$(printf '%s\n' "$parse_out" | sed -n 's/^blocked=//p')"
	case "$blocked" in
	'') blocked=0 ;;
	*[!0-9]*)
		cc_die 3 "parse-acs produced an unusable blocked count for $acs, so agreement is UNKNOWN." || return
		;;
	esac

	# --- the charter must not restate the checklist -----------------------
	#
	# Two copies drift. This is the check that stops the second copy existing
	# at all, rather than trying to keep two copies in step forever.
	local restated
	# `!` is in the class alongside ` `, `x` and `X`: a charter that restated a
	# BLOCKED criterion would otherwise slip past the one check that stops a
	# second copy of the checklist existing — and a stale blocked box in a
	# charter is the most misleading copy of all, since it claims work was
	# abandoned for a reason nobody re-read.
	restated="$(grep -cE '^[[:space:]]*[-*+][[:space:]]+\[[ xX!]\]' "$charter" 2>/dev/null)" || restated=0
	if [ "$restated" -gt 0 ]; then
		printf 'charter-check: DRIFT — goal.md restates %s checkbox criterion(s). The boxes belong in ACs.md; the charter links them.\n' \
			"$restated" >&2
		problems=$((problems + 1))
	fi

	# --- the charter must link the criteria file, relatively --------------
	if ! grep -qF './ACs.md' "$charter" 2>/dev/null; then
		printf 'charter-check: DRIFT — goal.md does not link its acceptance contract as ./ACs.md, so the folder does not move as a unit.\n' >&2
		problems=$((problems + 1))
	fi

	# --- a claimed count, if present, must match --------------------------
	claimed="$(sed -n 's/.*(\([0-9][0-9]*\) criteria).*/\1/p' "$charter" | head -1)"
	if [ -n "$claimed" ] && [ "$claimed" != "$total" ]; then
		printf 'charter-check: DRIFT — goal.md claims %s criteria; ACs.md holds %s.\n' "$claimed" "$total" >&2
		problems=$((problems + 1))
	fi

	# A charter MAY state how many criteria are blocked. If it does, it must be
	# right — an out-of-date "(2 blocked)" is a charter telling a reader that work
	# was abandoned that has since been unblocked, or the reverse.
	claimed_blocked="$(sed -n 's/.*(\([0-9][0-9]*\) blocked).*/\1/p' "$charter" | head -1)"
	if [ -n "$claimed_blocked" ] && [ "$claimed_blocked" != "$blocked" ]; then
		printf 'charter-check: DRIFT — goal.md claims %s blocked; ACs.md holds %s.\n' "$claimed_blocked" "$blocked" >&2
		problems=$((problems + 1))
	fi

	if [ "$problems" -gt 0 ]; then
		cc_die 4 "$problems disagreement(s) between $charter and $acs" || return
	fi

	# With nothing blocked the line is byte-for-byte what it has always been, so
	# a two-state charter sees no change at all.
	if [ "$blocked" -gt 0 ]; then
		printf 'charter-check: %s and its %s criteria in ACs.md agree (%s blocked)\n' \
			"$(basename -- "$charter")" "$total" "$blocked"
	else
		printf 'charter-check: %s and its %s criteria in ACs.md agree\n' "$(basename -- "$charter")" "$total"
	fi
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -uo pipefail
	cc_main "$@"
	exit $?
fi
