#!/usr/bin/env bash
# cancel.sh — end an active loop, and describe one. The companions to
# `pursue-goal` (T3.5).
#
# Usage:
#   cancel.sh status [dir]           what is running here, and why
#   cancel.sh cancel [dir] [--force] end the active loop
#   cancel.sh adopt  [dir]           hand the running loop to THIS conversation
#   cancel.sh reset-stall [dir] [--force]
#                                   reset repeated-yield/stall accounting
#   cancel.sh reset-yield [dir] [--force]
#                                   alias for reset-stall
#   cancel.sh recovery-ack <token> [dir]
#                                   credit one accidental Codex Stop
#   cancel.sh scaffold [dir]         write the guard and the ignore entries
#   cancel.sh --help
#
# CANCELLING IS A REPORTED END, NEVER A COMPLETION. A cancelled loop keeps its
# unmet counts, is never recorded as done, and emits no completion record. The
# distinction matters because the whole feature exists to stop "we stopped" from
# being read as "we finished".
#
# BINDING IS RESPECTED BY DEFAULT. A loop claimed by ANOTHER conversation is not
# cancelled silently: the owner is reported and `--force` is required. Ending
# someone else's in-flight run by accident is the same class of harm as
# clobbering their hook registration.
#
# AND "I DON'T KNOW WHO I AM" IS NOT PERMISSION. Review finding: the guard used
# to require GOAL_GATE_IDENTITY to be set before it would compare owners — and
# nothing outside the test suite ever sets it, so in every real invocation the
# comparison was skipped and any conversation could end any other's run, exit 0,
# no warning. An unknown resolving to permission is the exact inversion of this
# feature's governing rule. A CLAIMED loop whose owner cannot be matched now
# requires --force, whether the mismatch is known or merely unestablished.
#
# THE BLOCKED-ESCAPE SIGNAL IS DETECTED HERE. `LOOP_BLOCKED` is the one file the
# gated agent can write to bring its own loop to an end. The predecessor
# documented that signal to the model and NEVER DETECTED IT, so an agent could
# write it and no human-facing surface ever said so. `status` reports it, names
# the reason, and treats a reason-less blocked signal as the refusal the gate
# treats it as.
#
# ADOPT EXISTS BECAUSE A CONVERSATION'S IDENTITY IS NOT STABLE ACROSS A RESTART.
# The gate binds a loop to the conversation that claimed it, and holds only that
# conversation's turns. Resume a session, restart the agent, or lose the session
# for any other reason, and the new conversation is a BYSTANDER: it stands down
# every turn, the loop advances nowhere, and nothing is wrong with either the
# gate or the goal. The abandoned claim does eventually go stale on its own
# (GOAL_GATE_LIVENESS_WINDOW, 900s by default) and the next conversation reclaims
# it — but waiting out a quarter of an hour, with no indication that waiting is
# the remedy, is not a usable answer.
#
# `adopt` RELEASES the claim rather than transferring it, and that is deliberate.
# This script runs as an ordinary command; it is not the hook and has no session
# identity to transfer ownership TO — guessing one would write a false owner into
# the loop file. Releasing needs no identity: the workstream becomes unclaimed,
# and the very next turn end in THIS conversation claims it through the same
# atomic path a fresh loop uses, stamping the real identity the host supplies.
#
# Exit codes:
#   0  done (cancelled, adopted, reset, or reported)
#   1  nothing to cancel — reported, not silently ignored
#   2  invalid input
#   3  the loop is bound to another conversation and --force was not given
#   4  a recovery token is foreign, expired, or already used
#   5  filesystem failure
#   64 usage error

CN_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CN_LOOP_STATE="${GOAL_GATE_LOOP_STATE:-$CN_SELF_DIR/loop-state.sh}"
CN_MARKER="${GOAL_GATE_MARKER:-.goal-gate}"

cn_die() {
	local code="$1"
	shift
	printf 'goal-gate: %s\n' "$*" >&2
	return "$code"
}

cn_say() {
	printf 'goal-gate: %s\n' "$*"
}

