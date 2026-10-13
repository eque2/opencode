#!/usr/bin/env bash
# validate-acs.sh — the gate-side ACs.md validator: enforcement + decision trail.
#
# Contract: {skills-root}/eque2-code-prepare-goal/references/acs-format.md
#
# Usage:
#   validate-acs.sh [--authoring] [--require-critical] [--quiet] <ACs.md path>
#
# WHAT THIS RESOLVES (review finding R12)
#   "Permit only when met AND evidenced" was previously undefined, so the gate
#   reduced to counting boxes the agent under test had ticked itself. This script
#   is the definition of "AND evidenced".
#
# HONEST LIMIT — READ THIS BEFORE TRUSTING A GREEN RUN
#   This validator checks the PRESENCE and the SHAPE of evidence. It does NOT
#   and CANNOT check its TRUTHFULNESS. It has no way to know whether a command
#   in an `evidence:` line was ever really run, or whether the output quoted
#   beside it was ever really produced. What it buys is not proof of execution;
#   it is integrity of record:
#     * no criterion can be marked met silently;
#     * the cost of a false tick rises from "type an x" to "fabricate a command
#       and its plausible output";
#     * every such fabrication becomes a durable, attributable, greppable
#       artefact in the repository, cheap for a human or a later gate to audit.
#   Treat a pass as "the claim is on the record in auditable form", never as
#   "the claim is true".
#
# LAYERING — this script CONSUMES its two predecessors and re-implements neither
#   acs-format-check.sh (T1.2) owns LEXICAL conformance of one file: checkbox
#     syntax, the specified-system reference, surrogate references, the
#     `**CRITICAL**` marker's placement, and the PRESENCE of evidence and
#     explanation. Its exit code is authoritative and is propagated unchanged.
#   parse-acs.sh (T1.3) owns COUNTING and the VERDICT. Its counts are
#     authoritative. It deliberately counts evidence/explanation lines WITHOUT
#     enforcing them.
#   THIS script owns ENFORCEMENT of what neither of those enforces, plus the
#     per-criterion decision trail and the gate wiring:
#       * evidence SUBSTANCE — an `evidence:` value that is prose alone, naming
#         no command, no observed result and no artefact, is refused (exit 7);
#       * evidence naming a SURROGATE — a tick evidenced by a mock/stub/fake is
#         refused (exit 7), mirroring §3.3 on the evidence side;
#       * SEPARATE reporting of unticked-without-explanation from
#         unticked-with-explanation, so the two are never conflated in a count;
#       * an optional `--require-critical` policy (see below).
#
#   This script's own line scan exists ONLY to build the decision trail. Where it
#   and parse-acs.sh disagree on the number of criteria, that is an internal
#   inconsistency and the run FAILS CLOSED (exit 3) rather than emitting a trail
#   that does not describe the file the verdict was computed from.
#
# THE CRITICAL MARKER — a deliberate, recorded reconciliation
#   The task brief for this script asks that "every criterion carries the
#   critical-importance marker". The NORMATIVE contract (§3.2) makes the marker
#   optional and reporting-only. Rather than silently contradict the normative
#   document, the rule ships as a real, executable, tested policy flag
#   --require-critical whose DEFAULT is off. With the flag, a criterion carrying
#   no `**CRITICAL** ` marker is a format error (exit 4).
#
# --authoring relaxes exactly ONE rule, as §5 specifies: an unticked criterion
#   need not yet carry an `explanation:`. It is for a freshly emitted checklist,
#   before the completion loop has run an iteration. Nothing else is relaxed —
#   in particular a TICKED criterion still requires substantive evidence, in
#   authoring mode as everywhere else.
#
# SECURITY — evidence text is NEVER evaluated as shell.
#   Evidence values are matched with bash `case` patterns and parameter
#   expansion only. There is no eval, no command substitution, no unquoted
#   expansion, and no arithmetic evaluation applied to any text read from the
#   file. `$(...)`, backticked commands, `;`, `&&` and shell metacharacters in an
#   evidence line are inert data.
#
# STDOUT DISCIPLINE — inherited from parse-acs.sh and load-bearing.
#   The trail and the counts are printed ONLY on exit 0 and exit 1. Every other
#   exit prints NOTHING to stdout and a `validate-acs:` diagnostic to stderr, so
#   a non-empty stdout implies a trustworthy validation and a done verdict can
#   only ever be observed on exit 0.
#
# FAIL CLOSED. Every unknown, error, missing input or unrunnable check resolves
#   to NOT DONE. A ticked-but-unevidenced criterion NEVER counts as met.
#
# Exit codes:
#   0  valid, and every criterion is met and evidenced
#   1  valid, but the checklist is not done — either unticked criteria remain
#      (not_done) or nothing is outstanding and something is BLOCKED (partial).
#      Both share exit 1 because both are not-a-pass; consumers branch on
#      `verdict=`/`blocked=`, never on the exit code.
#   2  zero criteria, or an empty file — never "all complete"
#   3  input missing, a directory, a symlink, unreadable, changed during the
#      read, or an internal inconsistency between this scan and parse-acs.sh
#   4  format error (delegated: checkbox syntax, missing/surrogate system
#      reference, misplaced field, `**CRITICAL**` placement; or, under
#      --require-critical, a criterion with no marker)
#   5  ticked-without-evidence — a tick carrying no evidence, or empty evidence.
#      Checked BEFORE the delegated format check, so this rule is never
#      generalised away into a plain exit 4 when it coincides with another fault.
#   6  unticked-without-explanation
#   7  evidence-not-substantive, or evidence naming a surrogate
#   8  blocked-without-reason — a `- [!] ` criterion stating no reason. Distinct
#      from 7 because the gate maps both delegates' codes through one table and
#      must be able to name THIS refusal: a reasonless blocker stops driving the
#      nudge, so an anonymous refusal would silence the loop without saying why.
#      The reason itself is prose and is NOT put through the evidence-substance
#      or surrogate rules — those belong to `evidence:`, where the claim is "I
#      did this", not to `blocked:`, where the claim is "I cannot".
#   64 usage error
# ---------------------------------------------------------------------------

