#!/usr/bin/env bash
# acs-format-check.sh — normative format checker for ACs.md.
#
# Contract: {skills-root}/eque2-code-prepare-goal/references/acs-format.md
#
# Usage:
#   acs-format-check.sh [--authoring] <ACs.md path>
#
# Validates the STRUCTURE of an acceptance-criteria file and, when valid, prints
# machine-readable counts to stdout:
#
#   total=<n>
#   checked=<n>
#   unchecked=<n>
#   blocked=<n>
#   critical=<n>
#   critical_unchecked=<n>
#
# On ANY problem it prints an `acs-format:` diagnostic to stderr and exits
# non-zero. There is no silent failure path and no unknown that resolves to
# "met": an unreadable, empty, malformed or criterion-free file is NOT done.
#
# THE THIRD STATE. `- [!] ` is BLOCKED: a criterion that genuinely cannot be
# met, carrying a non-empty `- blocked:` reason. It is neither met nor
# outstanding — it stops driving the nudge and never buys a pass. `[!]` rather
# than `[-]` because `[-]` already reads as "partially done" in some markdown
# flavours and is already listed as checkbox-like prose in parse-acs.sh; an
# ambiguous token is the wrong one to make load-bearing. This layer owns LEXICAL
# conformance only — counting and the verdict belong to parse-acs.sh, and
# enforcement to validate-acs.sh.
#
# --authoring relaxes ONE rule: unticked criteria need not yet carry an
# `explanation:` line. It is for a freshly emitted checklist, before the
# completion loop has run an iteration. The default (strict) is fail-closed. It
# never relaxes the blocked-reason rule: a blocker is written down when it is
# discovered, which is never "before the loop has run".
#
# Exit codes:
#   0  valid
#   2  no criteria found (the vacuous-truth trap) — zero criteria is NEVER "done"
#   3  input missing, not a regular file, or unreadable
#   4  format error (bad checkbox syntax, missing/surrogate system reference,
#      field on the wrong state, malformed field)
#   5  ticked-without-evidence
#   6  unticked-without-explanation
#   8  blocked-without-reason — 8 and not 7 because validate-acs.sh already uses
#      7 for evidence-not-substantive and the gate maps both delegates' codes
#      through one table; reusing 7 would blur two different refusals at the one
#      place that has to tell them apart
#   64 usage error

acs_die() {
	local code="$1"
	shift
	printf 'acs-format: %s\n' "$*" >&2
	return "$code"
}

# acs_report <line-number> <message>
acs_report() {
	printf 'acs-format: line %s: %s\n' "$1" "$2" >&2
}