# cn_gate_dir [start] — the gate directory governing a directory, resolved the
# SAME way the gate itself resolves it: STRICTLY at the repo root (git top level,
# else the working directory outside a repo), never an ancestor. Composing the
# path by hand — or walking up — would let cancel and the gate disagree about
# which loop is running.
cn_gate_dir() {
	local root
	if [ -n "${GOAL_GATE_DIR-}" ]; then
		[ -d "$GOAL_GATE_DIR" ] || return 1
		(cd -- "$GOAL_GATE_DIR" && pwd -P)
		return 0
	fi

	root="$(cd -- "${1:-$PWD}" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)"
	if [ -z "$root" ]; then
		root="$(cd -- "${1:-$PWD}" 2>/dev/null && pwd -P)" || return 1
	fi
	[ -n "$root" ] || return 1

	if [ -d "$root/$CN_MARKER" ]; then
		printf '%s\n' "$root/$CN_MARKER"
		return 0
	fi
	return 1
}

cn_get() {
	bash "$CN_LOOP_STATE" get "$1" "$2" 2>/dev/null
}

# cn_name_safe <value> — the SAME allow-list the gate applies in
# gg_identity_safe, and it holds for the same reason: only [A-Za-z0-9._-], at
# most 128 bytes, and never `.` or `..`.
#
# It exists here because `adopt` composes `$gate_dir/$base.claim.*` and hands it
# to `rm -rf`. The basename comes off the filesystem — a directory this script
# did not write and does not control — so it is attacker-shaped input in exactly
# the way a payload field is. `gg_rename_workstream` was hardened for this on the
# gate side; the same path existed here, unguarded.
cn_name_safe() {
	local v="${1-}"
	[ -n "$v" ] || return 1
	[ "${#v}" -le 128 ] || return 1
	case "$v" in
	. | ..) return 1 ;;
	*[!A-Za-z0-9._-]*) return 1 ;;
	esac
	return 0
}

cn_sha256() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 | cut -d' ' -f1
		return 0
	fi
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | cut -d' ' -f1
		return 0
	fi
	return 1
}

cn_repo_progress() {
	local goal="$1" head tree
	command -v git >/dev/null 2>&1 || return 1
	head="$(git -C "$goal" rev-parse HEAD 2>/dev/null)" || return 1
	[ -n "$head" ] || return 1
	tree="$(git -C "$goal" status --porcelain 2>/dev/null | cn_sha256)" || return 1
	printf 'head=%s\nworktree=%s' "$head" "$tree"
}

cn_recovery_guard_hash() {
	local loop="$1" goal acs repo="" acs_hash
	goal="$(cn_get "$loop" goal_folder)"
	acs="$(cn_get "$loop" acs_path)"
	[ -r "$acs" ] || return 1
	[ -n "$goal" ] || goal="$(dirname -- "$acs")"
	[ -d "$goal" ] || return 1
	repo="$(cn_repo_progress "$goal")" || repo=""
	acs_hash="$(cn_sha256 <"$acs")" || return 1
	printf 'repo=%s\nacs=%s\n' "$repo" "$acs_hash" | cn_sha256
}

# The statuses that mean a loop is HISTORY rather than a competitor.
#
# This list is duplicated in pursue-goal.sh and the two MUST agree. They did not:
# this copy was missing `stalled` and `LOOP_BLOCKED`, both of which the gate
# really does write. The consequence was concrete — a stalled loop let
# pursue-goal start a second workstream, then `cancel` picked the FIRST *.state
# by glob order, cancelled the dead one, reported success, and the live loop
# kept blocking. A cancel that reports success without cancelling anything is
# the same false record the whole feature is built against.

# LOOP_PARTIAL was added with the blocked-criteria state: a loop whose remaining
# work is all blocked ends as a reported non-completion. It is HISTORY, exactly
# as the other five are — omitting it here would let a partially-ended loop read
# as a live competitor.
GG_TERMINAL_STATUSES="complete cancelled stalled recursion_bound_exceeded LOOP_BLOCKED LOOP_PARTIAL"

# cn_active_loop <gate-dir> — the loop file still in play, if any.
#
# Newest first: when several state files exist, the live workstream is the most
# recently written one, not whichever token happens to sort lowest.
cn_active_loop() {
	local f status
	while IFS= read -r f; do
		[ -n "$f" ] && [ -f "$f" ] || continue
		status="$(cn_get "$f" status)"
		case " $GG_TERMINAL_STATUSES " in
		*" $status "*) continue ;;
		esac
		printf '%s' "$f"
		return 0
	done < <(find "$1" -maxdepth 1 -name '*.state' -type f 2>/dev/null |
		while IFS= read -r c; do printf '%s\t%s\n' "$(cn_mtime "$c")" "$c"; done |
		LC_ALL=C sort -rn | cut -f2-)
	return 1
}

