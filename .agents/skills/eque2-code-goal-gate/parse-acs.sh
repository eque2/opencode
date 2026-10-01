#!/usr/bin/env bash
# parse-acs.sh — the single source of verdict truth for ACs.md.
#
# Contract: {skills-root}/eque2-code-prepare-goal/references/acs-format.md
#
# Usage:
#   parse-acs.sh [--format-check] [--authoring] <ACs.md path>
#
# Parses an acceptance-criteria file into counts and a VERDICT. On a trustworthy
# parse it prints machine-readable key=value lines to stdout:
#
#   verdict=<done|not_done|partial>
#   total=<n>          criteria found (top-level task-list items)
#   checked=<n>        state [x]
#   unchecked=<n>      state [ ]
#   blocked=<n>        state [!] — genuinely cannot be met; see below
#   unknown=<n>        a checkbox whose state is NOT one of the three specified
#                      forms ([X], [-], [], [  ]) — never guessed, never coerced
#   explanations=<n>   criteria carrying a non-empty `- explanation:` line
#   evidence=<n>       criteria carrying a non-empty `- evidence:` line
#   reasons=<n>        criteria carrying a non-empty `- blocked:` line
#   nested=<n>         indented task items (illustrations; NOT criteria)
#   nonconforming=<n>  criteria recognised but not in canonical `- [ ] `/`- [x] `
#   unrecognised=<n>   checkbox-like lines the parser refused to classify
#   duplicates=<n>     criteria whose text was seen before (advisory only)
#
# STDOUT DISCIPLINE — the load-bearing safety property:
#   Counts are printed ONLY on exit 0 and exit 1. Every other exit prints
#   NOTHING to stdout and a `parse-acs:` diagnostic to stderr. So a non-empty
#   stdout implies a trustworthy parse, and a "done" verdict can only ever be
#   observed on exit 0. An error can never be misread as "0 unchecked".
#   (This banner deliberately avoids writing the done-verdict key=value pair
#   literally: `--help` prints this text, and a consumer grepping stdout for it
#   must never match the help output.)
#
# THE BLOCKED STATE AND THE `partial` VERDICT.
#   `- [!] ` is a criterion that genuinely CANNOT be met. It is counted in
#   `blocked`, and it is in NEITHER `checked` NOR `unchecked`:
#
#     * excluded from `unchecked`, so it stops driving the nudge — a loop is no
#       longer held open forever by work that will never be done;
#     * never added to `checked`, so blocking NEVER buys a pass.
#
#   With `unchecked=0` and `blocked>0` the verdict is `partial`: the loop may
#   END, but as a REPORTED NON-COMPLETION, not as success. `partial` rides on
#   EXIT 1 deliberately — exit 1 is already the whole not-done family, so every
#   consumer that has not been taught the third state keeps its fail-closed
#   reading with no edit, and no later refactor can drift a new code into the
#   success family. Consumers branch on `verdict=`/`blocked=` (data), never on a
#   new exit code (control flow).
#
#   ALL-BLOCKED IS NOT A PASS: `checked=0` with `blocked=total` is `partial`,
#   exit 1 — the vacuous-truth trap in its new form.
#
#   A `[!]` with no `- blocked:` reason is COUNTED here as blocked; REFUSING it
#   belongs to acs-format-check.sh (exit 8) and validate-acs.sh. This script must
#   not silently reclassify it as unchecked — see LAYERING below. The gate calls
#   this parser bare AND the validator separately, so the refusal still lands.
#
# FAIL CLOSED. Every unknown, error, missing input or unclassifiable line
# resolves to NOT DONE or, where the remaining work is impossible, to PARTIAL —
# which is a reported non-completion and never a pass.
#
#   * ZERO CRITERIA IS AN ERROR, NEVER "ALL COMPLETE" (the vacuous-truth trap).
#   * All list prefixes (`-`, `*`, `+`, `1.`, `1)`) are recognised, so no
#     criterion can be silently DROPPED — dropping an unchecked criterion would
#     drive unmet to zero and PERMIT completion, which fail-closed does not
#     catch because nothing errors. Non-canonical prefixes are counted AND
#     refused.
#   * Any line containing checkbox-like text that is not classified as a
#     criterion is reported as `unrecognised` and refuses completion.
#
# LAYERING:
#   acs-format-check.sh (T1.2) owns LEXICAL CONFORMANCE of one file. This script
#   owns COUNTING AND THE VERDICT. It does not re-implement the format rules
#   (surrogate references, `**CRITICAL**` placement, evidence/explanation
#   enforcement); `--format-check` DELEGATES to acs-format-check.sh and
#   propagates its exit code unchanged. validate-acs.sh (T1.6) owns
#   evidence/explanation enforcement and gate wiring; here those fields are
#   COUNTED, never enforced.
#
# Exit codes:
#   0  parsed; the verdict is "done" (total>0, nothing outstanding or unclear)
#   1  parsed; the verdict is "not_done" OR "partial" — both are not-a-pass, and
#      they share an exit code on purpose (see THE BLOCKED STATE above)
#   2  zero criteria, or an empty file — never "all complete"
#   3  input missing, a directory, a symlink, not a regular file, unreadable,
#      or modified during the read
#   4  parse refusal: unrecognised checkbox-like line, non-canonical criterion,
#      or a checkbox whose state is not one of the three specified forms
#   5  encoding error: UTF-8 BOM, invalid UTF-8, or NUL bytes
#   6  git merge-conflict markers
#   64 usage error
# ---------------------------------------------------------------------------