VACS_TAB=$'\t'

# --------------------------------------------------------------------------
# Diagnostics
# --------------------------------------------------------------------------

# vacs_die <exit-code> <message...>
vacs_die() {
	local code="$1"
	shift
	printf 'validate-acs: %s\n' "$*" >&2
	return "$code"
}

# vacs_report <line-number> <message...>
vacs_report() {
	local lineno="$1"
	shift
	printf 'validate-acs: line %s: %s\n' "$lineno" "$*" >&2
}

# --------------------------------------------------------------------------
# Text helpers — pure parameter expansion, never evaluation
# --------------------------------------------------------------------------

# vacs_trim <text> -> sets VACS_TRIMMED
vacs_trim() {
	local v="$1"
	v="${v#"${v%%[![:space:]]*}"}"
	v="${v%"${v##*[![:space:]]}"}"
	VACS_TRIMMED="$v"
}

# vacs_indent <line> -> sets VACS_INDENT
#
# Leading columns, a tab advancing to the next multiple of 4. Mirrors
# parse-acs.sh so the two agree on what is a top-level item; a disagreement
# here would desynchronise the trail from the verdict.
vacs_indent() {
	local line="$1" i=0 col=0 ch n
	n=${#line}
	while [ "$i" -lt "$n" ]; do
		ch="${line:i:1}"
		if [ "$ch" = " " ]; then
			col=$((col + 1))
		elif [ "$ch" = "$VACS_TAB" ]; then
			col=$((col + 4 - col % 4))
		else
			break
		fi
		i=$((i + 1))
	done
	VACS_INDENT="$col"
}

# vacs_looks_like_reference <text>
#
# A path, entry point or command: it carries a directory separator or a
# filename extension. Same shape rule as §3.3, applied here to EVIDENCE.
vacs_looks_like_reference() {
	case "$1" in
	*/* | *.*) return 0 ;;
	esac
	return 1
}

# vacs_is_surrogate <text>
#
# The §3.3 surrogate vocabulary, applied to an evidence reference. A criterion
# that names the real system but is evidenced by a stand-in is the brief's
# failure wearing a disguise, so it is refused on the evidence side too.
vacs_is_surrogate() {
	local lower
	lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
	# `standin` is matched WITH A WORD BOUNDARY, unlike the rest. As a bare
	# substring it fires inside "outstanding" — this system's own core
	# vocabulary — so evidence quoting the gate's own "N outstanding" output was
	# refused as surrogate-evidenced. The other tokens stay substring matches on
	# purpose: `mock-runner.sh`, `stubbed_api.py` and `fake-s3` are exactly the
	# stand-ins the rule exists to catch, and they appear glued to other words.
	case "$lower" in
	*mock* | *stub* | *fake* | *dummy* | *surrogate* | *stand-in* | \
		*placeholder* | *simulated* | *toy*)
		return 0
		;;
	esac
	if [[ "$lower" =~ (^|[^a-z])standin([^a-z]|$) ]]; then
		return 0
	fi
	return 1
}

# vacs_evidence_verdict <evidence-value> -> sets VACS_EVIDENCE_VERDICT
#
# Classifies an evidence value as one of: substantive | surrogate | prose.
#
# Substantive means the value carries at least one of:
#   (a) a backtick-quoted span that looks like a path, command or artefact,
#   (b) an explicit exit-status report ("exit 2"),
#   (c) a command-to-result arrow ("->" or "→").
#
# The bar is deliberately shape-based, not semantic: it is what separates
# "`bash run-all.sh` -> `ok` (exit 0)" from "I checked it and it works". It
# cannot tell a real transcript from an invented one — see the HONEST LIMIT
# banner. Every test below is a `case` match on inert data; nothing is executed.
vacs_evidence_verdict() {
	local value="$1" rest ref
	VACS_EVIDENCE_VERDICT="prose"

	# ---- Surrogate check first: it OVERRIDES substance -------------------
	# Otherwise "`mock-runner.sh` -> ok (exit 0)" would pass on its arrow and
	# its exit code while evidencing nothing about the specified system.
	rest="$value"
	while :; do
		case "$rest" in
		*'`'*'`'*) : ;;
		*) break ;;
		esac
		ref="${rest#*\`}"
		ref="${ref%%\`*}"
		if [ -n "$ref" ] && vacs_is_surrogate "$ref"; then
			VACS_EVIDENCE_VERDICT="surrogate"
			return 0
		fi
		rest="${rest#*\`}"
		rest="${rest#*\`}"
	done

	# ---- (a) a backticked path / command / artefact ----------------------
	rest="$value"
	while :; do
		case "$rest" in
		*'`'*'`'*) : ;;
		*) break ;;
		esac
		ref="${rest#*\`}"
		ref="${ref%%\`*}"
		if [ -n "$ref" ] && vacs_looks_like_reference "$ref"; then
			VACS_EVIDENCE_VERDICT="substantive"
			return 0
		fi
		rest="${rest#*\`}"
		rest="${rest#*\`}"
	done

	# ---- (b) an explicit exit status -------------------------------------
	case "$value" in
	*[Ee]xit' '[0-9]*)
		VACS_EVIDENCE_VERDICT="substantive"
		return 0
		;;
	esac

	# ---- (c) a command-to-result arrow -----------------------------------
	case "$value" in
	*'->'* | *'→'*)
		VACS_EVIDENCE_VERDICT="substantive"
		return 0
		;;
	esac

	return 0
}

# --------------------------------------------------------------------------
# The validator
# --------------------------------------------------------------------------

# vacs_validate [--authoring] [--require-critical] [--quiet] <path>
vacs_validate() {
	local authoring=0 require_critical=0 quiet=0 file=""
	local here parser checker
	local parse_out="" parse_status=0 fc_status=0
	local p_total="" p_checked="" p_unchecked="" p_blocked="" p_verdict=""
	local line raw_line lineno=0
	local in_fence=0 fence_marker="" in_comment=0 list_open=0
	local trimmed body box rest value
	local scan_total=0
	local cur_open=0 cur_line=0 cur_state="" cur_critical=0
	local cur_evidence="none" cur_explanation="none" cur_reason="none"
	local scan_blocked=0 blocked_with_reason=0 blocked_without_reason=0
	local ticked_with_evidence=0 ticked_without_evidence=0
	local unticked_with_explanation=0 unticked_without_explanation=0
	local evidence_not_substantive=0 evidence_surrogate=0
	local critical=0 critical_unchecked=0 missing_critical=0
	local trail="" exit_code

	while [ "$#" -gt 0 ]; do
		case "$1" in
		--authoring)
			authoring=1
			shift
			;;
		--require-critical)
			require_critical=1
			shift
			;;
		--quiet)
			quiet=1
			shift
			;;
		--)
			shift
			break
			;;
		-*) vacs_die 64 "unknown option: $1" || return ;;
		*) break ;;
		esac
	done

	if [ "$#" -ne 1 ]; then
		vacs_die 64 "usage: validate-acs.sh [--authoring] [--require-critical] [--quiet] <ACs.md path>" || return
	fi
	file="$1"

	here="$(dirname -- "${BASH_SOURCE[0]}")"
	parser="$here/parse-acs.sh"
	checker="$here/acs-format-check.sh"

	# An unrunnable check resolves to NOT DONE, never to "nothing to report".
	if [ ! -f "$parser" ]; then
		vacs_die 3 "cannot validate: no counting parser at $parser" || return
	fi
	if [ ! -f "$checker" ]; then
		vacs_die 3 "cannot validate: no format checker at $checker" || return
	fi

	# ---- Delegate COUNTING and the VERDICT to parse-acs.sh ---------------
	# Its input validation (missing, directory, symlink, encoding, concurrent
	# modification, zero criteria) is authoritative and its exit code is
	# propagated unchanged. Nothing is re-implemented here.
	parse_out="$(bash "$parser" "$file" 2>/dev/null)" || parse_status=$?
	if [ "$parse_status" -gt 1 ]; then
		# Re-run with stderr attached so the operator sees the real diagnostic,
		# then refuse in this script's own voice as well.
		bash "$parser" "$file" >/dev/null || true
		vacs_die "$parse_status" "refusing on delegated parse — parse-acs.sh rejected $file (exit $parse_status)" || return
	fi

	while IFS= read -r line; do
		case "$line" in
		verdict=*) p_verdict="${line#verdict=}" ;;
		total=*) p_total="${line#total=}" ;;
		checked=*) p_checked="${line#checked=}" ;;
		unchecked=*) p_unchecked="${line#unchecked=}" ;;
		blocked=*) p_blocked="${line#blocked=}" ;;
		esac
	done <<<"$parse_out"

	# An older parser that does not know the third state reports no `blocked=`
	# at all. Treat that as zero rather than as an error: this validator must
	# still run against a checklist with no blocked criteria in it.
	[ -n "$p_blocked" ] || p_blocked=0

	if [ -z "$p_total" ] || [ -z "$p_verdict" ]; then
		vacs_die 3 "delegated parse produced no usable counts for $file" || return
	fi

	# ---- The decision trail ----------------------------------------------
	# This scan does not compute the verdict; it explains it, criterion by
	# criterion. Its skip rules mirror parse-acs.sh so the two see the same set
	# of criteria, and the totals are reconciled below.

	# vacs_close — apply the per-state rules to the criterion that just ended.
	vacs_close() {
		[ "$cur_open" -eq 1 ] || return 0
		cur_open=0
		local decision="not_met" note=""

		if [ "$cur_state" = "checked" ]; then
			case "$cur_evidence" in
			substantive)
				ticked_with_evidence=$((ticked_with_evidence + 1))
				decision="met"
				note="evidence=substantive"
				;;
			surrogate)
				ticked_with_evidence=$((ticked_with_evidence + 1))
				evidence_surrogate=$((evidence_surrogate + 1))
				note="evidence=surrogate"
				vacs_report "$cur_line" "evidence-names-surrogate: a ticked criterion is evidenced against a stand-in, not the specified system"
				;;
			prose)
				ticked_with_evidence=$((ticked_with_evidence + 1))
				evidence_not_substantive=$((evidence_not_substantive + 1))
				note="evidence=prose"
				vacs_report "$cur_line" "evidence-not-substantive: 'evidence:' is prose alone — it must name a command, an observed result, or an artefact"
				;;
			empty)
				ticked_without_evidence=$((ticked_without_evidence + 1))
				note="evidence=empty"
				vacs_report "$cur_line" "ticked-without-evidence: 'evidence:' is empty"
				;;
			*)
				ticked_without_evidence=$((ticked_without_evidence + 1))
				note="evidence=absent"
				vacs_report "$cur_line" "ticked-without-evidence: a ticked criterion must carry a non-empty 'evidence:' line"
				;;
			esac
		elif [ "$cur_state" = "blocked" ]; then
			# `blocked` is its OWN decision, reported separately from both
			# `met` and `not_met`. Folding it into `not_met` would lose the
			# distinction the whole feature turns on — "outstanding" is work
			# still to do, "blocked" is work that cannot be done — and a count
			# that conflated them would put a blocker back into the nudge.
			decision="blocked"
			if [ "$cur_reason" = "present" ]; then
				blocked_with_reason=$((blocked_with_reason + 1))
				note="reason=present"
			else
				# Never relaxed by --authoring: see the `blocked:` field scan.
				blocked_without_reason=$((blocked_without_reason + 1))
				note="reason=absent"
				vacs_report "$cur_line" "blocked-without-reason: a blocked criterion must carry a non-empty 'blocked:' line"
			fi
		else
			decision="not_met"
			if [ "$cur_explanation" = "present" ]; then
				unticked_with_explanation=$((unticked_with_explanation + 1))
				note="explanation=present"
			else
				# Reported SEPARATELY from unticked-with-explanation: conflating
				# them would hide an unaccounted-for criterion inside a count of
				# properly accounted-for ones.
				note="explanation=absent"
				if [ "$authoring" -eq 0 ]; then
					unticked_without_explanation=$((unticked_without_explanation + 1))
					vacs_report "$cur_line" "unticked-without-explanation: an unmet criterion must carry a written 'explanation:' line"
				fi
			fi
		fi

		trail="${trail}criterion line=${cur_line} state=${cur_state} critical=${cur_critical} ${note} decision=${decision}"$'\n'
	}

	while IFS= read -r raw_line || [ -n "$raw_line" ]; do
		lineno=$((lineno + 1))
		line="${raw_line%$'\r'}"

		vacs_trim "$line"
		trimmed="$VACS_TRIMMED"

		# ---- Fenced code blocks (checked first, as in parse-acs.sh) ------
		if [ "$in_fence" -eq 1 ]; then
			case "$trimmed" in
			"$fence_marker"*) in_fence=0 ;;
			esac
			continue
		fi
		case "$trimmed" in
		'```'*)
			in_fence=1
			fence_marker='```'
			continue
			;;
		'~~~'*)
			in_fence=1
			fence_marker='~~~'
			continue
			;;
		esac

		# ---- HTML comments ----------------------------------------------
		if [ "$in_comment" -eq 1 ]; then
			case "$line" in
			*'-->'*) in_comment=0 ;;
			esac
			continue
		fi
		case "$line" in
		*'<!--'*'-->'*)
			line="${line%%<!--*}${line#*-->}"
			vacs_trim "$line"
			trimmed="$VACS_TRIMMED"
			;;
		*'<!--'*)
			in_comment=1
			continue
			;;
		esac

		# ---- Block quotes -----------------------------------------------
		case "$trimmed" in
		'>'*) continue ;;
		esac

		# A blank line ends nothing (§6).
		[ -n "$trimmed" ] || continue

		vacs_indent "$line"

		# 4+ columns outside an open list is an indented code block.
		if [ "$VACS_INDENT" -ge 4 ] && [ "$list_open" -eq 0 ]; then
			continue
		fi

		body="$trimmed"

		case "$body" in
		'- ['*)
			list_open=1
			if [ "$VACS_INDENT" -gt 0 ]; then
				# An indented task item is an illustration, never a criterion.
				# Its fields belong to it and are ignored with it.
				vacs_close
				continue
			fi
			vacs_close
			scan_total=$((scan_total + 1))
			cur_open=1
			cur_line=$lineno
			cur_evidence="none"
			cur_explanation="none"
			cur_reason="none"
			cur_critical=0

			box="${body:3:1}"
			rest="${body:6}"
			if [ "$box" = "x" ]; then
				cur_state="checked"
			elif [ "$box" = "!" ]; then
				cur_state="blocked"
				scan_blocked=$((scan_blocked + 1))
			else
				cur_state="unchecked"
			fi

			case "$rest" in
			'**CRITICAL** '*)
				cur_critical=1
				critical=$((critical + 1))
				[ "$cur_state" = "unchecked" ] && critical_unchecked=$((critical_unchecked + 1))
				;;
			*)
				if [ "$require_critical" -eq 1 ]; then
					missing_critical=$((missing_critical + 1))
					vacs_report "$lineno" "missing-critical-marker: --require-critical is in force and this criterion carries no '**CRITICAL** ' marker"
				fi
				;;
			esac
			continue
			;;
		esac

		if [ "$VACS_INDENT" -gt 0 ]; then
			list_open=1
			case "$body" in
			'- evidence:'*)
				if [ "$cur_open" -eq 1 ] && [ "$cur_evidence" = "none" ]; then
					value="${body#- evidence:}"
					vacs_trim "$value"
					value="$VACS_TRIMMED"
					if [ -z "$value" ]; then
						cur_evidence="empty"
					else
						vacs_evidence_verdict "$value"
						cur_evidence="$VACS_EVIDENCE_VERDICT"
					fi
				fi
				continue
				;;
			'- explanation:'*)
				if [ "$cur_open" -eq 1 ] && [ "$cur_explanation" = "none" ]; then
					value="${body#- explanation:}"
					vacs_trim "$value"
					value="$VACS_TRIMMED"
					[ -n "$value" ] && cur_explanation="present"
				fi
				continue
				;;
			'- blocked:'*)
				if [ "$cur_open" -eq 1 ] && [ "$cur_reason" = "none" ]; then
					value="${body#- blocked:}"
					vacs_trim "$value"
					value="$VACS_TRIMMED"
					# PRESENCE only. A blocked reason is prose by nature — "needs
					# production credentials" is a complete and honest answer. It
					# is deliberately NOT put through vacs_evidence_verdict: the
					# substance and surrogate rules apply to `evidence:`, where
					# the claim is "I did this", not to `blocked:`, where the
					# claim is "I cannot". Demanding a command of a reason would
					# make honest blockers unwriteable and push authors back to
					# leaving the loop spinning, which is the defect this feature
					# closes. Pinned by a test; do not "harden" this later.
					[ -n "$value" ] && cur_reason="present"
				fi
				continue
				;;
			esac
			continue
		fi

		# Unindented, non-list content ends the criterion and the list.
		vacs_close
		list_open=0
	done <"$file"

	vacs_close

	# ---- Reconcile the trail with the authoritative counts ---------------
	# A trail that describes a different set of criteria from the one the
	# verdict was computed over is worse than no trail: it would explain a
	# decision that was not the decision taken. Disagreement FAILS CLOSED.
	if [ "$scan_total" -ne "$p_total" ]; then
		vacs_die 3 "internal inconsistency validating $file: the decision trail found $scan_total criterion(s) but parse-acs.sh counted $p_total — refusing rather than emitting a trail that does not describe the verdict" || return
	fi
	# The blocked count is reconciled on the same terms as the total, and for the
	# same reason: a trail that disagreed with the verdict about WHICH criteria
	# stopped driving the nudge would explain a decision that was not taken.
	if [ "$scan_blocked" -ne "$p_blocked" ]; then
		vacs_die 3 "internal inconsistency validating $file: the decision trail found $scan_blocked blocked criterion(s) but parse-acs.sh counted $p_blocked — refusing rather than emitting a trail that does not describe the verdict" || return
	fi

	# ---- R12 OUTRANKS the delegated format check -------------------------
	# The lead rule is checked BEFORE delegation, deliberately. When a file
	# carries a ticked-but-unevidenced criterion AND some other lexical fault,
	# acs-format-check.sh generalises the pair to a plain format error (exit 4)
	# and the single most important failure in this feature loses its name. A
	# tick that carries an `explanation:` instead of an `evidence:` is exactly
	# that case, and it is self-certification — the thing R12 exists to stop. It
	# must be reported as `ticked-without-evidence` (exit 5), not as a generic
	# format error. Both refuse, so this trades no safety; it trades a vague
	# diagnostic for a precise one.
	if [ "$ticked_without_evidence" -gt 0 ]; then
		vacs_die 5 "ticked-without-evidence: $ticked_without_evidence ticked criterion(s) in $file carry no evidence" || return
	fi

	# ---- Delegate LEXICAL conformance to acs-format-check.sh -------------
	# Authoritative for checkbox syntax, the specified-system reference,
	# surrogate references, `**CRITICAL**` placement, and field presence. Its
	# exit code is propagated unchanged; the trail above has already explained
	# the offending lines in this script's voice.
	if [ "$authoring" -eq 1 ]; then
		bash "$checker" --authoring "$file" >/dev/null || fc_status=$?
	else
		bash "$checker" "$file" >/dev/null || fc_status=$?
	fi
	if [ "$fc_status" -ne 0 ]; then
		if [ "$fc_status" -eq 5 ]; then
			vacs_die 5 "ticked-without-evidence in $file — a tick with no evidence is NOT a met criterion" || return
		fi
		if [ "$fc_status" -eq 6 ]; then
			vacs_die 6 "unticked-without-explanation in $file" || return
		fi
		# Named rather than left to the generic branch below, because THIS is
		# the code the gate has to be able to tell apart: a reasonless blocker
		# that fell through as an anonymous refusal would stop driving the nudge
		# while nothing said why.
		if [ "$fc_status" -eq 8 ]; then
			vacs_die 8 "blocked-without-reason in $file — a blocked criterion must state what is blocking it" || return
		fi
		vacs_die "$fc_status" "refusing on delegated format check — acs-format-check.sh rejected $file (exit $fc_status)" || return
	fi

	# ---- This script's own refusals, in precedence order -----------------
	if [ "$missing_critical" -gt 0 ]; then
		vacs_die 4 "missing-critical-marker: $missing_critical criterion(s) in $file carry no '**CRITICAL** ' marker under --require-critical" || return
	fi
	if [ "$evidence_surrogate" -gt 0 ]; then
		vacs_die 7 "evidence-names-surrogate: $evidence_surrogate ticked criterion(s) in $file are evidenced against a stand-in rather than the specified system" || return
	fi
	if [ "$evidence_not_substantive" -gt 0 ]; then
		vacs_die 7 "evidence-not-substantive: $evidence_not_substantive ticked criterion(s) in $file carry prose alone — evidence must name a command, an observed result, or an artefact" || return
	fi
	if [ "$unticked_without_explanation" -gt 0 ]; then
		vacs_die 6 "unticked-without-explanation: $unticked_without_explanation unmet criterion(s) in $file carry no explanation" || return
	fi
	if [ "$blocked_without_reason" -gt 0 ]; then
		vacs_die 8 "blocked-without-reason: $blocked_without_reason blocked criterion(s) in $file state no reason" || return
	fi

	# ---- The verdict ------------------------------------------------------
	# Met AND evidenced. Every tick above has been shown to carry substantive,
	# non-surrogate evidence, so an all-checked file reaching here is the only
	# way exit 0 is ever produced.
	#
	# Exit 0 is gated on the VERDICT, not on `unchecked=0`. With the third state
	# those are no longer the same question: a checklist with nothing
	# outstanding but something blocked has `unchecked=0` and is `partial` — a
	# reported non-completion, never a pass. Testing `unchecked` alone here
	# would hand exit 0 to exactly the case this feature exists to refuse.
	if [ "$p_verdict" = "done" ]; then
		exit_code=0
	else
		exit_code=1
	fi

	if [ "$quiet" -eq 0 ]; then
		printf '%s' "$trail"
	fi
	printf 'verdict=%s\n' "$p_verdict"
	printf 'total=%d\n' "$p_total"
	printf 'checked=%d\n' "$p_checked"
	printf 'unchecked=%d\n' "$p_unchecked"
	printf 'blocked=%d\n' "$p_blocked"
	printf 'ticked_with_evidence=%d\n' "$ticked_with_evidence"
	printf 'ticked_without_evidence=%d\n' "$ticked_without_evidence"
	printf 'unticked_with_explanation=%d\n' "$unticked_with_explanation"
	printf 'unticked_without_explanation=%d\n' "$unticked_without_explanation"
	printf 'blocked_with_reason=%d\n' "$blocked_with_reason"
	printf 'blocked_without_reason=%d\n' "$blocked_without_reason"
	printf 'evidence_not_substantive=%d\n' "$evidence_not_substantive"
	printf 'evidence_surrogate=%d\n' "$evidence_surrogate"
	printf 'critical=%d\n' "$critical"
	printf 'critical_unchecked=%d\n' "$critical_unchecked"
	return "$exit_code"
}

vacs_main() {
	case "${1-}" in
	-h | --help)
		sed -n '2,110p' "$0"
		return 0
		;;
	esac
	vacs_validate "$@"
}

# Only run when executed, not when sourced. `set -e` is scoped to execution so
# that sourcing this file never changes the caller's shell mode.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -uo pipefail
	vacs_main "$@"
fi