# cn_mtime <file> — modification time in epoch seconds (BSD vs GNU stat).
cn_mtime() {
	stat -f '%m' -- "$1" 2>/dev/null || stat -c '%Y' -- "$1" 2>/dev/null || printf '0'
}

# --- the guard and the ignore entries --------------------------------------
#
# The state directory is machinery, not workstream output. Both files exist so
# that neither an agent nor a commit treats it as ordinary content.

cn_scaffold() {
	local start="${1:-$PWD}" gate_dir guard ignore anchor

	if ! gate_dir="$(cn_gate_dir "$start")"; then
		cn_die 1 "no gate directory governs $start, so there is nothing to scaffold." || return
	fi

	guard="$gate_dir/CLAUDE.md"
	if [ ! -f "$guard" ]; then
		cat >"$guard" <<'EOF'
# Do not edit anything in this directory

This is the goal-gate's own state. It records which workstream is running,
which conversation owns it, how many iterations have passed, and what the last
evaluation found.

**Hand-editing any file here corrupts the loop's account of itself.** Ticking a
criterion by editing state rather than doing the work is not completion — it is
a false record of completion, which is the single failure this whole mechanism
exists to prevent.

## What the files here are called

Each workstream is two things: a state file `<workstream>.state`, and a claim
directory `<workstream>.claim.<n>` beside it holding the owning conversation's
identity and its heartbeat. The workstream's name says which POOL it is in — it
never says who holds the claim, which is what the claim directory is for:

| Name | Meaning |
|---|---|
| `_anon-<token>.state` | Unclaimed. Written by `pursue-goal`; the next turn end claims it. |
| `_ws-<conversation>.state` | Claimed. Renamed on the turn it was claimed, and again if it ever changes hands. |
| `_ended-<conversation>-<token>.state` | Ended — complete, cancelled, stalled, blocked or partial. Kept for `status` and audit; no conversation will ever adopt it. |

- To end the loop: `bash cancel.sh cancel` — a reported end, never a completion.
- To declare a real external blocker: write the reason into
  `<workstream>.LOOP_BLOCKED` — **keyed to the workstream**, matching its state
  file, so it ends that loop and no other. A bare unkeyed `LOOP_BLOCKED` names
  nobody and is reported rather than honoured. A blocked signal carrying no
  written reason is refused, not honoured.
- To see what is running: `bash cancel.sh status`.

The criteria live in the goal folder's `ACs.md`. That is the file to change when
the work is genuinely done — and a tick there must carry its `- evidence:` line.
EOF
		cn_say "wrote the guard: $guard"
	else
		cn_say "guard already present: $guard"
	fi

	# Ignore entries go in the repository root, not the gate directory, so a
	# checkout that has never run the gate still ignores it.
	anchor="$(git -C "$start" rev-parse --show-toplevel 2>/dev/null)" || anchor="$(dirname -- "$gate_dir")"
	ignore="$anchor/.gitignore"

	local entry="$CN_MARKER/"
	if [ -f "$ignore" ] && grep -qxF -- "$entry" "$ignore"; then
		cn_say "ignore entry already present in $ignore"
		return 0
	fi

	# A file not ending in a newline would otherwise get the entry glued onto
	# its last line. This repo's own .gitignore ends in a bare space with no
	# final newline, which produced ` .goal-gate/` — a pattern git does not
	# match, so the directory was NOT ignored, and one `grep -qxF` never matched
	# it again, so every later run appended another copy while reporting
	# success. Terminate the file first.
	if [ -f "$ignore" ] && [ -s "$ignore" ] && [ -n "$(tail -c 1 -- "$ignore")" ]; then
		printf '\n' >>"$ignore" 2>/dev/null || {
			cn_die 5 "cannot terminate the final line of $ignore" || return
		}
	fi

	if printf '%s\n' "$entry" >>"$ignore" 2>/dev/null; then
		cn_say "added '$entry' to $ignore"
	else
		cn_die 5 "cannot write the ignore entry to $ignore" || return
	fi
}

# --- status ----------------------------------------------------------------