PACS_TAB=$'\t'
PACS_SEP=$'\001'

# A markdown task-list item: a list prefix, whitespace, a bracketed box, a rest.
# ALL list prefixes are matched (`-`, `*`, `+`, `1.`, `1)`), deliberately: a
# parser that only understood `- [ ]` would silently DROP a criterion written
# `* [ ]`, and dropping an unchecked criterion reduces unmet to zero and
# permits completion. Held in a variable because bash 3.2's `[[ ]]` tokenizer
# mis-parses a literal `)` inside a regex.
PACS_ITEM_RE='^([-*+]|[0-9]{1,9}[.)])([[:blank:]]+)\[([^]]*)\](.*)$'

# --------------------------------------------------------------------------
# Diagnostics
# --------------------------------------------------------------------------

# pacs_die <exit-code> <message...>
pacs_die() {
	local code="$1"
	shift
	printf 'parse-acs: %s\n' "$*" >&2
	return "$code"
}

# pacs_report <line-number> <message...>
pacs_report() {
	local lineno="$1"
	shift
	printf 'parse-acs: line %s: %s\n' "$lineno" "$*" >&2
}

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# pacs_indent <line>  -> sets PACS_INDENT
#
# Leading columns, counting a tab as advancing to the next multiple of 4. Tabs
# are legal markdown indentation and must not read as column 0, which would
# promote an illustration to a criterion. Sets a variable rather than echoing:
# a command substitution per line would cost a subshell per line.
pacs_indent() {
	local line="$1" i=0 col=0 ch n
	n=${#line}
	while [ "$i" -lt "$n" ]; do
		ch="${line:i:1}"
		if [ "$ch" = " " ]; then
			col=$((col + 1))
		elif [ "$ch" = "$PACS_TAB" ]; then
			col=$((col + 4 - col % 4))
		else
			break
		fi
		i=$((i + 1))
	done
	PACS_INDENT="$col"
}

# pacs_strip_code_spans <text>  -> sets PACS_STRIPPED
#
# Removes backtick-delimited inline code spans. Used ONLY for the
# unrecognised-line scan: a backticked `- [ ] foo` in prose is an illustration,
# not a criterion, and must not be reported. Classification itself runs on the
# raw line, so a criterion's own backticked path reference is untouched.
pacs_strip_code_spans() {
	local rest="$1" out="" head
	while :; do
		case "$rest" in
		*'`'*) : ;;
		*) break ;;
		esac
		head="${rest%%\`*}"
		out="$out$head"
		rest="${rest#*\`}"
		case "$rest" in
		*'`'*)
			# Drop the span contents up to and including the closing backtick.
			rest="${rest#*\`}"
			;;
		*)
			# Unclosed span: keep the remainder rather than silently eating it.
			break
			;;
		esac
	done
	PACS_STRIPPED="$out$rest"
}