# acs_reference_ok <criterion-text>
#
# Every criterion must name its specified system: a backtick-quoted path, entry
# point, or command. Prose alone is not a reference.
acs_reference_ok() {
	local text="$1" ref
	# Extract the first backtick-quoted span.
	case "$text" in
	*'`'*'`'*) : ;;
	*) return 1 ;;
	esac
	ref="${text#*\`}"
	ref="${ref%%\`*}"
	[ -n "$ref" ] || return 1
	# A reference must look like a path or an invocable entry point: it contains
	# a directory separator or a filename extension.
	case "$ref" in
	*/* | *.*) return 0 ;;
	*) return 1 ;;
	esac
}

# acs_reference_is_surrogate <criterion-text>
#
# The load-bearing rule: a criterion satisfied by a stand-in is a format error,
# not a pass. A reference naming a surrogate is refused outright, so the brief's
# quoted failure ("a testable surrogate standing in for the specified system")
# cannot be written down as a met criterion in the first place.
acs_reference_is_surrogate() {
	local ref lower
	ref="${1#*\`}"
	ref="${ref%%\`*}"
	lower="$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]')"
	# `standin` is matched WITH A WORD BOUNDARY, unlike the rest. As a bare
	# substring it fires inside "outstanding" — this system's own core
	# vocabulary — so evidence quoting the gate's own "N outstanding" output was
	# refused as surrogate-evidenced. The other tokens stay substring matches on
	# purpose: `mock-runner.sh`, `stubbed_api.py` and `fake-s3` are exactly the
	# stand-ins the rule exists to catch, and they appear glued to other words.
	case "$lower" in
	*mock* | *stub* | *fake* | *dummy* | *surrogate* | *stand-in* | \
		*placeholder* | *sample* | *example* | *simulated* | *toy*)
		return 0
		;;
	esac
	if [[ "$lower" =~ (^|[^a-z])standin([^a-z]|$) ]]; then
		return 0
	fi
	return 1
}

# acs_field_value <line> <field-name>
#
# Echoes the value of an indented `- <field>:` line, or nothing.
acs_field_value() {
	local line="$1" field="$2" value
	value="${line#*"$field":}"
	# Trim leading/trailing whitespace.
	value="${value#"${value%%[![:space:]]*}"}"
	value="${value%"${value##*[![:space:]]}"}"
	printf '%s' "$value"
}

# acs_format_check [--authoring] <path>
acs_format_check() {
	local authoring=0 file=""
	local line lineno=0
	local total=0 checked=0 unchecked=0 blocked=0 critical=0 critical_unchecked=0
	local errors=0 missing_evidence=0 missing_explanation=0 missing_reason=0
	local cur_state="" cur_line=0 cur_has_evidence=0 cur_has_explanation=0
	local cur_has_blocked=0
	# Set while inside an INDENTED task item — an illustration, not a criterion.
	# Its field lines are ignored with it, so worked examples (in the template,
	# in prose) can be written out in full without becoming orphan fields.
	local ignored_item=0

	while [ "$#" -gt 0 ]; do
		case "$1" in
		--authoring)
			authoring=1
			shift
			;;
		--)
			shift
			break
			;;
		-*) acs_die 64 "unknown option: $1" || return ;;
		*) break ;;
		esac
	done

	if [ "$#" -ne 1 ]; then
		acs_die 64 "usage: acs-format-check.sh [--authoring] <ACs.md path>" || return
	fi
	file="$1"

	if [ -z "$file" ]; then
		acs_die 3 "empty ACs.md path" || return
	fi
	if [ -d "$file" ]; then
		acs_die 3 "is a directory, not an ACs.md file: $file" || return
	fi
	if [ ! -e "$file" ]; then
		acs_die 3 "no such ACs.md file: $file" || return
	fi
	if [ ! -f "$file" ]; then
		acs_die 3 "not a regular file: $file" || return
	fi
	if [ ! -r "$file" ]; then
		acs_die 3 "ACs.md is not readable: $file" || return
	fi

	# close_criterion — apply the per-state field rules to the criterion that
	# has just ended.
	close_criterion() {
		[ -n "$cur_state" ] || return 0
		if [ "$cur_state" = "checked" ]; then
			if [ "$cur_has_evidence" -eq 0 ]; then
				acs_report "$cur_line" "ticked-without-evidence: a ticked criterion must carry a non-empty 'evidence:' line"
				missing_evidence=$((missing_evidence + 1))
			fi
			if [ "$cur_has_explanation" -eq 1 ]; then
				acs_report "$cur_line" "a ticked criterion must not carry an 'explanation:' line"
				errors=$((errors + 1))
			fi
			if [ "$cur_has_blocked" -eq 1 ]; then
				acs_report "$cur_line" "a ticked criterion must not carry a 'blocked:' line"
				errors=$((errors + 1))
			fi
		elif [ "$cur_state" = "blocked" ]; then
			# The reason is NOT relaxable by --authoring: a blocker with no
			# stated reason is indistinguishable from an escape hatch, which is
			# exactly what this state must not become.
			if [ "$cur_has_blocked" -eq 0 ]; then
				acs_report "$cur_line" "blocked-without-reason: a blocked criterion must carry a non-empty 'blocked:' line"
				missing_reason=$((missing_reason + 1))
			fi
			if [ "$cur_has_evidence" -eq 1 ]; then
				acs_report "$cur_line" "a blocked criterion must not carry an 'evidence:' line"
				errors=$((errors + 1))
			fi
			if [ "$cur_has_explanation" -eq 1 ]; then
				acs_report "$cur_line" "a blocked criterion must not carry an 'explanation:' line"
				errors=$((errors + 1))
			fi
		else
			if [ "$cur_has_evidence" -eq 1 ]; then
				acs_report "$cur_line" "an unticked criterion must not carry an 'evidence:' line"
				errors=$((errors + 1))
			fi
			if [ "$cur_has_blocked" -eq 1 ]; then
				acs_report "$cur_line" "an unticked criterion must not carry a 'blocked:' line"
				errors=$((errors + 1))
			fi
			if [ "$cur_has_explanation" -eq 0 ] && [ "$authoring" -eq 0 ]; then
				acs_report "$cur_line" "unticked-without-explanation: an unmet criterion must carry a written 'explanation:' line"
				missing_explanation=$((missing_explanation + 1))
			fi
		fi
		cur_state=""
	}

	while IFS= read -r line || [ -n "$line" ]; do
		lineno=$((lineno + 1))

		case "$line" in
		# ---- A criterion: a top-level markdown task-list item -------------
		# ---- An INDENTED task item: an illustration, never a criterion ----
		[[:space:]]*"- ["*)
			close_criterion
			ignored_item=1
			;;

		"- ["*)
			close_criterion
			ignored_item=0
			local box rest
			case "$line" in
			"- [ ] "* | "- [x] "* | "- [!] "*) : ;;
			*)
				acs_report "$lineno" "malformed checkbox syntax (expected '- [ ] ', '- [x] ' or '- [!] '): $line"
				errors=$((errors + 1))
				continue
				;;
			esac
			# `- [x] ` is six characters: the state is at index 3, the text at 6.
			box="${line:3:1}"
			rest="${line:6}"

			total=$((total + 1))
			cur_line=$lineno
			cur_has_evidence=0
			cur_has_explanation=0
			cur_has_blocked=0

			local is_critical=0
			case "$rest" in
			'**CRITICAL** '*)
				is_critical=1
				critical=$((critical + 1))
				rest="${rest#'**CRITICAL** '}"
				;;
			*'**CRITICAL**'*)
				acs_report "$lineno" "the critical marker must be exactly '**CRITICAL** ' immediately after the checkbox"
				errors=$((errors + 1))
				;;
			esac

			if [ -z "${rest//[[:space:]]/}" ]; then
				acs_report "$lineno" "criterion has no text"
				errors=$((errors + 1))
			elif ! acs_reference_ok "$rest"; then
				acs_report "$lineno" "criterion names no specified system: it must reference a real path, entry point, or command in backticks"
				errors=$((errors + 1))
			elif acs_reference_is_surrogate "$rest"; then
				acs_report "$lineno" "surrogate-reference: criterion is phrased against a stand-in, not the specified system"
				errors=$((errors + 1))
			fi

			if [ "$box" = "x" ]; then
				cur_state="checked"
				checked=$((checked + 1))
			elif [ "$box" = "!" ]; then
				# Blocked is neither met nor outstanding. It is deliberately
				# absent from BOTH `checked` and `unchecked` — that exclusion is
				# what stops it driving the nudge, and its absence from `checked`
				# is what stops it buying a pass. `critical_unchecked` counts
				# critical AND outstanding, so a blocked critical is not in it;
				# `critical` still counts it, so a consumer can still see that
				# the load-bearing criterion is the blocked one.
				cur_state="blocked"
				blocked=$((blocked + 1))
			else
				cur_state="unchecked"
				unchecked=$((unchecked + 1))
				if [ "$is_critical" -eq 1 ]; then
					critical_unchecked=$((critical_unchecked + 1))
				fi
			fi
			;;

		# ---- An indented field line belonging to the current criterion ----
		[[:space:]]*"- evidence:"*)
			if [ -z "$cur_state" ]; then
				if [ "$ignored_item" -eq 0 ]; then
					acs_report "$lineno" "'evidence:' line does not belong to any criterion"
					errors=$((errors + 1))
				fi
			else
				local value
				value="$(acs_field_value "$line" "evidence")"
				if [ -z "$value" ]; then
					acs_report "$lineno" "ticked-without-evidence: 'evidence:' is empty"
					missing_evidence=$((missing_evidence + 1))
					# Mark it seen so close_criterion does not double-report.
					cur_has_evidence=1
				else
					cur_has_evidence=1
				fi
			fi
			;;

		[[:space:]]*"- blocked:"*)
			if [ -z "$cur_state" ]; then
				if [ "$ignored_item" -eq 0 ]; then
					acs_report "$lineno" "'blocked:' line does not belong to any criterion"
					errors=$((errors + 1))
				fi
			else
				local value
				value="$(acs_field_value "$line" "blocked")"
				if [ -z "$value" ]; then
					acs_report "$lineno" "blocked-without-reason: 'blocked:' is empty"
					missing_reason=$((missing_reason + 1))
					# Mark it seen so close_criterion does not double-report.
					cur_has_blocked=1
				else
					cur_has_blocked=1
				fi
			fi
			;;

		[[:space:]]*"- explanation:"*)
			if [ -z "$cur_state" ]; then
				if [ "$ignored_item" -eq 0 ]; then
					acs_report "$lineno" "'explanation:' line does not belong to any criterion"
					errors=$((errors + 1))
				fi
			else
				local value
				value="$(acs_field_value "$line" "explanation")"
				if [ -z "$value" ]; then
					acs_report "$lineno" "unticked-without-explanation: 'explanation:' is empty"
					missing_explanation=$((missing_explanation + 1))
					cur_has_explanation=1
				else
					cur_has_explanation=1
				fi
			fi
			;;

		# ---- A blank line does NOT end a criterion; any other unindented
		#      non-list content does. ---------------------------------------
		"") : ;;
		[[:space:]]*) : ;;
		*)
			close_criterion
			ignored_item=0
			;;
		esac
	done <"$file"

	close_criterion

	# ---- Precedence ------------------------------------------------------
	# Format errors are reported before the zero-criteria verdict. A file whose
	# only criterion is malformed has BOTH problems, and "your checkbox syntax
	# is wrong" is the actionable one — "no criteria found" would send the
	# author looking for a missing criterion that is in fact right there. Both
	# are non-zero and both mean NOT done, so precedence trades no safety.
	if [ "$errors" -gt 0 ]; then
		acs_die 4 "$errors format error(s) in $file" || return
	fi

	# ---- The vacuous-truth trap ------------------------------------------
	# Zero criteria is an ERROR, never "all complete".
	if [ "$total" -eq 0 ]; then
		acs_die 2 "no criteria found in $file — zero criteria is not 'all complete'" || return
	fi
	if [ "$missing_evidence" -gt 0 ]; then
		acs_die 5 "ticked-without-evidence: $missing_evidence ticked criterion(s) in $file carry no evidence" || return
	fi
	if [ "$missing_explanation" -gt 0 ]; then
		acs_die 6 "unticked-without-explanation: $missing_explanation unmet criterion(s) in $file carry no explanation" || return
	fi
	if [ "$missing_reason" -gt 0 ]; then
		acs_die 8 "blocked-without-reason: $missing_reason blocked criterion(s) in $file state no reason" || return
	fi

	printf 'total=%d\n' "$total"
	printf 'checked=%d\n' "$checked"
	printf 'unchecked=%d\n' "$unchecked"
	printf 'blocked=%d\n' "$blocked"
	printf 'critical=%d\n' "$critical"
	printf 'critical_unchecked=%d\n' "$critical_unchecked"
}

acs_format_main() {
	case "${1-}" in
	-h | --help)
		sed -n '2,/^#   64 usage error$/p' "$0"
		return 0
		;;
	esac
	acs_format_check "$@"
}

# Only run when executed, not when sourced. `set -e` is scoped to execution so
# that sourcing this file never changes the caller's shell mode.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -euo pipefail
	acs_format_main "$@"
fi