cn_status() {
	local start="${1:-$PWD}" gate_dir loop status folder iteration reason

	if ! gate_dir="$(cn_gate_dir "$start")"; then
		cn_say "no loop is running here. Nothing governs $start."
		return 1
	fi

	cn_say "gate directory: $gate_dir"

	# The blocked-escape signals, reported whether or not a loop is still active.
	# KEYED per workstream (`<workstream>.LOOP_BLOCKED`), so each is named with
	# the loop it actually binds — a bare signal reported without an owner is
	# how one session's blocker came to be read as everyone's.
	local sig sig_ws found_signal=0
	for sig in "$gate_dir"/*.LOOP_BLOCKED; do
		[ -f "$sig" ] || continue
		found_signal=1
		sig_ws="$(basename -- "$sig")"
		sig_ws="${sig_ws%.LOOP_BLOCKED}"
		reason="$(head -c 2048 -- "$sig" 2>/dev/null | tr '\n\r' '  ')"
		if [ -n "${reason// /}" ]; then
			cn_say "BLOCKED signal present for workstream ${sig_ws}. Reason: $reason"
			cn_say "This ends THAT loop as a REPORTED NON-COMPLETION. Nothing is marked done, and no other workstream is affected."
		else
			cn_say "BLOCKED signal present for workstream ${sig_ws} but it carries NO REASON. The gate refuses a reason-less blocked signal rather than honouring it, so this does not end the loop."
		fi
	done

	# A bare file left by a version that predates the keyed name. Reported with
	# the exact correction and never honoured for anyone: a blocker that cannot
	# say whose it is would end the wrong run.
	if [ -f "$gate_dir/LOOP_BLOCKED" ]; then
		found_signal=1
		reason="$(head -c 2048 -- "$gate_dir/LOOP_BLOCKED" 2>/dev/null | tr '\n\r' '  ')"
		# NOT honouring it and NOT showing it are different things. The operator
		# has to read the reason to decide which workstream it belonged to — that
		# is the whole point of reporting rather than deleting it — so the
		# content is surfaced here while the gate still refuses to act on it.
		if [ -n "${reason// /}" ]; then
			cn_say "UNKEYED BLOCKED signal present at $gate_dir/LOOP_BLOCKED. Reason: $reason"
			cn_say "This would be a REPORTED NON-COMPLETION for whichever loop it belongs to — but it names no workstream, so it is NOT honoured for any of them and nothing is marked done."
		else
			cn_say "UNKEYED BLOCKED signal present at $gate_dir/LOOP_BLOCKED but it carries NO REASON. The gate refuses a reason-less blocked signal rather than honouring it, and an unkeyed one is not honoured for any loop either."
		fi
		cn_say "To apply it to a workstream: mv $gate_dir/LOOP_BLOCKED $gate_dir/<workstream>.LOOP_BLOCKED"
	fi
	[ "$found_signal" -eq 1 ] || : # nothing raised; say nothing

	if ! loop="$(cn_active_loop "$gate_dir")"; then
		# "No active loop" is a true but useless answer when a loop just ENDED —
		# and a loop that ended as LOOP_PARTIAL is precisely the one an operator
		# is asking about. Report the most recent ended loop and, above all,
		# what was blocked and why: that question has to be answerable AFTER the
		# ending, which is the only time anyone asks it.
		#
		# THE GLOB MUST REACH A RETIRED LOOP, and `*.state` does: the gate renames
		# a finished workstream to `_ended-<owner>-<token>.state`, which is a
		# leading underscore rather than a leading dot, so it is matched here
		# exactly as `_anon-*` and `_ws-*` are. This is the ONE reader that has to
		# see the retired namespace — every other lister in this project is
		# looking for a live loop and is right to pass over it. Narrowing this
		# glob to the live prefixes would make `status` answer "nothing here" for
		# every run that has ever finished, which is the only time anyone asks.
		local newest="" f
		for f in "$gate_dir"/*.state; do
			[ -f "$f" ] || continue
			if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest="$f"; fi
		done
		if [ -n "$newest" ]; then
			cn_say "no active loop. Most recent: $(cn_get "$newest" goal_folder) — status $(cn_get "$newest" status), iteration $(cn_get "$newest" iteration)"
			local ended_checked ended_unchecked ended_blocked ended_named
			ended_checked="$(cn_get "$newest" acs_checked)"
			ended_unchecked="$(cn_get "$newest" acs_unchecked)"
			ended_blocked="$(cn_get "$newest" acs_blocked)"
			if [ -n "$ended_checked$ended_unchecked" ]; then
				case "$ended_blocked" in
				'' | 0 | '<not-run>')
					cn_say "last evaluation: ${ended_checked:-?} met, ${ended_unchecked:-?} outstanding" ;;
				*)
					cn_say "last evaluation: ${ended_checked:-?} met, ${ended_unchecked:-?} outstanding, ${ended_blocked} BLOCKED" ;;
				esac
			fi
			ended_named="$(cn_get "$newest" blocked_criteria)"
			if [ -n "$ended_named" ]; then
				cn_say "blocked criteria: $ended_named"
			fi
		fi
		cn_say "no active loop. Start one with: pursue-goal <folder>"
		return 1
	fi

	status="$(cn_get "$loop" status)"
	folder="$(cn_get "$loop" goal_folder)"
	iteration="$(cn_get "$loop" iteration)"

	cn_say "workstream: $(basename -- "$loop")"
	cn_say "status: ${status:-<unrecorded>}   iteration: ${iteration:-0}"
	cn_say "goal folder: ${folder:-<unrecorded>}"
	cn_say "criteria: $(cn_get "$loop" acs_path)"

	local checked unchecked blocked blocked_named
	checked="$(cn_get "$loop" acs_checked)"
	unchecked="$(cn_get "$loop" acs_unchecked)"
	blocked="$(cn_get "$loop" acs_blocked)"
	if [ -n "$checked$unchecked" ]; then
		# The blocked count joins the line only when there IS one, so a loop with
		# nothing blocked prints exactly what it always printed.
		case "$blocked" in
		'' | 0 | '<not-run>')
			cn_say "last evaluation: ${checked:-?} met, ${unchecked:-?} outstanding"
			;;
		*)
			cn_say "last evaluation: ${checked:-?} met, ${unchecked:-?} outstanding, ${blocked} BLOCKED"
			;;
		esac
	else
		cn_say "last evaluation: none yet — the gate has not evaluated this loop."
	fi

	# What is blocked and why, in one place — the 60-second question. The gate
	# recorded these at the ending; re-deriving them here would be a second
	# answer that could disagree with the one the decision was taken on.
	blocked_named="$(cn_get "$loop" blocked_criteria)"
	if [ -n "$blocked_named" ]; then
		cn_say "blocked criteria: $blocked_named"
	fi

	# The health surface (S32): the last few decisions, from the run log, so
	# "is this loop healthy or grinding?" is answerable from this one command
	# rather than by reading a transcript.
	local runlog="${folder%/}/run-log.jsonl"
	if [ -f "$runlog" ]; then
		cn_say "run log: $runlog"
		cn_say "recent decisions (newest last):"
		tail -5 -- "$runlog" 2>/dev/null |
			jq -r '"  " + (.iteration|tostring) + "  " + (.decision // "?") + "  " + ((.unchecked // "?")|tostring) + " outstanding"' 2>/dev/null ||
			tail -5 -- "$runlog" 2>/dev/null | sed 's/^/  /'
	else
		cn_say "run log: none yet at $runlog — the gate has not written a decision."
	fi

	local stall_count stall_raw_count stall_max recovery_credits
	stall_count="$(cn_get "$loop" stall_count)"
	stall_raw_count="$(cn_get "$loop" stall_raw_count)"
	stall_max="$(cn_get "$loop" stall_max)"
	recovery_credits="$(cn_get "$loop" recovery_credits)"
	if [ -n "$stall_count" ]; then
		cn_say "stall counter: ${stall_count}/${stall_max:-?} consecutive identical evaluations"
		if [ -n "$stall_raw_count" ] && [ "$stall_raw_count" != "$stall_count" ]; then
			cn_say "raw Stop count: $stall_raw_count; acknowledged recovery credits: ${recovery_credits:-0}"
		fi
	fi
	local stall_reset_at stall_reset_from
	stall_reset_at="$(cn_get "$loop" stall_reset_at)"
	stall_reset_from="$(cn_get "$loop" stall_reset_from)"
	if [ -n "$stall_reset_at" ]; then
		cn_say "stall counter last reset: ${stall_reset_at} (was ${stall_reset_from:-<unrecorded>})"
	fi

	local owner
	owner="$(cn_get "$loop" claimed_by)"
	if [ -n "$owner" ]; then
		cn_say "claimed by conversation: $owner"
	else
		cn_say "UNCLAIMED — written by pursue-goal, not yet picked up by the gate."
	fi

	return 0
}

# --- cancel ----------------------------------------------------------------

cn_cancel() {
	local start="${1:-$PWD}" force="${2-}" gate_dir loop owner status

	if ! gate_dir="$(cn_gate_dir "$start")"; then
		cn_die 1 "no loop is running here — nothing to cancel. (Reported rather than passed over silently: a cancel that finds nothing may mean you are in the wrong directory.)" || return
	fi

	if ! loop="$(cn_active_loop "$gate_dir")"; then
		cn_die 1 "no active loop in $gate_dir — nothing to cancel." || return
	fi

	owner="$(cn_get "$loop" claimed_by)"
	if [ -n "$owner" ] && [ "$force" != "--force" ]; then
		local me="${GOAL_GATE_IDENTITY-}"
		if [ -z "$me" ]; then
			cn_die 3 "this loop is claimed by conversation $owner, and this process cannot establish its own identity — so it cannot show the loop is its own. Not knowing whose run this is, is not permission to end it: re-run with --force if you mean to end it anyway." || return
		fi
		if [ "$me" != "$owner" ]; then
			cn_die 3 "this loop is claimed by another conversation ($owner), not this one. Ending someone else's in-flight run is not something to do by accident — re-run with --force if that is what you mean." || return
		fi
	fi

	status="$(cn_get "$loop" status)"

	# A cancel is a reported END. The unmet counts stay exactly as they were:
	# nothing here may leave a record that could later be read as completion.
	bash "$CN_LOOP_STATE" set "$loop" status cancelled || {
		cn_die 5 "cannot write the cancelled status to $loop" || return
	}
	bash "$CN_LOOP_STATE" set "$loop" cancelled_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || true
	bash "$CN_LOOP_STATE" set "$loop" cancelled_from_status "${status:-<unrecorded>}" || true

	cn_say "cancelled $(basename -- "$loop") (was: ${status:-<unrecorded>})."
	cn_say "This is a reported END, NOT a completion. Outstanding criteria remain outstanding: $(cn_get "$loop" acs_unchecked | tr -d '\n') unmet at the last evaluation."
	cn_say "Start again with: pursue-goal $(cn_get "$loop" goal_folder)"
}

# --- reset repeated-yield / stall accounting ------------------------------
#
# This is deliberately narrower than cancel: it does not alter status,
# ownership, criteria, evidence, or iteration. It only makes the next gate
# evaluation a fresh baseline. That gives an operator a recovery valve when
# excess turn endings have consumed the warning window, without converting a
# stalled or unfinished goal into a pass.

cn_reset_stall() {
	local start="${1:-$PWD}" force="${2-}" gate_dir loop owner previous now field token

	# Permit the useful current-directory form `reset-stall --force` as well as
	# the documented `reset-stall <dir> --force`.
	if [ "$start" = "--force" ]; then
		force="--force"
		start="$PWD"
	fi

	if ! gate_dir="$(cn_gate_dir "$start")"; then
		cn_die 1 "no loop is running here — no stall counter can be reset." || return
	fi
	if ! loop="$(cn_active_loop "$gate_dir")"; then
		cn_die 1 "no active loop in $gate_dir — a terminal loop is history and cannot be revived by resetting its counter." || return
	fi

	owner="$(cn_get "$loop" claimed_by)"
	if [ -n "$owner" ] && [ "$force" != "--force" ]; then
		local me="${GOAL_GATE_IDENTITY-}"
		if [ -z "$me" ]; then
			cn_die 3 "this loop is claimed by conversation $owner, and this process cannot establish its own identity. Re-run with --force only if you explicitly intend to reset that active loop's stall counter." || return
		fi
		if [ "$me" != "$owner" ]; then
			cn_die 3 "this loop is claimed by another conversation ($owner), not this one. Re-run with --force only if you explicitly intend to reset its active stall counter." || return
		fi
	fi

	previous="$(cn_get "$loop" stall_count)"
	now="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
	token="$(cn_get "$loop" recovery_token)"
	for field in stall_hash stall_period_raw_count stall_window stall_warned_at \
		recovery_hash recovery_owner recovery_turn_id recovery_ack_at \
		recovery_guard_hash recovery_credits recovery_credit_applied; do
		bash "$CN_LOOP_STATE" set "$loop" "$field" "" || {
			cn_die 5 "cannot clear $field while resetting stall accounting for $loop" || return
		}
	done
	bash "$CN_LOOP_STATE" set "$loop" stall_count 0 || {
		cn_die 5 "cannot reset stall_count for $loop" || return
	}
	bash "$CN_LOOP_STATE" set "$loop" stall_reset_at "$now" || {
		cn_die 5 "cannot record the stall-counter reset for $loop" || return
	}
	bash "$CN_LOOP_STATE" set "$loop" stall_reset_from "${previous:-<unrecorded>}" || {
		cn_die 5 "cannot record the previous stall counter for $loop" || return
	}
	# Clear the capability last. Until every other reset write succeeds, its
	# marker remains consumed and cannot become reusable after a partial reset.
	bash "$CN_LOOP_STATE" set "$loop" recovery_token "" || {
		cn_die 5 "cannot invalidate the recovery token for $loop" || return
	}
	if [ "${#token}" -eq 64 ]; then
		case "$token" in
		*[!0-9a-f]*) : ;;
		*) rmdir -- "$gate_dir/.recovery-ack.$token" 2>/dev/null || true ;;
		esac
	fi

	cn_say "reset stall counter for $(basename -- "$loop") from ${previous:-<unrecorded>} to 0. The loop remains active; no criterion, evidence, completion state, or iteration changed."
}

# --- single-use Codex recovery acknowledgment -----------------------------

cn_valid_recovery_token() {
	[ "${#1}" -eq 64 ] || return 1
	case "$1" in
	*[!0-9a-f]*) return 1 ;;
	esac
	return 0
}

cn_recovery_ack() {
	local token="${1-}" start="${2:-$PWD}" gate_dir loop current hash owner claimed
	local turn stored_guard current_guard ack_dir now

	cn_valid_recovery_token "$token" || {
		cn_die 2 "recovery-ack requires the exact 64-character token from the Stop instruction." || return
	}
	if ! gate_dir="$(cn_gate_dir "$start")"; then
		cn_die 4 "the recovery token is foreign or expired: no active goal gate governs $start." || return
	fi
	if ! loop="$(cn_active_loop "$gate_dir")"; then
		cn_die 4 "the recovery token is foreign or expired: this goal gate has no active loop." || return
	fi

	current="$(cn_get "$loop" recovery_token)"
	hash="$(cn_get "$loop" recovery_hash)"
	owner="$(cn_get "$loop" recovery_owner)"
	claimed="$(cn_get "$loop" claimed_by)"
	turn="$(cn_get "$loop" recovery_turn_id)"
	stored_guard="$(cn_get "$loop" recovery_guard_hash)"
	current_guard="$(cn_recovery_guard_hash "$loop")" || current_guard=""
	if [ "$current" != "$token" ] || [ -z "$hash" ] || [ -z "$owner" ] || \
		[ "$owner" != "$claimed" ] || [ -z "$turn" ] || [ -z "$stored_guard" ] || \
		[ "$stored_guard" != "$current_guard" ]; then
		cn_die 4 "the recovery token is foreign or expired. Use only the token in the newest Stop instruction." || return
	fi

	ack_dir="$gate_dir/.recovery-ack.$token"
	if [ -e "$ack_dir" ]; then
		cn_die 4 "the recovery token was already used. One progress state can receive only one recovery credit." || return
	fi
	if ! mkdir -- "$ack_dir" 2>/dev/null; then
		if [ -e "$ack_dir" ]; then
			cn_die 4 "the recovery token was already used. One progress state can receive only one recovery credit." || return
		fi
		cn_die 5 "the recovery acknowledgment could not be recorded in $gate_dir." || return
	fi

	now="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
	if ! bash "$CN_LOOP_STATE" set "$loop" recovery_ack_at "$now"; then
		rmdir -- "$ack_dir" 2>/dev/null || true
		cn_die 5 "the recovery acknowledgment marker was created, but its time could not be recorded." || return
	fi

	cn_say "accepted one recovery credit for the current unchanged progress state. The raw Stop history remains intact. No criterion, evidence, iteration, or completion state changed."
}

# --- adopt -----------------------------------------------------------------
#
# See the header for why this releases rather than transfers.

cn_adopt() {
	local start="${1:-$PWD}" gate_dir loop base owner d

	if ! gate_dir="$(cn_gate_dir "$start")"; then
		cn_die 1 "no loop is running here — nothing to adopt. (Reported rather than passed over: a directory with no gate directory may just be the wrong directory.)" || return
	fi

	if ! loop="$(cn_active_loop "$gate_dir")"; then
		cn_die 1 "no active loop in $gate_dir — nothing to adopt. A loop that has ENDED (complete, cancelled, stalled, blocked) is history and is not handed over; start a new one with pursue-goal." || return
	fi

	base="$(basename -- "$loop")"
	base="${base%.state}"

	# ALLOW-LISTED ON ENTRY, before any path is composed from it — not at the
	# point of use below, where a later edit could compose one path above the
	# check and another beneath it. `$base` reaches `rm -rf` a few lines down.
	if ! cn_name_safe "$base"; then
		cn_die 2 "the workstream file in $gate_dir is not named safely, so it cannot be handed over: only letters, digits, dot, dash and underscore are permitted in a workstream name. Nothing was released." || return
	fi

	# WHICH NAMESPACES CAN BE HANDED OVER. The gate adopts from two pools, and
	# `adopt` releases a claim so that the gate's own pass 2 can take it — so the
	# two lists have to agree, or this reports success on a file the gate will
	# never pick up.
	#
	#   _anon-*   unclaimed already; releasing is a no-op but harmless
	#   _ws-*     claimed and named for its current owner. THE ORDINARY CASE:
	#             every claimed loop is `_ws-*`, so refusing this prefix would
	#             make `adopt` refuse every loop there has ever been any reason
	#             to hand over.
	#   _ended-*  refused. An ended loop is history, not a run to take over.
	#   anything else — a self-bound `<identity>.state` — refused: releasing its
	#             claim would not make it adoptable, because no pass considers it.
	case "$base" in
	_ended-*)
		cn_die 2 "workstream $base has ENDED, so it is history rather than a run to hand over. Nothing about it can be taken up again; start a new one with pursue-goal." || return
		;;
	_anon-* | _ws-*) : ;;
	*)
		cn_die 2 "workstream $base is bound to a named conversation rather than being an adoptable one, so it cannot be handed over. Cancel it and start again with pursue-goal." || return
		;;
	esac

	owner="$(cn_get "$loop" claimed_by)"

	# Every generation, not only the highest: leaving an older one behind would
	# leave the workstream looking claimed to the gate's own generation search.
	rm -rf -- "$gate_dir/$base".claim.* 2>/dev/null

	for d in "$gate_dir/$base".claim.*; do
		[ -d "$d" ] || continue
		cn_die 5 "the claim on $base could not be released ($d is still present), so the loop is still bound to ${owner:-its previous owner}." || return
	done

	bash "$CN_LOOP_STATE" set "$loop" claim_released_from "${owner:-<unrecorded>}" || true
	bash "$CN_LOOP_STATE" set "$loop" claim_released_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || true

	cn_say "released $base from ${owner:-<unclaimed>}. It is now unclaimed."
	cn_say "THIS conversation claims it at its next turn end — nothing else to run."
	cn_say "Nothing about the goal changed: $(cn_get "$loop" acs_unchecked | tr -d '\n') criteria were outstanding at the last evaluation and still are."
}

cn_main() {
	local verb="${1-}"

	case "$verb" in
	-h | --help | '')
		# The whole leading comment block, however long it grows. A hardcoded
		# line range silently starts truncating mid-sentence the first time the
		# header gains a paragraph — as it did when `adopt` was documented.
		awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
		return 0
		;;
	esac
	shift

	case "$verb" in
	status) cn_status "${1-}" ;;
	cancel) cn_cancel "${1-}" "${2-}" ;;
	adopt) cn_adopt "${1-}" ;;
	reset-stall | reset-yield) cn_reset_stall "${1-}" "${2-}" ;;
	recovery-ack) cn_recovery_ack "${1-}" "${2-}" ;;
	scaffold) cn_scaffold "${1-}" ;;
	*) cn_die 64 "unknown verb: $verb (known: status, cancel, adopt, reset-stall, reset-yield, recovery-ack, scaffold)" ;;
	esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -uo pipefail
	cn_main "$@"
	exit $?
fi