# pacs_has_checkbox_text <text>
#
# True when the text contains something a reader would take for a checkbox.
pacs_has_checkbox_text() {
	case "$1" in
	*'[ ]'* | *'[x]'* | *'[X]'* | *'[]'* | *'[-]'* | *'[!]'*) return 0 ;;
	esac
	return 1
}

# --------------------------------------------------------------------------
# Pre-read validation
# --------------------------------------------------------------------------

# pacs_check_input <path>
pacs_check_input() {
	local file="$1"
	if [ -z "$file" ]; then
		pacs_die 3 "empty ACs.md path" || return
	fi
	# -L before -e: a dangling symlink must report as a symlink, not as missing.
	if [ -L "$file" ]; then
		pacs_die 3 "ACs.md is a symlink, which is refused: $file (the verdict source of truth must not be redirectable)" || return
	fi
	if [ -d "$file" ]; then
		pacs_die 3 "is a directory, not an ACs.md file: $file" || return
	fi
	if [ ! -e "$file" ]; then
		pacs_die 3 "no such ACs.md file: $file" || return
	fi
	if [ ! -f "$file" ]; then
		pacs_die 3 "not a regular file: $file" || return
	fi
	if [ ! -r "$file" ]; then
		pacs_die 3 "ACs.md is not readable: $file" || return
	fi
}

# pacs_check_encoding <path>
#
# A BOM, invalid UTF-8, or NUL bytes are reported as an ENCODING error — never
# as "no criteria found", which would look like an authoring slip and hide a
# file the parser could not actually read.
pacs_check_encoding() {
	local file="$1" bom raw stripped
	bom="$(dd if="$file" bs=1 count=3 2>/dev/null | od -An -tx1 | tr -d ' \n')"
	if [ "$bom" = "efbbbf" ]; then
		pacs_die 5 "UTF-8 BOM in $file — strip the BOM; a BOM is not criteria" || return
	fi
	raw="$(wc -c <"$file" | tr -d ' ')"
	stripped="$(LC_ALL=C tr -d '\000' <"$file" | wc -c | tr -d ' ')"
	if [ "$raw" != "$stripped" ]; then
		pacs_die 5 "NUL bytes in $file — not a UTF-8 text file" || return
	fi
	if command -v iconv >/dev/null 2>&1; then
		if ! iconv -f UTF-8 -t UTF-8 <"$file" >/dev/null 2>&1; then
			pacs_die 5 "invalid UTF-8 in $file" || return
		fi
	fi
}

# --------------------------------------------------------------------------
# The parser
# --------------------------------------------------------------------------

# pacs_parse [--format-check] [--authoring] <path>
pacs_parse() {
	local format_check=0 authoring=0 file=""
	local checker size_before size_after content
	local line raw_line lineno=0
	local total=0 checked=0 unchecked=0 blocked=0 unknown=0 reasons=0
	local explanations=0 evidence=0 nested=0
	local nonconforming=0 unrecognised=0 duplicates=0 conflicts=0
	local in_fence=0 fence_marker="" in_comment=0 list_open=0
	local cur_open=0 cur_has_evidence=0 cur_has_explanation=0 cur_has_blocked=0
	local seen_texts="" text body prefix gap box rest trimmed value
	local verdict exit_code

	while [ "$#" -gt 0 ]; do
		case "$1" in
		--format-check)
			format_check=1
			shift
			;;
		--authoring)
			authoring=1
			shift
			;;
		--)
			shift
			break
			;;
		-*) pacs_die 64 "unknown option: $1" || return ;;
		*) break ;;
		esac
	done

	if [ "$#" -ne 1 ]; then
		pacs_die 64 "usage: parse-acs.sh [--format-check] [--authoring] <ACs.md path>" || return
	fi
	file="$1"

	pacs_check_input "$file" || return
	pacs_check_encoding "$file" || return

	# ---- Concurrency ---------------------------------------------------
	# Read the whole file in one pass so the parse runs over a single snapshot,
	# then re-measure. A file appended to during the read yields either a
	# complete parse or an error — never a partial verdict.
	size_before="$(wc -c <"$file" | tr -d ' ')"
	if ! content="$(cat -- "$file")"; then
		pacs_die 3 "failed to read $file" || return
	fi
	size_after="$(wc -c <"$file" | tr -d ' ')"
	if [ "$size_before" != "$size_after" ]; then
		pacs_die 3 "$file changed during the read ($size_before -> $size_after bytes) — refusing to emit a partial verdict" || return
	fi
	if [ "$size_before" = "0" ]; then
		pacs_die 2 "$file is empty — an empty checklist is not 'all complete'" || return
	fi

	while IFS= read -r raw_line || [ -n "$raw_line" ]; do
		lineno=$((lineno + 1))
		# CRLF: a carriage return must not join a criterion's text or defeat a
		# suffix match.
		line="${raw_line%$'\r'}"

		# ---- git merge-conflict markers --------------------------------
		# A checked side from `main` could mask an unchecked local one, so a
		# conflicted file has no readable verdict at all. Only the `<<<<<<<`
		# and `>>>>>>>` markers are matched: a bare `=======` is also a valid
		# markdown setext heading rule.
		case "$line" in
		'<<<<<<<'* | '>>>>>>>'*)
			pacs_report "$lineno" "git merge-conflict marker: $line"
			conflicts=$((conflicts + 1))
			continue
			;;
		esac

		# ---- Fenced code blocks ----------------------------------------
		# Checked BEFORE the HTML-comment scan: a stray `<!--` inside a fence
		# must not open a comment that then swallows real criteria below the
		# fence — swallowing a criterion is exactly the silent drop this parser
		# exists to prevent.
		trimmed="${line#"${line%%[![:space:]]*}"}"
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

		# ---- HTML comments ---------------------------------------------
		if [ "$in_comment" -eq 1 ]; then
			case "$line" in
			*'-->'*) in_comment=0 ;;
			esac
			continue
		fi
		case "$line" in
		*'<!--'*'-->'*)
			# Single-line comment: excise it before any classification.
			line="${line%%<!--*}${line#*-->}"
			trimmed="${line#"${line%%[![:space:]]*}"}"
			;;
		*'<!--'*)
			in_comment=1
			continue
			;;
		esac

		# ---- Block quotes ----------------------------------------------
		case "$trimmed" in
		'>'*) continue ;;
		esac

		# ---- Blank lines end nothing -----------------------------------
		if [ -z "$trimmed" ]; then
			continue
		fi

		pacs_indent "$line"

		# ---- Indented code blocks --------------------------------------
		# 4+ columns of indentation is a code block ONLY outside a list; inside
		# an open list the same indentation is continuation content. That is
		# what lets nested criteria and 4-space code blocks coexist.
		if [ "$PACS_INDENT" -ge 4 ] && [ "$list_open" -eq 0 ]; then
			continue
		fi

		body="$trimmed"

		# ---- A task-list item ------------------------------------------
		if [[ "$body" =~ $PACS_ITEM_RE ]]; then
			prefix="${BASH_REMATCH[1]}"
			gap="${BASH_REMATCH[2]}"
			box="${BASH_REMATCH[3]}"
			rest="${BASH_REMATCH[4]}"
			list_open=1

			if [ "$PACS_INDENT" -gt 0 ]; then
				# An indented task item is an ILLUSTRATION, not a criterion
				# (format contract §3.1). Counted for visibility so it is never
				# invisible; it does not move the verdict.
				cur_open=0
				nested=$((nested + 1))
				continue
			fi

			cur_open=1
			cur_has_evidence=0
			cur_has_explanation=0
			cur_has_blocked=0
			total=$((total + 1))

			# Canonical form is exactly `- [ ] ` / `- [x] `: a `-` prefix, one
			# space, the box, one space. Anything else is COUNTED and REFUSED —
			# never dropped, because dropping an unchecked criterion would
			# reduce unmet to zero and permit completion.
			if [ "$prefix" != "-" ] || [ "$gap" != " " ]; then
				pacs_report "$lineno" "non-canonical list prefix '$prefix$gap' (canonical is '- '): $line"
				nonconforming=$((nonconforming + 1))
			fi
			case "$rest" in
			' '*) text="${rest# }" ;;
			'')
				pacs_report "$lineno" "criterion has no text: $line"
				nonconforming=$((nonconforming + 1))
				text=""
				;;
			*)
				pacs_report "$lineno" "no space after the checkbox: $line"
				nonconforming=$((nonconforming + 1))
				text="$rest"
				;;
			esac

			# The box state is read exactly as specified, or not at all. `[X]`,
			# `[-]`, `[]` and `[  ]` are NEVER guessed into checked/unchecked.
			case "$box" in
			'x') checked=$((checked + 1)) ;;
			' ') unchecked=$((unchecked + 1)) ;;
			'!')
				# Neither met nor outstanding — absent from BOTH counts. The
				# absence from `unchecked` is what stops it driving the nudge;
				# the absence from `checked` is what stops it buying a pass.
				# A `[!]` carrying no reason is COUNTED here and REFUSED by
				# acs-format-check.sh (exit 8): silently demoting it to
				# `unchecked` would hide a malformed blocker behind ordinary
				# outstanding work, and this layer does not enforce.
				blocked=$((blocked + 1))
				;;
			*)
				pacs_report "$lineno" "unknown checkbox state '[$box]' — only '[ ]', '[x]' and '[!]' are specified and the state is not guessed: $line"
				unknown=$((unknown + 1))
				nonconforming=$((nonconforming + 1))
				;;
			esac

			# Dedup policy: NONE. Identical criterion text counts twice.
			# De-duplicating could drop an unchecked duplicate of a checked
			# criterion, reducing unmet. `duplicates` is advisory only and does
			# not move the verdict.
			if [ -n "$text" ] && [ "$total" -le 2000 ]; then
				case "$seen_texts" in
				*"$PACS_SEP$text$PACS_SEP"*) duplicates=$((duplicates + 1)) ;;
				*) seen_texts="$seen_texts$PACS_SEP$text$PACS_SEP" ;;
				esac
			fi
			continue
		fi

		# ---- Indented, non-task content ---------------------------------
		if [ "$PACS_INDENT" -gt 0 ]; then
			list_open=1
			case "$body" in
			'- evidence:'*)
				if [ "$cur_open" -eq 1 ] && [ "$cur_has_evidence" -eq 0 ]; then
					value="${body#- evidence:}"
					if [ -n "${value//[[:space:]]/}" ]; then
						evidence=$((evidence + 1))
						cur_has_evidence=1
					fi
				fi
				continue
				;;
			'- explanation:'*)
				if [ "$cur_open" -eq 1 ] && [ "$cur_has_explanation" -eq 0 ]; then
					value="${body#- explanation:}"
					if [ -n "${value//[[:space:]]/}" ]; then
						explanations=$((explanations + 1))
						cur_has_explanation=1
					fi
				fi
				continue
				;;
			'- blocked:'*)
				if [ "$cur_open" -eq 1 ] && [ "$cur_has_blocked" -eq 0 ]; then
					value="${body#- blocked:}"
					if [ -n "${value//[[:space:]]/}" ]; then
						reasons=$((reasons + 1))
						cur_has_blocked=1
					fi
				fi
				continue
				;;
			esac
			# Anything else indented is continuation content: a criterion
			# spanning wrapped lines, an `- at:` timestamp, a sub-note. It is
			# suspicious only if it carries checkbox-like text.
			case "$body" in
			*'['*)
				pacs_strip_code_spans "$body"
				if pacs_has_checkbox_text "$PACS_STRIPPED"; then
					pacs_report "$lineno" "unrecognised checkbox-like line — not classified as a criterion: $line"
					unrecognised=$((unrecognised + 1))
				fi
				;;
			esac
			continue
		fi

		# ---- Unindented, non-list content -------------------------------
		# Prose, a heading, a table row: this ends the open criterion and the
		# surrounding list.
		cur_open=0
		list_open=0
		case "$body" in
		*'['*)
			pacs_strip_code_spans "$body"
			if pacs_has_checkbox_text "$PACS_STRIPPED"; then
				# THE guard that closes the class: a checkbox-like line is
				# never silently skipped.
				pacs_report "$lineno" "unrecognised checkbox-like line — not classified as a criterion: $line"
				unrecognised=$((unrecognised + 1))
			fi
			;;
		esac
	done <<<"$content"

	# ---- Refusals, in precedence order ---------------------------------
	# Each prints NOTHING to stdout, so a caller can never read a count off an
	# error path.
	if [ "$conflicts" -gt 0 ]; then
		pacs_die 6 "$conflicts git merge-conflict marker(s) in $file — a checked side could mask an unchecked one; resolve the conflict before asking for a verdict" || return
	fi
	if [ "$unrecognised" -gt 0 ]; then
		pacs_die 4 "$unrecognised unrecognised checkbox-like line(s) in $file — refusing completion rather than skipping them" || return
	fi
	if [ "$nonconforming" -gt 0 ]; then
		pacs_die 4 "$nonconforming non-canonical criterion(s) in $file — counted, not guessed, and refused" || return
	fi
	if [ "$unknown" -gt 0 ]; then
		pacs_die 4 "$unknown criterion(s) in $file have an unreadable checkbox state" || return
	fi

	# ---- The vacuous-truth trap ----------------------------------------
	# ZERO CRITERIA IS AN ERROR, NEVER "0 unchecked, therefore done".
	if [ "$total" -eq 0 ]; then
		pacs_die 2 "no criteria found in $file — zero criteria is not 'all complete'" || return
	fi

	# ---- Delegated lexical conformance ---------------------------------
	# The format rules (surrogate references, `**CRITICAL**` placement,
	# evidence/explanation enforcement) belong to acs-format-check.sh. Consume
	# it; do not re-implement it.
	if [ "$format_check" -eq 1 ]; then
		checker="$(dirname -- "${BASH_SOURCE[0]}")/acs-format-check.sh"
		if [ ! -f "$checker" ]; then
			pacs_die 3 "--format-check requested but no checker at $checker" || return
		fi
		local fc_status=0
		if [ "$authoring" -eq 1 ]; then
			bash "$checker" --authoring "$file" >/dev/null || fc_status=$?
		else
			bash "$checker" "$file" >/dev/null || fc_status=$?
		fi
		if [ "$fc_status" -ne 0 ]; then
			# Propagate the checker's exit code unchanged, but say so in this
			# script's own voice too: a delegated refusal that only spoke as
			# `acs-format:` would look, to a caller watching parse-acs, like a
			# failure with no diagnostic at all.
			pacs_die "$fc_status" "refusing on delegated format check — acs-format-check.sh rejected $file (exit $fc_status)" || return
		fi
	fi

	# ---- The verdict ----------------------------------------------------
	# Order matters. Outstanding work outranks blocked work: while ANY criterion
	# is still `[ ]` the answer is the ordinary not_done, whatever else is
	# blocked. Blocking some criteria never releases a turn that still has real
	# work in it.
	#
	# `partial` is reached only when nothing is outstanding AND something is
	# blocked. It is a REPORTED NON-COMPLETION — hence exit 1, alongside
	# not_done, so an unmodified consumer treats it as the not-a-pass it is.
	# All-blocked lands here too, with checked=0: never a pass.
	if [ "$unchecked" -gt 0 ]; then
		verdict="not_done"
		exit_code=1
	elif [ "$blocked" -gt 0 ]; then
		verdict="partial"
		exit_code=1
	else
		verdict="done"
		exit_code=0
	fi

	printf 'verdict=%s\n' "$verdict"
	printf 'total=%d\n' "$total"
	printf 'checked=%d\n' "$checked"
	printf 'unchecked=%d\n' "$unchecked"
	printf 'blocked=%d\n' "$blocked"
	printf 'unknown=%d\n' "$unknown"
	printf 'explanations=%d\n' "$explanations"
	printf 'evidence=%d\n' "$evidence"
	printf 'reasons=%d\n' "$reasons"
	printf 'nested=%d\n' "$nested"
	printf 'nonconforming=%d\n' "$nonconforming"
	printf 'unrecognised=%d\n' "$unrecognised"
	printf 'duplicates=%d\n' "$duplicates"
	return "$exit_code"
}

pacs_main() {
	case "${1-}" in
	-h | --help)
		sed -n '2,/^# ----*$/p' "$0"
		return 0
		;;
	esac
	pacs_parse "$@"
}

# Only run when executed, not when sourced. `set -e` is scoped to execution so
# that sourcing this file never changes the caller's shell mode.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -uo pipefail
	pacs_main "$@"
fi
