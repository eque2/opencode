#!/usr/bin/env bash
# goal-gate-stop.sh — the goal gate's Stop-hook entry point.
#
# Fires when an agent tries to end its turn. Reads the hook request from stdin,
# works out which agent shape sent it, binds the request to a workstream, and
# decides whether completion may be claimed.
#
# THIS FILE IS BUILT IN STAGES. T2.1 delivers stages 1-5 (payload read, agent
# detection, identity binding, gate-directory resolution, loop-state recording).
# T2.2 delivers stage 6 — the completion decision. T2.3 delivers stage 5b' — the
# claim handshake. Stall detection (T2.4), the sanctioned wait (T2.5) and the run
# log (T2.6) land in the marked slots below.
#
# Usage (hook):
#   goal-gate-stop.sh            < request.json
#   goal-gate-stop.sh --help
#
# ---------------------------------------------------------------------------
# THE GOVERNING PROPERTY — FAIL CLOSED
#
# Every unknown, error, missing input, or unrunnable check resolves to NOT DONE.
# There is no path on which a problem this script cannot understand results in
# the agent being allowed to declare the work finished.
#
# ---------------------------------------------------------------------------
# The decision contract (identical for both agents)
#
#   REFUSE  -> stdout: {"decision":"block","reason":"..."}   exit 0
#   ALLOW   -> stdout: (empty)                               exit 0
#
# There is no "allow" JSON. Silence on stdout is what lets the turn end, so
# EVERY outcome that is not a refusal has to be reached deliberately. There are
# exactly four such outcomes, and each is its own named function so that the
# fail-closed property stays checkable by reading:
#
#   gg_permit    completion is ESTABLISHED — every criterion met AND evidenced,
#                by delegated evaluations that actually ran. Writes the
#                completion record. This is the ONLY outcome that means "done".
#   gg_terminal  the loop ENDS without completion — LOOP_BLOCKED. A reported
#                non-completion: unmet counts preserved, no criterion marked
#                met, NO completion record.
#   gg_no_claim  the gate governs NOTHING here — no gate directory above the
#                working directory.
#   the D6 recursion bound — announced loudly, status recorded.
#
# None of the four is ever reached by an error, a timeout, or an unknown.
#
# ---------------------------------------------------------------------------
# Agent portability
#
# The hook OBJECT shape is identical across agents. The stop PAYLOAD is not:
#
#   Claude-shaped: session_id, transcript_path, stop_hook_active, cwd
#   Codex-shaped:  turn_id, last_assistant_message   (NO session_id)
#
# VERIFICATION STATUS: both field sets are confirmed. The A1 spike established
# from real installed plugin manifests that the hook OBJECT shape is identical
# across the two agents —
#   {"hooks":{"Stop":[{"matcher":...,"hooks":[{"type":"command","command":...}]}]}}
# — and that Codex payloads carry turn_id and last_assistant_message where
# Claude payloads carry session_id and stop_hook_active. The decision contract
# is stdout {"decision":"block","reason":...} with exit 0 for both.
#
# Detection is nonetheless written so that an unknown or absent field degrades
# to REFUSE and never to a claim, and no field unique to one agent is ever
# required — a third agent, or a changed payload, must not be able to walk
# through this gate just by omitting something.
#
# ---------------------------------------------------------------------------
# Identity binding — why turn_id is never a key (review finding R1)
#
# The loop file is named for the identity, so the identity is what decides
# whether two invocations are the same workstream.
#
#   session_id present -> bind on it. It is stable for the whole session.
#   otherwise          -> bind on a DERIVED STABLE KEY:
#                             derived-<sha256(absolute gate directory)[0..31]>
#
# `turn_id` changes every single turn. Binding on it would give every turn its
# own loop file, so the iteration counter would read 1 forever and the loop
# could never detect a stall. It is recorded for diagnostics and is NEVER a key.
#
# The derived key hashes the resolved absolute gate directory, so it is stable
# across turns, stable across working directories inside the same workstream,
# and distinct between workstreams. It is also composed only of hex, so it can
# never carry a path separator into a filename.
#
# ---------------------------------------------------------------------------
# STAGE 5b' — the claim handshake (T2.3)
#
# WHAT A WORKSTREAM IS ON DISK. `pursue-goal` is the loop STARTER: it creates the
# gate directory and writes the loop file as an UNCLAIMED workstream named
# `_anon-<token>.state`, then deliberately ends its one bootstrap turn so this
# passive hook can fire, claim it, and begin blocking. That initial hand-off is
# not permission to yield again for ordinary waits: active work must hard-wait
# or poll inside its turn. The hook never starts a loop; it only ever finds
# state to claim.
#
# THE NAME SAYS WHICH POOL THE FILE IS IN. Three namespaces, and a file moves
# between them exactly when its situation changes:
#
#   _anon-<token>.state          unclaimed, written by pursue-goal
#   _ws-<identity>.state         claimed, named for its current owner
#   _ended-<identity>-<t>.state  retired: this loop reached a terminal status
#
# A conversation that claims (or reclaims) a workstream RENAMES it to
# `_ws-<its own identity>`, and the gate renames it again to
# `_ended-<identity>-<birth-token>` on the turn it reaches a terminal status.
# Retirement is therefore STRUCTURAL: the adoptable glob cannot see a finished
# loop at all, which is what stops an unrelated session picking up a completed
# goal and being held to criteria it has never seen (the field defect this
# scheme exists to close). Nothing is ever deleted — a retired file stays on
# disk for `cancel.sh status` and for audit.
#
# THE NAME IS NEVER LOAD-BEARING. Every rename is best-effort: if it cannot
# complete, the loop keeps working under its old name and the turn is governed
# exactly as before. Ownership is decided by the claim directory and by the
# `binding_identity` field, never by a glob.
#
# So "bind a workstream to a conversation" means: work out which adoptable
# `.state` file this conversation owns, claiming one if it owns none yet.
#
# THE CLAIM IS `mkdir`, AND THAT IS THE WHOLE POINT (ancestor defect D10). For a
# workstream `B` the claim is a GENERATION directory `B.claim.<n>`, n counting up
# from 1; the claim in force is the highest generation that exists. `mkdir`
# either creates it or fails with EEXIST, indivisibly, in the kernel — so of two
# conversations ending a turn at the same instant, exactly one can succeed. The
# ancestor tested first and acted second, and a check-then-act IS the race: both
# conversations can pass `[ -e ]` before either of them writes. No such sequence
# appears here.
#
# Numbering the generation is what makes RECLAIMING single-winner too, by making
# the observation part of the write — see the note above gg_claim_dir for the
# cascade that a simpler scheme produced, and the measurement that found it.
#
# Each generation directory holds two files, written immediately after it is
# created:
#   owner      the claiming conversation's identity
#   heartbeat  epoch seconds, refreshed on every turn the owner takes
#
# RESOLUTION IS A STATED RULE, NEVER READDIR ORDER. Candidates are the regular
# files matching `_anon-*.state` OR `_ws-*.state` in the gate directory, whose
# basenames pass the same identity allow-list as any other path component,
# sorted ASCENDING under `LC_ALL=C` — a byte-wise collation that does not move
# with the locale. The FIRST candidate that a pass can resolve wins. Three
# passes, in this order:
#
#   1. a workstream already owned by this conversation  -> `existing`
#   2. the first UNCLAIMED workstream                   -> `claimed`
#   3. the first claim whose owner has gone silent      -> `reclaimed`
#
# and if none resolves, the conversation SELF-BINDS on its own identity exactly
# as it did before T2.3 — `<identity>.state`, no lock, unchanged behaviour for a
# gate directory that holds no unclaimed workstream.
#
# ONLY `_anon-*` AND `_ws-*` WORKSTREAMS ARE EVER ADOPTED, and each for its own
# reason. `_anon-*` is unclaimed, so anybody may take it. `_ws-*` is claimed —
# but a claim whose owner has died must still be reclaimable (R8), so a claimed
# workstream stays in the pool and is protected by its live claim rather than by
# its name. The prefix marks the POOL; the claim marks the OWNER.
#
# The other two namespaces are outside the pool entirely:
#
#   `<identity>.state` — a SELF-BOUND loop, named for the conversation that owns
#   it and never a candidate for any pass. That is what keeps two sessions in
#   DIFFERENT repositories safe when they share one user-global state directory:
#   each self-binds under its own identity, and neither is ever eligible to take
#   over the other's file, however long the other has been idle. It is also
#   never RETIRED by a rename — there is nothing to hide it from, since nobody
#   else could ever adopt it.
#
#   `_ended-*` — a RETIRED loop. Structurally invisible to all three passes.
#   Only its own owner ever reaches it, through gg_ended_own, and only after
#   proving ownership by exact `binding_identity` — never by the glob, which
#   cannot distinguish `_ended-sess-*` from `_ended-sess-happy-*`.
#
# LIVENESS (review finding R8, scenario S58). Without a reclaim rule a crashed
# session renders its workstream permanently unclaimable — the loop can never be
# picked up again by anyone. So a claim whose owner has written no heartbeat
# within GOAL_GATE_LIVENESS_WINDOW seconds (default 900) is reclaimable, and the
# reclamation is REPORTED: on stderr, and as `claim_event=reclaimed` with
# `reclaimed_from` and `reclaim_reason` in the loop file. A claim carrying no
# readable heartbeat at all is reclaimable too — that is a lock abandoned
# part-built, and treating it as live would restore the very wedge R8 names.
#
# The takeover is the SAME atomic primitive as the first claim: a conversation
# that read generation n takes over by creating generation n+1, so of every
# conversation that saw n exactly one succeeds and the losers re-read and find a
# fresh generation they must not touch. No second mutex is involved, so there is
# none a crash can leave held, and a conversation that dies mid-takeover leaves
# a heartbeatless generation which is itself reclaimable. Nothing wedges.
#
# WHICH DIRECTION EACH UNKNOWN FAILS. Note that "fail closed" here is about
# COMPLETION, and the conservative answer for ownership is not always the same
# one. If the clock cannot be read, staleness cannot be established, so the
# existing claim STANDS and is not stolen. If a claim is won but its ownership
# cannot be recorded, the lock is released and the gate REFUSES rather than
# proceeding on a claim it could not write down. Neither unknown ever reaches a
# permit: claim resolution decides which state file is used, and nothing about
# it can mark a criterion met.
#
# ---------------------------------------------------------------------------
# Ancestor defects fixed here
#
#   D10 The ancestor claimed an unclaimed workstream by testing for it and then
#       taking it — two conversations ending a turn together could both observe
#       it as free and both proceed. Here the claim is a single atomic `mkdir`
#       and the takeover a single unique-target `mv`, so exactly one wins.
#
#   D6  The ancestor re-blocked without bound whenever the recursion flag was
#       already set, so a wedged loop could never be escaped. Here the iteration
#       counter is bounded: past GOAL_GATE_MAX_ITERATIONS with the recursion
#       flag set, the gate stops blocking, says so loudly on stderr, and records
#       `status=recursion_bound_exceeded` in the loop file so the trip is
#       evident rather than silent. (Stall detection proper is T2.4 — a
#       different, earlier guard. This one is only the last-resort bound.)
#
#   Three JSON invocations. The ancestor ran `echo "$INPUT" | jq` three separate
#       times. Here stdin is read ONCE and parsed by ONE jq pass.
#
#   Unguarded jq. The ancestor assumed jq existed; without it every extraction
#       silently produced the empty string and the hook exited 0 — allowing the
#       stop. Here a missing jq is reported and REFUSES.
#
# ---------------------------------------------------------------------------
# Security
#
# No payload value is ever evaluated as shell. Values arrive base64-encoded from
# jq and are decoded through `base64`; they never reach eval, an unquoted
# heredoc, `printf "$value"`, a command substitution as code, or an interpolated
# awk/sed program. `$(rm -rf /)` in any field is inert text on every path.
#
# Identities are validated against a strict allow-list BEFORE any path is
# composed from them, so `/`, `..`, a NUL byte, or any other separator is
# rejected rather than escaping (or entering) the guarded directory.
#
# ---------------------------------------------------------------------------
# Environment overrides (all optional; tests use them)
#
#   GOAL_GATE_DIR             absolute path of the gate directory, skipping the
#                             upward walk
#   GOAL_GATE_MARKER          marker directory name to walk up for (.goal-gate)
#   GOAL_GATE_MAX_ITERATIONS  recursion bound (default 50)
#   GOAL_GATE_LOOP_STATE      path to loop-state.sh
#   GOAL_GATE_PARSE_ACS       path to parse-acs.sh   (T1.3)
#   GOAL_GATE_VALIDATE_ACS    path to validate-acs.sh (T1.6)
#   GOAL_GATE_ACS             path to the ACs.md under evaluation
#   GOAL_GATE_DECISION_BUDGET seconds allowed for the whole decision (default
#                             120 — see the timing note below)
#   GOAL_GATE_LIVENESS_WINDOW seconds a claim survives without a heartbeat
#                             before it may be reclaimed (default 900)
#   GOAL_GATE_STALL_MAX       consecutive identical evaluations before a stall
#                             is declared (default 5)
#   GOAL_GATE_HASH_TOOL       explicit hashing command, overriding the
#                             shasum/sha256sum search (tests use it to prove
#                             an unavailable tool refuses)
#   GOAL_GATE_WAIT_MAX_CUMULATIVE
#                             aggregate seconds a single loop may spend in a
#                             sanctioned wait before further waits are refused
#                             (default 86400 — review finding R7)
#
# Files the gate reads from the gate directory:
#   LOOP_BLOCKED  a declared blocker; terminal, and REQUIRES a written reason
#   WAIT          a sanctioned-wait declaration: one line, an epoch-second
#                 deadline. Suspends stall accounting, never permits completion
#
# ---------------------------------------------------------------------------
# STAGE 6 — the completion decision (T2.2)
#
# WHAT "DONE" MEANS HERE. Completion is permitted only when BOTH delegated
# evaluations ran to a trustworthy conclusion and both say so:
#
#   parse-acs.sh    (T1.3) — counting and the verdict. The single source of
#                   verdict truth; this file re-implements none of it.
#   validate-acs.sh (T1.6) — evidence enforcement. This is the definition of
#                   the "AND evidenced" half. A tick with no evidence block is
#                   refused as `ticked-without-evidence` (review finding R12) —
#                   the rule that stops a self-certified tick.
#
# Both are run, and their totals are cross-checked. Where they disagree the run
# FAILS CLOSED rather than picking a winner.
#
# ANCESTOR DEFECT D1 — THE MARQUEE FIX. The ancestor ran its checks as
# `claude -p 2>/dev/null` and, on error, timeout or absence, consumed the EMPTY
# RESULT AS A PASS. It therefore reported completion it had never verified.
# Here a delegated evaluation that could not run is NOT a pass and is NOT
# silence: it is reported as `not-run` and it REFUSES. Concretely, an exit code
# outside the delegate's documented set, a delegate that is missing or
# unreadable, and an exit 0 whose stdout carries no `verdict=` line are all
# treated as "could not run" rather than as "nothing outstanding".
#
# TIMING (review finding R3). The budget is the TIGHTEST host timeout: the live
# Claude registration uses `timeout: 120`, so 120 s — NOT Codex's 600 s default.
# A decision that overruns is a REPORTED FAILURE (a refusal naming the budget),
# never a silent permit. The gate enforces this itself rather than trusting the
# host, because a host that kills a hook may treat the dead hook as consent.
#
# LOOP_BLOCKED (review finding R5). The predecessor let the gated agent end its
# own turn by declaring itself blocked — an agent-writable fail-open, a one
# `touch` exit from the whole contract, by the exact actor the gate exists to
# constrain. Here raising it terminates the loop as a REPORTED NON-COMPLETION:
# it never marks a criterion met, never emits a completion record, preserves the
# unmet counts in the loop file, and REQUIRES a written reason — a blocked
# signal carrying no reason is refused, not honoured. It is also checked BEFORE
# the permit branch, so it can never be combined with a completion claim.
#
# ZERO CRITERIA IS NOT "ALL COMPLETE" (the vacuous-truth trap). Delegated to the
# two evaluators, which both exit 2 on an empty checklist; that exit refuses.
#
# Exit codes: 0 in every hook path — the decision is carried on stdout, per the
# contract. Non-zero is reserved for a usage error (64).

# Byte semantics everywhere: ${#var} must count BYTES, not characters, for the
# NUL/loss detection below to mean anything.
export LC_ALL=C

GG_MARKER="${GOAL_GATE_MARKER:-.goal-gate}"
GG_MAX_ITERATIONS="${GOAL_GATE_MAX_ITERATIONS:-50}"

# THE THREE WORKSTREAM NAMESPACES. A workstream file's prefix says WHICH POOL it
# is in, and nothing else — the claim itself is always the `.claim.<n>` directory
# beside it, never the name.
#
#   _anon-<token>          UNCLAIMED. `pursue-goal` writes exactly this and
#                          nothing else; the unclaimed name IS the handshake.
#   _ws-<identity>         CLAIMED by the conversation it names. Still adoptable
#                          (a dead owner's loop must be reclaimable), so the
#                          prefix marks the POOL, not the claim.
#   _ended-<identity>-<t>  RETIRED. Never adoptable by anyone, and only its own
#                          owner ever looks it up again — by exact
#                          `binding_identity`, never by the glob alone.
#
# `<identity>.state`, with no prefix at all, is a SELF-BOUND loop: named for the
# conversation that owns it, never adopted, and deliberately never retired.
#
# The namespaces are told apart by prefix, so they rest on no identity beginning
# with one of them. That USED to be an assumption about the host — an identity is
# either a host-issued session id or `derived-<hex>`, and neither was expected to
# start with an underscore — and an assumption is not a guarantee. An identity of
# `_anon-x` names the self-bound file `_anon-x.state`, which IS the unclaimed
# pool: the conversation's own private loop becomes a candidate any other
# conversation may claim, and `_ws-x`/`_ended-x` collide with the claimed and
# retired namespaces the same way.
#
# So disjointness is ENFORCED rather than assumed: gg_identity_reserved rejects
# any identity beginning with one of these three prefixes, and the identity is
# refused before a single path is composed from it. See STAGE 4.
GG_ANON_PREFIX="_anon-"
GG_WS_PREFIX="_ws-"
GG_ENDED_PREFIX="_ended-"

# Seconds a claim survives without a heartbeat before it may be reclaimed.
# 900 is deliberately far longer than the 120 s decision budget: the gate must
# never mistake a conversation that is simply working between turns for a dead
# one, and reclaiming a live workstream would silently reset its iteration
# counter and lose the stall history.
GG_LIVENESS_WINDOW="${GOAL_GATE_LIVENESS_WINDOW:-900}"

# --- stall accounting (T2.4) -----------------------------------------------
#
# ANCESTOR DEFECT D3. The ancestor compared TOTAL iterations against its
# threshold and kept `STALL_COUNT`/`CONSECUTIVE` variables that were assigned
# and never read — so it could not distinguish a loop grinding on the same
# failure from one making steady progress over many turns. What matters is
# CONSECUTIVE identical evaluations, and progress must reset the count.
#
# ANCESTOR DEFECT D8. Its hash came from a tool it never checked for, so on a
# machine without `shasum` the hash was EMPTY — and empty compared equal to the
# previous empty, manufacturing a stall on iteration 2 and killing healthy
# loops. Here a hash that cannot be computed is an ERROR that REFUSES. The gate
# keeps blocking (fail closed) rather than terminating a loop it could not
# measure: a missed stall costs iterations, a spurious one destroys work.
#
# THE FLAP RULE. Consecutive-identical alone cannot see a loop oscillating
# between two states (A,B,A,B) — no two adjacent turns match, so it would run
# forever. A bounded window of recent hashes closes that: when the window is
# full and holds at most two distinct states, the loop is going nowhere by a
# longer route. The window is 2x the threshold — the same point at which plain
# repetition ends the loop, so oscillation and repetition are given equal rope
# and neither is called early. A false stall is the expensive direction. This
# rule is DOCUMENTED, not accidental: the task brief requires flapping either to
# stall or to be explicitly stated as not stalling.
#
# THE THRESHOLD IS A WARNING, NOT THE EXECUTION. Reaching it ESCALATES the
# refusal — the loop is told, in the reason the model reads and in a line the
# operator sees, that nothing measurable has changed for this many turns. The
# loop is only ENDED at twice the threshold. A stall that kills on first sight
# gives the agent no turn in which to act on the diagnosis, and killing a loop
# that would have recovered costs the entire run; spending N further turns to be
# sure costs N turns. The asymmetry decides it.
#
# What "measurable" means is defined by gg_repo_progress as well as the
# checklist: a turn that commits or edits anything is progress even if no
# criterion was ticked.
GG_STALL_MAX_DEFAULT=8
GG_STALL_WINDOW_CAP=64

# --- the sanctioned wait (T2.5) --------------------------------------------
#
# A loop legitimately waiting on an external result — a CI run, a deploy, a
# human — may declare that wait, and stall accounting is SUSPENDED for its
# duration. Without it, a loop doing exactly the right thing gets killed for
# not changing.
#
# THE R7 CEILING is what stops the mirror-image abuse. A wait that can be
# re-declared every iteration freezes stall accounting forever while never
# permitting completion — so the loop satisfies BOTH safety mechanisms and
# lives forever. An aggregate ceiling makes the wait a delay rather than an
# escape: once spent, accounting resumes and the loop can reach a stall.
#
# DEADLINES ARE EPOCH SECONDS, deliberately. Parsing human date strings would
# mean `date -d` (GNU) or `date -j -f` (BSD), and a portability failure would
# resolve to either a silent freeze or a silent no-wait — both unacceptable
# under D6. A non-numeric declaration is rejected AND REPORTED, which covers a
# GNU-style invocation arriving on BSD userland by construction, not by luck.
#
# BAD INPUT IS REJECTED, NEVER COERCED. The ancestor stripped non-digits, so
# `abc123def` became 123 and `-5` became 5 — a deadline nobody wrote, silently
# honoured. And an over-long deadline was silently treated as "no wait", so an
# operator who believed a wait was in force simply did not have one. Here an
# over-long deadline is CLAMPED and the clamp is reported.
GG_WAIT_MAX_SINGLE=86400
GG_WAIT_MAX_CUMULATIVE="${GOAL_GATE_WAIT_MAX_CUMULATIVE:-86400}"

GG_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GG_LOOP_STATE="${GOAL_GATE_LOOP_STATE:-${GG_SELF_DIR}/loop-state.sh}"
GG_PARSE_ACS="${GOAL_GATE_PARSE_ACS:-${GG_SELF_DIR}/parse-acs.sh}"
GG_VALIDATE_ACS="${GOAL_GATE_VALIDATE_ACS:-${GG_SELF_DIR}/validate-acs.sh}"
GG_PROOF="${GOAL_GATE_PROOF:-${GG_SELF_DIR}/proof-of-fire.sh}"
GG_CANCEL="${GOAL_GATE_CANCEL:-${GG_SELF_DIR}/cancel.sh}"

# --- proof of fire ---------------------------------------------------------
#
# Recorded as soon as the payload has been parsed and its host identified,
# before any workstream is resolved or evaluated. The payload is authoritative:
# Codex does not promise to export CODEX_HOME, CODEX_SANDBOX, or AI_AGENT to
# hook commands. Depending on those optional variables made a trusted, firing
# Codex hook record itself as `unknown`, leaving `install.sh prove codex`
# permanently unsatisfied. GOAL_GATE_AGENT remains the explicit fixture/manual
# override. An unrecognised host records nothing rather than guessing, and
# pof_record never fails the gate.
gg_record_fire() {
	local detected="${1-}" agent
	agent="$detected"
	case "${GOAL_GATE_AGENT-}" in
	claude | codex) agent="$GOAL_GATE_AGENT" ;;
	esac
	case "$agent" in
	claude | codex) : ;;
	*) return 0 ;;
	esac
	[ -r "$GG_PROOF" ] || return 0
	bash "$GG_PROOF" record "$agent" "${BASH_SOURCE[0]}" 2>/dev/null || true
}

# --- diagnostics -----------------------------------------------------------

gg_note() {
	printf 'goal-gate: %s\n' "$*" >&2
}

# --- text hygiene ----------------------------------------------------------

# gg_safe_text <string> — a form fit to embed in a diagnostic or a JSON reason:
# control bytes and anything outside printable ASCII become '?'. Applied to
# every payload-derived value before it appears in output, so a hostile field
# cannot inject control characters into the decision the agent reads back.
gg_safe_text() {
	printf '%s' "${1-}" | tr -c '\11\40-\176' '?'
}

# gg_json_escape <string> — minimal JSON string-body escaping. Pure parameter
# expansion; the input has already passed gg_safe_text, so the only sequences
# that can remain needing escapes are backslash, quote and tab.
gg_json_escape() {
	local s="${1-}"
	s="${s//\\/\\\\}"
	s="${s//\"/\\\"}"
	s="${s//$'\t'/\\t}"
	printf '%s' "$s"
}

# --- the operator channel --------------------------------------------------
#
# gg_user_note <text...> — a line the OPERATOR sees.
#
# THE TWO AUDIENCES ARE SEPARATE CHANNELS, and this gate used only one of them.
# `decision` and `reason` are fed to the MODEL and are never displayed to the
# user; `systemMessage` is displayed to the user and is never seen by the model.
# So every path that ENDED a loop — a stall, a flap, the D6 bound, a bystander
# standing down, even completion itself — reported to stderr only, and a host
# treats a non-blocking hook's stderr as a diagnostic rather than as output. The
# loop died and the operator watched a turn simply finish, with nothing said.
# That is the "it just stopped" defect, and it is not a cosmetic one: the whole
# value of ending a loop for a stated reason is lost if nobody is told the
# reason.
#
# EMITTING THIS DOES NOT PERMIT ANYTHING. Only a `decision` key can block, and
# this object deliberately carries none, so the turn ends exactly as it did when
# stdout was empty. Silence is still what lets a turn end; this attaches an
# explanation to that silence, never a permission — which is why it is safe to
# call from the permit path as well as the terminal ones.
gg_user_note() {
	printf '{"systemMessage":"goal-gate: %s"}\n' \
		"$(gg_json_escape "$(gg_safe_text "$*")")"
}

# --- the two terminal outcomes ---------------------------------------------
#
# Everything in this script funnels into exactly one of these. Keeping them as
# the sole exits is what makes the fail-closed property checkable by reading.

# gg_refuse <reason...> — the work is NOT done. Blocks, always exit 0.
#
# GG_USER_MESSAGE, when set, is folded into the SAME JSON object rather than
# printed as a second one. Two objects on stdout is not a richer message, it is
# a parse failure — and a host that cannot parse a hook's output has no decision
# to act on, which is the fail-open direction.
GG_USER_MESSAGE=""
# The stop host gives `reason` to the model. It gives `systemMessage` to the
# operator only. Keep confirmed Codex payload state available to gg_refuse so
# Codex receives recovery instructions in the only channel that can change it.
# A turn ID alone identifies a Codex-shaped request, but it does not prove the
# full Codex Stop payload. The recovery guard needs its stable session binding,
# so enable it only when the request has both usable identity fields.
GG_CODEX_RECOVERY_ELIGIBLE=0
# The gate issues this command only while the current progress state has an
# unused recovery capability. The command is part of the model-visible block
# reason. It is never evidence and it never changes a criterion.
GG_RECOVERY_ACK_COMMAND=""
# A block is delivered to the agent as a new instruction. Make the operational
# consequence explicit there as well as in pursue-goal: yielding just to await
# ordinary work re-invokes this gate and burns the stall budget without progress.
GG_YIELD_DISCIPLINE_MESSAGE="continue the active goal in this turn: do not yield or send a status-only response for ordinary command, browser, subagent, or background waits; hard-wait or poll instead. Extra turn endings trigger the gate and consume stall accounting. The only intentional ending is the single bootstrap hand-off or a true terminal boundary."
gg_refuse() {
	local reason msg
	reason="$(gg_safe_text "$*")"
	# A Codex Stop hook can refuse an ending turn, but it cannot itself start
	# another task. The former instruction lived only in `systemMessage`, which
	# Codex does not show to the model. Put the recovery instruction in `reason`
	# for Codex, while leaving Claude's established refusal text unchanged.
	if [ "$GG_CODEX_RECOVERY_ELIGIBLE" -eq 1 ]; then
		reason="$reason Codex recovery: do not send another status or final response. Read the goal charter and execute the next incomplete task now. A rejected non-external command is an obstacle, not a loop blocker: use an in-scope alternative or continue another ready task. Do not declare LOOP_BLOCKED for a single denied task. Declare it only when an external prerequisite prevents every remaining task."
		if [ -n "$GG_RECOVERY_ACK_COMMAND" ]; then
			reason="$reason Before you continue, run exactly: $GG_RECOVERY_ACK_COMMAND . This single-use acknowledgment discounts only this accidental Stop. It does not reset the stall history or mark any work complete."
		fi
	fi
	msg="$(gg_safe_text "$GG_USER_MESSAGE")"
	if [ -n "$msg" ]; then
		msg="$msg $GG_YIELD_DISCIPLINE_MESSAGE"
	else
		msg="$GG_YIELD_DISCIPLINE_MESSAGE"
	fi
	printf '{"decision":"block","reason":"%s","systemMessage":"goal-gate: %s"}\n' \
		"$(gg_json_escape "$reason")" "$(gg_json_escape "$msg")"
	gg_note "REFUSE: $reason"
	gg_runlog_emit "${GG_DECISION_LABEL:-refused}"
	exit 0
}

# gg_no_claim <why...> — the gate governs nothing here. Prints NOTHING on
# stdout. Reachable only from the conditions named in the header, plus the
# PASSIVE stand-down before Stage 5c (a conversation not pursuing a goal in this
# tree) — all of them cases where this conversation is not the one the gate is
# holding.
gg_no_claim() {
	gg_note "no claim: $*"
	exit 0
}


# gg_permit <why...> — completion is ESTABLISHED. Prints NOTHING on stdout, so
# the turn may end. The ONLY outcome that means the work is done, and the only
# one that writes a completion record. Reached from exactly one place: both
# delegated evaluations ran and both reported every criterion met and evidenced.
gg_permit() {
	gg_note "PERMIT: $*"
	gg_user_note "GOAL COMPLETE - $*"
	gg_runlog_emit "${GG_DECISION_LABEL:-permitted}"
	exit 0
}

# gg_terminal <why...> — the loop ENDS without completion. Prints NOTHING on
# stdout, so the turn may end, but nothing is claimed: no criterion is marked
# met and no completion record exists.
#
# Three callers, and each has already retired the workstream by the time it gets
# here: the LOOP_BLOCKED branch, the LOOP_PARTIAL branch, and gg_stall_terminal.
# (The fourth non-completion, the recursion bound, stands down through
# gg_no_claim instead — it is not a decision about the work.) So this function
# announces an ending; it never performs one, and it reads no state.
gg_terminal() {
	gg_note "NON-COMPLETION (terminal): $*"
	gg_user_note "THE LOOP HAS ENDED WITHOUT COMPLETION - $*"
	gg_runlog_emit "${GG_DECISION_LABEL:-terminal}"
	exit 0
}

# ===========================================================================
# STAGE 1 — read the request from stdin, ONCE
# ===========================================================================

GG_PAYLOAD=""

gg_read_payload() {
	# One read. The buffer is reused for every later stage; nothing re-reads
	# stdin, and nothing spawns a second reader process.
	GG_PAYLOAD="$(cat)"
}

# ===========================================================================
# STAGE 2 — tool availability
# ===========================================================================

GG_B64_FLAG=""

# gg_have_jq — jq is the ONLY JSON parser used. Its absence is an error to be
# reported, never a reason to fall through to a claim.
gg_have_jq() {
	command -v jq >/dev/null 2>&1
}

# gg_b64_init — resolve the decode flag once. GNU coreutils and newer macOS
# accept -d; older macOS/BSD base64 only accepts -D.
gg_b64_init() {
	if printf 'eA==' | base64 -d >/dev/null 2>&1; then
		GG_B64_FLAG="-d"
		return 0
	fi
	if printf 'eA==' | base64 -D >/dev/null 2>&1; then
		GG_B64_FLAG="-D"
		return 0
	fi
	return 1
}

gg_b64_decode() {
	printf '%s' "${1-}" | base64 "$GG_B64_FLAG" 2>/dev/null
}

# gg_sha256 — hex digest of stdin, portably.
gg_sha256() {
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

# ===========================================================================
# STAGE 3 — parse the payload in ONE jq pass
# ===========================================================================
#
# One line per field: `<name> <status> <base64>`.
#   status `s` -> the field was a JSON string (or, for the flag, a JSON boolean)
#   status `x` -> absent, null, or of some other type — i.e. NOT USABLE
#
# `null` is deliberately indistinguishable from absent: the task requires a JSON
# null identity to be treated as ABSENT, never bound to "".
#
# last_assistant_message is reduced to its LENGTH inside jq and its content is
# never carried into a shell variable. A multi-megabyte message therefore costs
# one jq pass and nothing else — the resource-limit guard.
#
# The payload reaches jq on STDIN only. It is never interpolated into the jq
# program, so no field can alter what jq executes.

# shellcheck disable=SC2016  # $v is a jq parameter, not a shell variable.
GG_JQ_PROGRAM='
def enc($v): if ($v|type) == "string" then "s " + ($v|@base64) else "x " end;
if type != "object" then
  "__not_an_object__ x "
else
  "session_id " + enc(.session_id),
  "turn_id " + enc(.turn_id),
  "cwd " + enc(.cwd),
  "stop_hook_active " + (
    if .stop_hook_active == true then "s " + ("true"|@base64)
    elif .stop_hook_active == false then "s " + ("false"|@base64)
    else "x " end
  ),
  "last_assistant_message_len " + (
    if (.last_assistant_message|type) == "string"
    then "s " + ((.last_assistant_message|length|tostring)|@base64)
    else "x " end
  )
end
'

# Parsed results. `*_present` is 1 only for a usable JSON string.
GG_SESSION_ID=""
GG_SESSION_ID_PRESENT=0
GG_SESSION_ID_LOSSY=0
GG_TURN_ID=""
GG_TURN_ID_PRESENT=0
GG_TURN_ID_LOSSY=0
GG_CWD=""
GG_CWD_PRESENT=0
GG_STOP_HOOK_ACTIVE="false"
GG_LAM_LEN=""

# gg_decode_into <varname> <b64> — decode a field and set <varname>.
#
# Also sets GG_LAST_LOSSY=1 when the decoded bytes did not survive the trip into
# a shell variable intact. That happens for exactly two reasons: an embedded NUL
# (bash cannot hold one) or trailing newlines (command substitution eats them).
# Both are grounds to reject an identity rather than silently use a truncated
# one — a NUL-truncated identity is precisely how a filename gets forged.
GG_LAST_LOSSY=0
gg_decode_into() {
	local __var="$1" __b64="$2" __value __bytes
	GG_LAST_LOSSY=0
	__bytes="$(gg_b64_decode "$__b64" | wc -c | tr -d ' ')"
	__value="$(gg_b64_decode "$__b64")"
	if [ "${#__value}" != "$__bytes" ]; then
		GG_LAST_LOSSY=1
	fi
	printf -v "$__var" '%s' "$__value"
}

gg_parse_payload() {
	local parsed status name fstat b64
	local seen_session=0 seen_turn=0 seen_cwd=0 seen_flag=0 seen_lam=0

	parsed="$(printf '%s' "$GG_PAYLOAD" | jq -r "$GG_JQ_PROGRAM" 2>/dev/null)"
	status=$?

	if [ "$status" -ne 0 ]; then
		return 1
	fi
	if [ -z "$parsed" ]; then
		# jq succeeded but produced nothing: stdin held no JSON value at all.
		return 1
	fi

	while IFS=' ' read -r name fstat b64; do
		[ -n "$name" ] || continue
		case "$name" in
		__not_an_object__) return 2 ;;
		session_id)
			seen_session=$((seen_session + 1))
			[ "$seen_session" -gt 1 ] && return 3
			if [ "$fstat" = "s" ]; then
				gg_decode_into GG_SESSION_ID "$b64"
				GG_SESSION_ID_LOSSY="$GG_LAST_LOSSY"
				GG_SESSION_ID_PRESENT=1
			fi
			;;
		turn_id)
			seen_turn=$((seen_turn + 1))
			[ "$seen_turn" -gt 1 ] && return 3
			if [ "$fstat" = "s" ]; then
				gg_decode_into GG_TURN_ID "$b64"
				GG_TURN_ID_LOSSY="$GG_LAST_LOSSY"
				GG_TURN_ID_PRESENT=1
			fi
			;;
		cwd)
			seen_cwd=$((seen_cwd + 1))
			[ "$seen_cwd" -gt 1 ] && return 3
			if [ "$fstat" = "s" ]; then
				gg_decode_into GG_CWD "$b64"
				GG_CWD_PRESENT=1
			fi
			;;
		stop_hook_active)
			seen_flag=$((seen_flag + 1))
			[ "$seen_flag" -gt 1 ] && return 3
			if [ "$fstat" = "s" ]; then
				gg_decode_into GG_STOP_HOOK_ACTIVE "$b64"
			fi
			;;
		last_assistant_message_len)
			seen_lam=$((seen_lam + 1))
			[ "$seen_lam" -gt 1 ] && return 3
			if [ "$fstat" = "s" ]; then
				gg_decode_into GG_LAM_LEN "$b64"
			fi
			;;
		esac
	done <<<"$parsed"

	return 0
}

# ===========================================================================
# STAGE 4 — identity usability and safety
# ===========================================================================

# gg_identity_usable <value> — an identity is usable only if it is a non-empty,
# non-whitespace string. Empty, whitespace-only and JSON null are all ABSENT.
#
# This is the guard that stops every session collapsing onto one loop file: an
# identity bound to "" would name the same file for every workstream on the
# machine, so two unrelated loops would share an iteration counter.
gg_identity_usable() {
	local v="${1-}"
	[ -n "$v" ] || return 1
	case "$v" in
	*[![:space:]]*) return 0 ;;
	esac
	return 1
}

# gg_identity_safe <value> — must hold BEFORE any path is composed from it.
#
# Allow-list, not deny-list: only [A-Za-z0-9._-] and at most 128 bytes. That
# excludes `/`, `\`, NUL, whitespace, and every other separator, so neither
# traversal out of the guarded directory (`../../etc/passwd`) nor descent into
# it (`sub/dir/x`) can be expressed. `.` and `..` are rejected outright even
# though their characters are allowed, because as filenames they ARE the
# directory itself and its parent.
gg_identity_safe() {
	local v="${1-}"
	[ -n "$v" ] || return 1
	[ "${#v}" -le 128 ] || return 1
	case "$v" in
	. | ..) return 1 ;;
	*[!A-Za-z0-9._-]*) return 1 ;;
	esac
	return 0
}

# gg_identity_reserved <value> — 0 when the value begins with one of the three
# NAMESPACE PREFIXES, and is therefore not usable as a conversation identity.
#
# THE NAMESPACES MUST BE DISJOINT, STRUCTURALLY. A self-bound loop is named
# `<identity>.state` with no prefix at all, which is what keeps it out of every
# resolution pass. An identity of `_anon-x` would name that file `_anon-x.state`
# — indistinguishable from an UNCLAIMED workstream written by pursue-goal, so
# the conversation's own private loop would sit in the adoptable pool for any
# other conversation to claim. `_ws-x` collides with the claimed namespace and
# `_ended-x` with the retired one in exactly the same way.
#
# The allow-list in gg_identity_safe cannot express this: `_` is a legitimate
# character in a filename and the prefixes are legitimate names for FILES. It is
# the identity, not the character, that is reserved — so it is a separate test,
# applied to the identity and to nothing else.
gg_identity_reserved() {
	local v="${1-}"
	case "$v" in
	"${GG_ANON_PREFIX}"* | "${GG_WS_PREFIX}"* | "${GG_ENDED_PREFIX}"*) return 0 ;;
	esac
	return 1
}

# ===========================================================================
# STAGE 5 — locate the gate directory
# ===========================================================================

# gg_locate_gate_dir <base-dir> — prints the absolute gate directory.
#
# Return codes are load-bearing and are NOT interchangeable:
#   0  a gate directory was resolved; its absolute path is on stdout
#   1  there is NO gate directory here — the only "gate governs nothing"
#      condition derived from the filesystem
#   2  a gate directory EXISTS but could not be entered or read
#
# Collapsing 2 into 1 is a fail-open in disguise: an unreadable state directory
# would take the "governs nothing" path and end the turn in silence, which is
# the one shape a host reads as consent. It has to be REPORTED instead.
#
# The gate directory is resolved STRICTLY at the root of the repository the
# session is running in — never a parent, a shared ancestor, or ~/. Earlier this
# walked upward to $HOME, so a `.goal-gate/` on any ancestor governed every repo
# beneath it and pooled unrelated workstreams into one store: a session in repo
# A could adopt repo B's goal loop and be held to criteria it never signed up
# for. Anchoring at `git rev-parse --show-toplevel` (with the working directory
# as the fallback outside a repo) confines the gate to one repo and makes the
# READ side agree with pursue-goal's WRITE side (pg_anchor), which already
# anchored here. GOAL_GATE_DIR remains an explicit override for tests/CI.
gg_locate_gate_dir() {
	local base="${1-}" root

	if [ -n "${GOAL_GATE_DIR-}" ]; then
		[ -d "$GOAL_GATE_DIR" ] || return 1
		(cd -- "$GOAL_GATE_DIR" 2>/dev/null && pwd -P) || return 2
		return 0
	fi

	root="$(cd -- "$base" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)"
	if [ -z "$root" ]; then
		root="$(cd -- "$base" 2>/dev/null && pwd -P)" || return 1
	fi
	[ -n "$root" ] || return 1

	if [ -d "$root/$GG_MARKER" ]; then
		printf '%s\n' "$root/$GG_MARKER"
		return 0
	fi

	return 1
}

# gg_gate_absent_here <dir> — true ONLY when no gate directory governs <dir>.
#
# An existing-but-unusable gate directory is not an absence, so it does not
# satisfy this and cannot reach a `gg_no_claim`.
gg_gate_absent_here() {
	local rc=0
	gg_locate_gate_dir "${1-}" >/dev/null 2>&1 || rc=$?
	[ "$rc" -eq 1 ]
}

# gg_derived_identity <gate-dir> — the stable key used when there is no
# session_id. Hex only, so it is safe as a filename by construction.
gg_derived_identity() {
	local digest
	digest="$(printf '%s' "${1-}" | gg_sha256)" || return 1
	[ -n "$digest" ] || return 1
	printf 'derived-%s' "${digest:0:32}"
}

# ===========================================================================
# STAGE 5b' — the claim handshake (T2.3)
# ===========================================================================
#
# Fixes ancestor defect D10. See the header for the full contract; the code
# below is deliberately small enough to check against it by reading.

# Results, for the caller.
GG_WORKSTREAM=""        # basename of the resolved workstream (no .state)
GG_CLAIM_EVENT=""       # existing | claimed | reclaimed | self
GG_FOREIGN_OWNER=""   # live owner of another workstream in this tree, if any
GG_FOREIGN_OWNER_CANDIDATE=""   # its own field: never reuse GG_CLAIM_PREV_OWNER,
                                # which means "the DISPLACED owner, on a reclaim"
# The statuses that mean a workstream has ENDED. Kept in step with cancel.sh.
# LOOP_PARTIAL is a terminal NON-COMPLETION: the loop ended with its remaining
# work blocked. It is in this set so a later turn stands down instead of
# re-evaluating a run that already reported its honest ending.
GG_TERMINAL_STATUSES="complete cancelled stalled recursion_bound_exceeded LOOP_BLOCKED LOOP_PARTIAL"

# gg_loop_label <loop-file> — how a loop is named TO A PERSON.
#
# The workstream key (`_anon-b5fc67b123703245`) is internal plumbing: it exists
# so a loop can be bound to a session, and it is derived from a hash precisely
# because it must not need to mean anything. Putting it in a message a human
# reads inverts that — the reader is handed an identifier they cannot connect to
# the work they were doing, in place of the one thing they would recognise.
#
# So every user-facing message names the GOAL FOLDER. The key is kept for the
# state file, the run log and the decision trail, where a machine consumes it.
# The fallback is deliberate and narrow: only a loop with no recorded folder is
# named by its key, because then there is genuinely nothing better to say.
gg_loop_label() {
	local loop_file="${1-}" folder=""
	[ -n "$loop_file" ] || return 1
	folder="$(gg_state_get "$loop_file" "goal_folder" 2>/dev/null)"
	if [ -n "$folder" ] && [ "$folder" != "<unrecorded>" ]; then
		printf '%s' "$folder"
		return 0
	fi
	folder="$(basename -- "$loop_file" 2>/dev/null)"
	printf '%s' "${folder%.state}"
}

# gg_blocked_signal_path <gate-dir> <workstream> — the KEYED blocker file.
#
# `<workstream>.LOOP_BLOCKED`, mirroring `<workstream>.state`. One gate
# directory holds many workstreams; a BARE `LOOP_BLOCKED` said "something,
# somewhere in this repository, is blocked" and every loop in the directory read
# it as its own. One session declaring a blocker therefore ended another
# session's unrelated loop, and silenced a bystander that had no goal at all.
#
# The workstream name is allow-listed by gg_identity_safe BEFORE it is composed
# into a path — never from raw payload input — so a crafted identity cannot
# escape the gate directory. An unsafe name yields no path and the caller treats
# the signal as absent rather than guessing.
gg_blocked_signal_path() {
	local gate_dir="$1" workstream="${2-}"
	[ -n "$workstream" ] || return 1
	gg_identity_safe "$workstream" || return 1
	printf '%s/%s.LOOP_BLOCKED' "$gate_dir" "$workstream"
}

# gg_legacy_blocked_note <gate-dir> — a bare LOOP_BLOCKED left by an earlier
# version, if one exists. REPORTED, NEVER HONOURED, deliberately asymmetric:
# honouring an unattributable signal for the wrong session ends a loop that
# should be running — the defect itself — whereas declining leaves a loop
# running that someone meant to stop, which is visible, recoverable, and
# re-reported on every single turn until it is dealt with.
gg_legacy_blocked_note() {
	local gate_dir="$1" workstream="${2-}"
	[ -f "$gate_dir/LOOP_BLOCKED" ] || return 1
	printf 'an unkeyed %s/LOOP_BLOCKED is present. It names no workstream, so it is NOT honoured for any loop - a blocker that cannot say whose it is would end the wrong run. To apply it to this workstream: mv %s/LOOP_BLOCKED %s/%s.LOOP_BLOCKED' \
		"$gate_dir" "$gate_dir" "$gate_dir" "${workstream:-<workstream>}"
}
GG_CLAIM_PREV_OWNER=""  # the displaced owner, on a reclaim
GG_CLAIM_REASON=""      # why the displaced claim was judged dead
GG_CLAIM_ERROR=""       # set only when resolution itself failed
GG_CLAIM_STALE_REASON=""

# Seconds a claim directory may exist without a heartbeat before it is treated as
# abandoned. It only has to cover `mkdir` plus two small writes, so it is small —
# but it is not zero, because zero means a healthy claim is stealable in the gap
# between creating it and stamping it.
GG_CLAIM_GRACE="${GOAL_GATE_CLAIM_GRACE:-30}"
case "$GG_CLAIM_GRACE" in
'' | *[!0-9]*) GG_CLAIM_GRACE=30 ;;
esac

# gg_mtime <path> — modification time in epoch seconds (BSD then GNU stat).
gg_mtime() {
	local m
	m="$(stat -f '%m' -- "$1" 2>/dev/null || stat -c '%Y' -- "$1" 2>/dev/null)" || return 1
	case "$m" in
	'' | *[!0-9]*) return 1 ;;
	esac
	printf '%s' "$m"
}

# gg_now_epoch — seconds since the epoch, or non-zero if the clock is unusable.
gg_now_epoch() {
	local now
	now="$(date -u '+%s' 2>/dev/null)" || return 1
	case "$now" in
	'' | *[!0-9]*) return 1 ;;
	esac
	printf '%s' "$now"
}

# gg_liveness_window — the configured window, or the default for any value that
# is not a positive integer. A malformed override never disables the window.
gg_liveness_window() {
	local w="$GG_LIVENESS_WINDOW"
	case "$w" in
	'' | *[!0-9]*) w=900 ;;
	esac
	[ "$w" -gt 0 ] || w=900
	printf '%s' "$w"
}

# gg_claim_touch <lock-dir> — refresh the heartbeat that proves this owner is
# still alive. Failure is reported to the caller, never swallowed.
gg_claim_touch() {
	local now
	now="$(gg_now_epoch)" || return 1
	printf '%s\n' "$now" >"$1/heartbeat" 2>/dev/null || return 1
	return 0
}

# gg_claim_record_owner <lock-dir> <identity> — stamp a freshly created lock.
gg_claim_record_owner() {
	printf '%s\n' "$2" >"$1/owner" 2>/dev/null || return 1
	gg_claim_touch "$1" || return 1
	return 0
}

# gg_claim_release <lock-dir> — undo a claim this process could not complete.
gg_claim_release() {
	rm -f -- "$1/owner" "$1/heartbeat" 2>/dev/null
	rmdir -- "$1" 2>/dev/null
	return 0
}

# gg_claim_owner <lock-dir> — the owning identity, or non-zero if unrecorded.
#
# The value is read as inert text and validated against the same allow-list
# every other identity passes, so a hand-forged `owner` file cannot introduce a
# path component the rest of this script would then compose with.
gg_claim_owner() {
	local o
	[ -f "$1/owner" ] || return 1
	o="$(head -1 -- "$1/owner" 2>/dev/null | tr -d '\r\n')"
	gg_identity_safe "$o" || return 1
	printf '%s' "$o"
}

# gg_claim_is_stale <lock-dir> — 0 when this claim may be reclaimed.
#
# Sets GG_CLAIM_STALE_REASON to the sentence the reclamation is reported with.
gg_claim_is_stale() {
	local lock="$1" hb now age window
	GG_CLAIM_STALE_REASON=""
	window="$(gg_liveness_window)"

	# A lock with no readable heartbeat was abandoned part-built. Treating it as
	# live is exactly the permanent wedge R8 exists to prevent.
	#
	# BUT "PART-BUILT" MUST MEAN "PART-BUILT A WHILE AGO". The claim is `mkdir`
	# followed by two writes, so between those steps a perfectly healthy claim has
	# no heartbeat yet — and a competitor reading it in that instant would judge it
	# abandoned and take it. That is not hypothetical: eight racers contending for
	# one workstream reproduced it as soon as anything lengthened the read path,
	# and the result was several racers each "reclaiming" a live claim, ending with
	# the loop bound to a conversation that never won the mkdir.
	#
	# So a heartbeatless claim is judged by the age of its own DIRECTORY, and only
	# a grace period past creation. R8's intent is preserved — a genuinely
	# abandoned part-built claim is still reclaimable, seconds later rather than
	# instantly — while a claim still being written is left alone. An unreadable
	# directory age means staleness cannot be ESTABLISHED, so the claim stands.
	if [ ! -f "$lock/heartbeat" ]; then
		local born age_dir
		born="$(gg_mtime "$lock")" || return 1
		now="$(gg_now_epoch)" || return 1
		age_dir=$((now - born))
		[ "$age_dir" -lt 0 ] && age_dir=0
		if [ "$age_dir" -lt "$GG_CLAIM_GRACE" ]; then
			return 1
		fi
		GG_CLAIM_STALE_REASON="the claim carries no heartbeat at all after ${age_dir}s, so its owner never established liveness"
		return 0
	fi
	hb="$(head -1 -- "$lock/heartbeat" 2>/dev/null | tr -d ' \t\r\n')"
	case "$hb" in
	'' | *[!0-9]*)
		GG_CLAIM_STALE_REASON="the claim's heartbeat is not a readable timestamp"
		return 0
		;;
	esac

	# No clock means staleness cannot be ESTABLISHED. An unproven death is not a
	# death: the existing claim stands rather than being stolen on a guess.
	now="$(gg_now_epoch)" || return 1

	age=$((now - hb))
	[ "$age" -lt 0 ] && age=0
	if [ "$age" -ge "$window" ]; then
		GG_CLAIM_STALE_REASON="its owner has written no heartbeat for ${age}s, beyond the ${window}s liveness window"
		return 0
	fi
	return 1
}

# --- generations: how `mkdir` alone gives compare-and-swap -----------------
#
# A claim is not one directory but a GENERATION: `<base>.claim.<n>`, n counting
# up from 1. The claim in force is the highest-numbered generation that exists.
#
# WHY. Claiming and RECLAIMING have to be single-winner, and reclaiming is the
# harder half because the decision rests on an observation ("generation n looks
# dead") that another conversation may invalidate before this one acts. Moving
# the stale lock aside and re-creating it does NOT solve this, and the failure is
# not subtle: conversation A moves generation n aside and re-claims it, then B —
# still acting on its own stale reading — moves A's BRAND NEW claim aside and
# re-claims in turn, then C displaces B. Every racer "succeeds" and every claim
# is destroyed. That was measured, not imagined: six racers against one stale
# claim left zero claims standing and four displaced locks behind.
#
# Numbering the generation fixes it by making the OBSERVATION part of the write.
# A conversation that read generation n attempts `mkdir <base>.claim.<n+1>`, so
# the operating system arbitrates: of every racer that saw n, exactly one creates
# n+1, and a racer that lost simply re-reads and finds a fresh generation it must
# not touch. That is a compare-and-swap, built from the one primitive `mkdir`
# already gives — no second mutex, and so no mutex a crash can leave held.
#
# A conversation that dies mid-takeover leaves generation n+1 with no heartbeat,
# which is itself reclaimable at n+2. Nothing wedges.

# gg_claim_dir <gate-dir> <base> <gen>
gg_claim_dir() {
	printf '%s/%s.claim.%s' "$1" "$2" "$3"
}

# gg_claim_current_gen <gate-dir> <base> — the generation in force, or 0 when
# the workstream is unclaimed. Compared NUMERICALLY: generation 10 supersedes
# generation 9, which a lexicographic maximum would get backwards.
gg_claim_current_gen() {
	local d g best=0
	for d in "$1/$2.claim."*; do
		[ -d "$d" ] || continue
		g="${d##*.claim.}"
		case "$g" in
		'' | *[!0-9]*) continue ;;
		esac
		[ "$g" -gt "$best" ] && best="$g"
	done
	printf '%s' "$best"
}

# gg_claim_retire <gate-dir> <base> <through-gen> — drop superseded generations,
# so a long-lived workstream does not accumulate one directory per takeover.
# Only ever called by the conversation that already holds a LATER generation, so
# it can never remove a claim that is in force.
gg_claim_retire() {
	local d g
	for d in "$1/$2.claim."*; do
		[ -d "$d" ] || continue
		g="${d##*.claim.}"
		case "$g" in
		'' | *[!0-9]*) continue ;;
		esac
		[ "$g" -le "$3" ] && rm -rf -- "$d" 2>/dev/null
	done
	return 0
}

# gg_claim_acquire <gate-dir> <base> <gen> <identity> — THE ATOMIC CLAIM.
#
#   0  this conversation now holds generation <gen>
#   1  another conversation got there first
#   2  won, but the ownership could not be recorded (the generation is released)
#
# `mkdir` is the entire mechanism. It creates the directory or fails with
# EEXIST, indivisibly, so two conversations racing on the same generation cannot
# both succeed. A `[ -e "$lock" ] || ...` in its place would BE ancestor defect
# D10: both can pass the test before either one acts.
gg_claim_acquire() {
	local lock
	lock="$(gg_claim_dir "$1" "$2" "$3")"
	mkdir -- "$lock" 2>/dev/null || return 1
	if ! gg_claim_record_owner "$lock" "$4"; then
		gg_claim_release "$lock"
		return 2
	fi
	return 0
}

# gg_adoptable_workstreams <gate-dir> — candidate basenames, in the
# DETERMINISTIC order: ascending, `LC_ALL=C`, byte-wise. Never readdir order.
#
# BOTH LIVE PREFIXES, and the name of this function says so. It was
# `gg_anon_workstreams` while `_anon-*` was the only pool; a function that
# returns `_ws-` files too must not still be called `anon`, because the one
# thing every reader would take from that name — "these are the unclaimed ones"
# — is exactly what is no longer true. `_ws-*` is in the pool because a claim
# whose owner has died has to stay reclaimable; it is protected by its live
# claim, which passes 1 and 3 check, not by being hidden from the listing.
#
# `_ended-*` is NOT here, and that is the whole point of this change: a
# finished loop is structurally invisible to binding rather than merely filtered
# by a status read that every pass had to remember to perform.
#
# Three filters, and all three are load-bearing:
#
#   1. The basename must pass the identity allow-list. It came off the
#      filesystem and this script composes paths from it.
#   2. The basename must round-trip to a file that actually EXISTS. `find`
#      delimits with newlines, so a workstream file whose name CONTAINS one is
#      split across two lines — and the leading fragment of `_anon-<LF>evil`
#      is `_anon-`, which passes the allow-list perfectly well while naming no
#      real workstream. Claiming it would create a claim, and then a state file,
#      for a workstream that never existed. The existence check is what makes a
#      hostile filename inert rather than merely unlikely.
#
#      It is ALSO what makes a half-completed rename inert. Between creating the
#      new name's claim and moving the state file, the new base has a claim and
#      no state file; immediately after the move, the old base has a claim and
#      no state file. Neither is a candidate, so at no instant is a claimed loop
#      visible to another conversation as unclaimed. See gg_rename_workstream.
gg_adoptable_workstreams() {
	local b
	find "$1" -maxdepth 1 -type f \
		\( -name "${GG_ANON_PREFIX}*.state" -o -name "${GG_WS_PREFIX}*.state" \) 2>/dev/null |
		while IFS= read -r p; do
			b="${p##*/}"
			b="${b%.state}"
			gg_identity_safe "$b" || continue
			[ -f "$1/$b.state" ] || continue
			printf '%s\n' "$b"
		done | LC_ALL=C sort
}

# gg_claim_is_ghost <gate-dir> <base> — 0 when <base> holds at least one claim
# generation but NO state file.
#
# That is the transient a rename passes through, and it is deliberately inert:
# gg_adoptable_workstreams requires the state file, so a ghost is never a
# candidate for any pass. It is also what a rename that died half-way leaves
# behind. The predicate exists so the sweep at the end of a rename can say what
# it is actually asserting — "this base is now a ghost, so removing its claims
# destroys nothing that is in force" — rather than removing paths on trust.
gg_claim_is_ghost() {
	local gate_dir="$1" base="${2-}" d
	[ -n "$base" ] || return 1
	gg_identity_safe "$base" || return 1
	[ -e "$gate_dir/$base.state" ] && return 1
	for d in "$gate_dir/$base.claim."*; do
		[ -d "$d" ] && return 0
	done
	return 1
}

# gg_workstream_base_kind <base> — anon | ws | ended | self.
gg_workstream_base_kind() {
	case "${1-}" in
	"${GG_ANON_PREFIX}"*) printf 'anon' ;;
	"${GG_WS_PREFIX}"*) printf 'ws' ;;
	"${GG_ENDED_PREFIX}"*) printf 'ended' ;;
	*) printf 'self' ;;
	esac
}

# gg_birth_token <gate-dir> <base> — the workstream's JOIN KEY, from birth.
#
# `pursue-goal` writes `workstream_token=<token>` into the state file at the
# same moment it names the file `_anon-<token>.state`, so the key is
# authoritative from the first instant and survives every later rename
# untouched. This reads that field and nothing else where it is present.
#
# DERIVING THE TOKEN FROM THE CURRENT BASE IS WRONG, and the fallback below is
# narrow precisely because of it. Stripping the prefix off a `_ws-<identity>`
# base yields the PREVIOUS OWNER'S SESSION ID, so a reclaimed loop would retire
# as `_ended-<rescuer>-<previous-owner>`; two finished runs by one identity in
# one gate directory would then collide on the same retired name, the rename
# would be skipped, and the completed loop would be left sitting in the
# adoptable pool — precisely the state this whole change exists to make
# impossible. So the fallback applies ONLY to a birth name, `_anon-<token>`,
# where the token in the name IS the birth token by construction.
gg_birth_token() {
	local gate_dir="$1" base="${2-}" t=""
	[ -n "$base" ] || return 1
	t="$(gg_state_get "$gate_dir/$base.state" "workstream_token" 2>/dev/null)" || t=""
	if [ -n "$t" ] && gg_identity_safe "$t"; then
		printf '%s' "$t"
		return 0
	fi
	case "$base" in
	"${GG_ANON_PREFIX}"*)
		t="${base#"$GG_ANON_PREFIX"}"
		if [ -n "$t" ] && gg_identity_safe "$t"; then
			printf '%s' "$t"
			return 0
		fi
		;;
	esac
	return 1
}

# gg_rename_workstream <gate-dir> <old-base> <new-base> <identity>
#
# Move a workstream into another namespace, carrying its claim with it.
#
# THE ORDER IS THE WHOLE RISK, and it is fixed:
#
#   1. mkdir  <gate>/<new>.claim.<n>     # atomic; wins or loses
#   2. write  owner + heartbeat into it  # the claim is now recordable
#   3. mv     <gate>/<old>.state  <gate>/<new>.state
#   4. rm -rf <gate>/<old>.claim.*       # only once <old> is a proven ghost
#
# Pass 2 claims any candidate whose current generation is 0, so a state file
# that exists without its claim is a file another conversation will take. That
# is why the claim is created FIRST and the state file moved SECOND. Between 2
# and 3 the new base has a claim but no state file; after 3 the old base has no
# state file. Both are filtered by gg_adoptable_workstreams' existence check, so
# at no instant is a claimed loop visible to anyone as unclaimed.
#
# EVERY FAILURE LEAVES THE LOOP WORKING UNDER ITS OLD NAME. Naming is cosmetic;
# the loop is not. A collision, a lost mkdir, an unwritable directory — each
# warns on stderr and returns non-zero, and the caller carries on with the name
# it already had. Nothing here can refuse a turn or change a verdict.
#
# AN EXISTING `workstream_token` IS NEVER TOUCHED HERE — not rewritten, not
# recomputed from the current base, not "corrected". It was written at birth and
# it is the one field that must survive every hop unchanged; a rename that
# touched it would defeat its purpose. The single exception is a BACKFILL for a
# loop that never had one, and only from a birth name, where the token is in the
# name by construction. See the note at the write itself.
gg_rename_workstream() {
	local gate_dir="$1" old="${2-}" new="${3-}" identity="${4-}"
	local gen lock

	[ -n "$old" ] && [ -n "$new" ] && [ -n "$identity" ] || return 1
	[ "$old" != "$new" ] || return 1

	# `$old` reaches `rm -rf` at step 4, so it is allow-listed HERE, on entry,
	# before any path is composed from it — not at the point of use, where a
	# later edit could compose one path from it above the check and another
	# below.
	if ! gg_identity_safe "$old"; then
		gg_note "workstream $(gg_safe_text "$old") is not a safe name, so it was not renamed. The loop continues under it."
		return 1
	fi
	if ! gg_identity_safe "$new"; then
		gg_note "cannot rename workstream $(gg_safe_text "$old"): $(gg_safe_text "$new") is not a safe name. The loop continues under its old name."
		return 1
	fi
	[ -f "$gate_dir/$old.state" ] || return 1

	# THE COLLISION SKIP. Two workstreams in one gate directory driven by the
	# same derived identity (no session_id) target the same `_ws-` name. The
	# name was never load-bearing, so the loop is unaffected: it keeps its
	# current name, keeps its claim, and is governed exactly as before.
	if [ -e "$gate_dir/$new.state" ]; then
		gg_note "workstream $(gg_safe_text "$old") was not renamed to $(gg_safe_text "$new"): that name is already taken in this gate directory. The loop continues under its own name, which changes nothing about how it is governed."
		return 1
	fi

	gen="$(gg_claim_current_gen "$gate_dir" "$new")"
	gen=$((gen + 1))
	lock="$(gg_claim_dir "$gate_dir" "$new" "$gen")"
	if ! mkdir -- "$lock" 2>/dev/null; then
		gg_note "workstream $(gg_safe_text "$old") was not renamed: the claim generation for $(gg_safe_text "$new") could not be created. The loop continues under its old name."
		return 1
	fi
	if ! gg_claim_record_owner "$lock" "$identity"; then
		gg_claim_release "$lock"
		gg_note "workstream $(gg_safe_text "$old") was not renamed: ownership of $(gg_safe_text "$new") could not be recorded. The loop continues under its old name, still claimed."
		return 1
	fi

	# THE COLLISION TEST, AGAIN, AND THIS IS THE ONE THAT ARBITRATES. The test
	# above runs before the claim exists, so on its own it is a check-then-act:
	# two conversations can both find `<new>.state` absent and both proceed. The
	# `mkdir` does not separate them either — they compute the generation number
	# independently, so they compete for DIFFERENT directories and both win.
	#
	# What the claim does buy is an ordering: it is held now, so re-reading here
	# is a read AFTER the write, not before it. A file that has appeared in the
	# meantime is another conversation's completed move, and the rule is the same
	# as for any other collision — hand the claim back and keep the old name. The
	# loop is unaffected; the name was never load-bearing.
	if [ -e "$gate_dir/$new.state" ]; then
		gg_claim_release "$lock"
		gg_note "workstream $(gg_safe_text "$old") was not renamed to $(gg_safe_text "$new"): that name was taken by another conversation while this claim was being recorded. The loop continues under its own name, which changes nothing about how it is governed."
		return 1
	fi

	# THE ONE MOMENT A MISSING BIRTH TOKEN CAN STILL BE RECOVERED, and the only
	# moment it is ever written here. A loop started by a release that predates
	# the `workstream_token` field carries it nowhere but in its own birth NAME,
	# and this hop is the last instant that name exists: after the move the base
	# says `_ws-<owner>`, and every later reader would have nothing to recover
	# from — leaving a legacy loop unable to retire by name for the rest of its
	# life. Backfilling here is what makes "no migration step" true.
	#
	# It is strictly a BACKFILL. An existing value is never touched, never
	# recomputed, and never corrected: it is the join key, and the whole point of
	# it is that it is written once. And the value can only ever come from an
	# `_anon-` base, where the token in the name IS the birth token by
	# construction — never from a `_ws-` base, which carries a session id.
	if [ -z "$(gg_state_get "$gate_dir/$old.state" "workstream_token" 2>/dev/null)" ]; then
		case "$old" in
		"${GG_ANON_PREFIX}"*)
			gg_state_set "$gate_dir/$old.state" "workstream_token" "${old#"$GG_ANON_PREFIX"}" || true
			;;
		esac
	fi

	# The state write above goes through `mktemp` + `mv -f`, so it REPLACES the
	# inode. It is sequenced before the rename for that reason: a state write
	# racing a rename would re-create the old name from its own temporary file,
	# leaving the loop in two places at once.
	if ! mv -- "$gate_dir/$old.state" "$gate_dir/$new.state" 2>/dev/null; then
		gg_claim_release "$lock"
		gg_note "workstream $(gg_safe_text "$old") could not be moved to $(gg_safe_text "$new"). The loop continues under its old name."
		return 1
	fi

	# The keyed blocker moves with the workstream it names. Leaving it behind
	# would silently un-declare a blocker that is still in force.
	if [ -f "$gate_dir/$old.LOOP_BLOCKED" ]; then
		mv -- "$gate_dir/$old.LOOP_BLOCKED" "$gate_dir/$new.LOOP_BLOCKED" 2>/dev/null || true
	fi

	# Step 4, and it is GUARDED. The old base is swept only once it is a proven
	# ghost — no state file, some claim generations — because that is the only
	# condition under which removing its claims can destroy nothing in force. If
	# anything re-created that name between the move and here, it is a live
	# workstream belonging to somebody and its claim is left alone.
	if gg_claim_is_ghost "$gate_dir" "$old"; then
		rm -rf -- "$gate_dir/$old.claim."* 2>/dev/null
	elif [ -f "$gate_dir/$old.state" ]; then
		# THE OLD NAME CAME BACK, AND THAT IS REPORTED RATHER THAN TIDIED AWAY.
		# A `gg_state_set` racing this rename writes through `mktemp` + `mv -f`,
		# so it can re-create `<old>.state` from its own temporary file after the
		# move. The result is a SECOND claimed workstream in this directory whose
		# heartbeat nobody refreshes: it ages past the liveness window and pass 3
		# hands it to a stranger. Nothing here deletes it — this function did not
		# create that file and must not remove a claim that may be in force — so
		# the condition is made visible instead of passing silently.
		gg_note "workstream $(gg_safe_text "$old") was moved to $(gg_safe_text "$new") but $(gg_safe_text "$old").state exists again, so its claim generations were left in place. That name now holds a second claimed workstream whose heartbeat nothing refreshes; inspect the gate directory with cancel.sh status."
	fi
	return 0
}

# gg_ended_own <gate-dir> <identity> — the newest RETIRED workstream that this
# identity can PROVE it owns, or non-zero.
#
# THE NAME IS A PREFILTER. IT IS NEVER THE OWNERSHIP TEST. Identities contain
# dashes — `sess-happy`, `derived-<hex>` — so `_ended-sess-*` also matches
# `_ended-sess-happy-t1.state`. A glob cannot decide ownership; it can only
# narrow the candidate set cheaply. The `binding_identity` field inside the
# candidate's own state file decides, by exact equality.
#
# EVERY UNKNOWN FAILS CLOSED. An unreadable or absent `binding_identity` skips
# the candidate. A candidate that still carries a claim must have a READABLE
# owner naming this identity, or it is skipped. A candidate with no claim
# generation at all is still subject to the `binding_identity` test rather than
# bypassing ownership. Defaulting an unknown owner to the caller is the failure
# mode that re-opens the field defect this whole change exists to close: an
# unrelated session picking up a finished goal and being held to criteria it has
# never seen.
#
# Newest wins, by modification time, with a byte-wise tie-break so that two
# files written in the same second still resolve to one stated answer.
gg_ended_own() {
	local gate_dir="$1" identity="${2-}"
	local p b owner gen lock claim_owner m best="" best_m=""

	[ -n "$identity" ] || return 1
	gg_identity_safe "$identity" || return 1

	for p in "$gate_dir/${GG_ENDED_PREFIX}${identity}-"*.state; do
		[ -f "$p" ] || continue
		b="${p##*/}"
		b="${b%.state}"
		gg_identity_safe "$b" || continue

		owner="$(gg_state_get "$gate_dir/$b.state" "binding_identity" 2>/dev/null)" || continue
		[ -n "$owner" ] || continue
		[ "$owner" = "$identity" ] || continue

		gen="$(gg_claim_current_gen "$gate_dir" "$b")"
		if [ "$gen" -gt 0 ]; then
			lock="$(gg_claim_dir "$gate_dir" "$b" "$gen")"
			claim_owner="$(gg_claim_owner "$lock")" || continue
			[ "$claim_owner" = "$identity" ] || continue
		fi

		m="$(gg_mtime "$gate_dir/$b.state")" || continue
		if [ -z "$best" ] || [ "$m" -gt "$best_m" ] ||
			{ [ "$m" -eq "$best_m" ] && [ "$b" \> "$best" ]; }; then
			best="$b"
			best_m="$m"
		fi
	done

	[ -n "$best" ] || return 1
	printf '%s' "$best"
}

# gg_name_for_owner <gate-dir> <base> <identity> — move a just-claimed workstream
# into the `_ws-<identity>` namespace and update GG_WORKSTREAM on success.
#
# Called on the `claimed` and `reclaimed` paths ONLY, and only after the claim's
# ownership has been recorded. `existing` never renames: the file is already
# named for this owner, and re-renaming it every turn would be churn with a
# failure mode and no benefit.
GG_CLAIM_RENAMED_FROM=""   # the name a claim moved the workstream FROM, if any
gg_name_for_owner() {
	local gate_dir="$1" base="$2" identity="$3" target
	GG_CLAIM_RENAMED_FROM=""
	target="${GG_WS_PREFIX}${identity}"
	[ "$base" != "$target" ] || return 0
	if gg_rename_workstream "$gate_dir" "$base" "$target" "$identity"; then
		GG_WORKSTREAM="$target"
		GG_CLAIM_RENAMED_FROM="$base"
		return 0
	fi
	return 1
}

# --- retirement: a finished loop leaves the pool ---------------------------
#
# WHAT RETIREMENT IS FOR. A terminal status alone used to be the whole of it, so
# a finished loop kept its name, its claim and its heartbeat and sat in the
# adoptable pool looking live. Every pass had to remember to read `status` and
# skip it, and the one place that forgot — the reclaim of a claim whose owner had
# gone quiet — let an unrelated session pick up a completed goal and be held to
# criteria it had never seen. That was a field defect, not a hypothetical.
#
# Renaming the file out of the pool makes the mistake unavailable rather than
# merely unlikely: `gg_adoptable_workstreams` cannot see `_ended-*` at all. The
# per-pass status filters remain, because a loop that reached a terminal status
# and could NOT be renamed must still be skipped.
#
# The owner keeps its access, deliberately: `gg_ended_own` finds the retired file
# by identity, so adding an unmet criterion to a completed checklist still
# withdraws the permit on the next turn. Retirement is invisibility to BINDING,
# never deletion and never a one-shot permit.
GG_RETIRED_LOOP_FILE=""
# The gate directory gg_main resolved, so that a terminal helper reached through
# several frames can retire the workstream without gg_main's local in scope.
GG_GATE_DIR=""

# gg_retire_workstream <gate-dir> <identity> — rename the resolved workstream to
# `_ended-<identity>-<birth-token>`. Sets GG_RETIRED_LOOP_FILE on success and
# updates GG_WORKSTREAM. Returns non-zero and changes nothing otherwise.
#
# A FAILED RETIREMENT NEVER WITHDRAWS A GRANTED PERMIT. The completion has been
# evaluated, recorded and written by the time this runs; the name is the last
# and least of it. A loop that could not be renamed keeps its terminal status,
# and the per-pass status filters keep it out of everybody else's way.
#
# Self-bound loops (`<identity>.state`) are NOT retired, and that is deliberate:
# they are never adoptable by anyone, so there is no pool to remove them from,
# and renaming one would only break the stable name its own owner re-binds by.
gg_retire_workstream() {
	local gate_dir="${1-}" identity="${2-}" base="$GG_WORKSTREAM" token target
	GG_RETIRED_LOOP_FILE=""

	# AN EMPTY GATE DIRECTORY IS REFUSED HERE, not composed into a path. Five of
	# the six retirement sites hand in gg_main's local; gg_stall_terminal is
	# reached through several frames and reads the GG_GATE_DIR global instead,
	# which is the empty string until gg_main sets it — so a caller reaching this
	# function outside a live gate run would compose `/<base>.state` and probe the
	# filesystem ROOT. Refusing costs a retirement that could not have worked;
	# proceeding reads and writes paths nobody named.
	[ -n "$gate_dir" ] || return 1
	[ -n "$base" ] && [ -n "$identity" ] || return 1
	case "$(gg_workstream_base_kind "$base")" in
	anon | ws) : ;;
	*) return 1 ;;
	esac

	if ! token="$(gg_birth_token "$gate_dir" "$base")"; then
		gg_note "workstream $(gg_safe_text "$base") has ended but carries no birth token, so it was not renamed out of the adoptable pool. Its terminal status still keeps it out of every resolution pass."
		return 1
	fi

	target="${GG_ENDED_PREFIX}${identity}-${token}"
	gg_rename_workstream "$gate_dir" "$base" "$target" "$identity" || return 1

	GG_WORKSTREAM="$target"
	GG_RETIRED_LOOP_FILE="$gate_dir/$target.state"
	gg_note "workstream $(gg_safe_text "$base") has ended and is retired as $(gg_safe_text "$target"). It stays on disk for cancel.sh status and for audit; no other conversation can bind it."
	return 0
}

# gg_workstream_ended <gate-dir> <base> — 0 when that workstream has reached an
# end (complete, cancelled, stalled, bound-exceeded, blocked).
#
# Read with bash builtins rather than through loop-state.sh, deliberately. This
# runs for every candidate in up to three resolution passes, on every turn end in
# every repository — the one place in this script where a subprocess per call is
# worth avoiding, and it is called precisely where the answer is usually "no".
#
# Reading one field directly is safe HERE and would not be in general:
# loop-state.sh escapes `\`, LF and CR on write, and `status` is written only by
# this gate and by cancel.sh, only ever as a single bare word from
# GG_TERMINAL_STATUSES. No escape sequence can appear in it, so there is nothing
# to decode. Any other field must go through loop-state.sh.
gg_workstream_ended() {
	local f="$1/$2.state" line s=""
	[ -f "$f" ] || return 1
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
		status=*)
			s="${line#status=}"
			break
			;;
		esac
	done <"$f"
	case " $GG_TERMINAL_STATUSES " in
	*" $s "*) return 0 ;;
	esac
	return 1
}

# gg_resolve_workstream <gate-dir> <identity>
#
#   0  resolved; GG_WORKSTREAM and GG_CLAIM_EVENT are set
#   2  resolution failed and must be reported; GG_CLAIM_ERROR is set
gg_resolve_workstream() {
	local gate_dir="$1" identity="$2"
	local list base gen lock owner rc

	GG_WORKSTREAM=""
	GG_CLAIM_EVENT=""
	GG_CLAIM_RENAMED_FROM=""
	GG_CLAIM_PREV_OWNER=""
	GG_CLAIM_REASON=""
	GG_CLAIM_ERROR=""
	GG_FOREIGN_OWNER=""
	GG_FOREIGN_OWNER_CANDIDATE=""

	list="$(gg_adoptable_workstreams "$gate_dir")"

	# --- WHERE A WORKSTREAM THAT HAS ENDED FITS ----------------------------
	#
	# THE RULE: a terminal workstream is a LAST-RESORT candidate for the
	# conversation that owns it, and NEVER a candidate for anybody else.
	#
	# Both halves are load-bearing, and each fixes a defect the other does not.
	#
	# Never for anybody else. A finished goal used to keep its name, its claim and
	# its heartbeat (cancel.sh and the permit path recorded a terminal status
	# without retiring anything), so once that heartbeat aged past the liveness
	# window the next unrelated session in the repository RECLAIMED the dead
	# workstream and was then held to acceptance criteria it had never heard of,
	# for a goal that was already complete. Reproduced, and now closed twice over:
	# a terminal workstream is renamed out of the pool entirely, and the per-pass
	# status filters below still skip any that could not be renamed.
	#
	# Last resort for its owner, rather than skipped outright. Two reasons.
	# `pursue-goal` restarting in the same session writes a FRESH `_anon-*`, and
	# the old terminal one — still claimed by this conversation — used to win pass
	# 1 and re-terminate immediately, so a restarted loop died on its first turn
	# while appearing to have started. Deferring it lets the new workstream win.
	# But the owner must still get it back when there IS no newer workstream,
	# because re-evaluating a finished loop is what makes a REGRESSION visible: add
	# an unmet criterion to a completed checklist and the next turn withdraws the
	# permit. Skipping it would silently convert a permit into a one-shot and let a
	# goal recorded as done drift arbitrarily far from its own criteria.
	#
	# Two shapes reach that last resort, and they are looked for in this order:
	# an ended workstream still in the pool under a live prefix (a retirement that
	# could not rename), then a properly retired `_ended-<identity>-*` found by
	# gg_ended_own — by identity, never by scanning the pool, which is exactly
	# what makes retirement structural rather than a filter somebody can forget.
	local ended_own=""

	# --- pass 1: a workstream this conversation already owns --------------
	while IFS= read -r base; do
		[ -n "$base" ] || continue
		gen="$(gg_claim_current_gen "$gate_dir" "$base")"
		[ "$gen" -gt 0 ] || continue
		lock="$(gg_claim_dir "$gate_dir" "$base" "$gen")"
		owner="$(gg_claim_owner "$lock")" || continue
		if [ "$owner" = "$identity" ]; then
			# Ours, but already ended: remembered, and only used if nothing live
			# turns up below.
			if gg_workstream_ended "$gate_dir" "$base"; then
				[ -n "$ended_own" ] || ended_own="$base"
				continue
			fi
			# Still here, still working: prove liveness for the next turn.
			gg_claim_touch "$lock" || true
			GG_WORKSTREAM="$base"
			GG_CLAIM_EVENT="existing"
			return 0
		fi
	done <<<"$list"

	# --- pass 2: the first UNCLAIMED workstream ---------------------------
	while IFS= read -r base; do
		[ -n "$base" ] || continue
		gg_workstream_ended "$gate_dir" "$base" && continue
		gen="$(gg_claim_current_gen "$gate_dir" "$base")"
		[ "$gen" -eq 0 ] || continue
		rc=0
		gg_claim_acquire "$gate_dir" "$base" 1 "$identity" || rc=$?
		case "$rc" in
		0)
			# THE CANDIDATE MUST STILL EXIST NOW THAT WE HOLD THE CLAIM.
			#
			# The list was enumerated at the top of this function, and a candidate
			# can vanish between then and here: another conversation reclaimed it
			# and renamed it away, moving the state file (step 3) and then
			# sweeping the old base's claims (step 4). A racer holding the stale
			# list arrives after that sweep, finds generation 0, and wins a claim
			# on a name with no file behind it — and would then have Stage 5c
			# CREATE that file, conjuring a second workstream out of a name.
			#
			# Re-testing after the acquire is not a check-then-act: the claim is
			# already held, and the rename's own order guarantees the state file
			# moves BEFORE the claims that could let anyone in are removed. So an
			# absent file here means the loop has genuinely gone elsewhere. Hand
			# the claim back and keep scanning.
			if [ ! -f "$gate_dir/$base.state" ]; then
				gg_claim_release "$(gg_claim_dir "$gate_dir" "$base" 1)"
				continue
			fi
			GG_WORKSTREAM="$base"
			GG_CLAIM_EVENT="claimed"
			# The claim is recorded, so the owner is known — rename the file to
			# say so. Only ever AFTER gg_claim_record_owner has succeeded, never
			# before: a rename that ran first would move a file this conversation
			# might not turn out to own.
			gg_name_for_owner "$gate_dir" "$base" "$identity"
			return 0
			;;
		2)
			GG_CLAIM_ERROR="the claim on workstream $(gg_safe_text "$base") was won but could not be recorded, so ownership cannot be established"
			return 2
			;;
		esac
		# rc 1 — another conversation won this one. Keep scanning; losing a
		# race is not an error, it is the mechanism working.
	done <<<"$list"

	# --- pass 3: a claim whose owner has gone silent (R8 / S58) -----------
	#
	# The takeover is `mkdir` of the generation AFTER the one judged dead, so
	# the observation this decision rests on is exactly what the write competes
	# on: of every conversation that saw generation <gen>, one creates <gen+1>.
	local foreign_live=0
	while IFS= read -r base; do
		[ -n "$base" ] || continue
		# A workstream that has ENDED is never taken over. Its owner may still
		# re-read it (see the rule above); nobody else has any business in it, and
		# a bystander that adopted one was the field defect.
		gg_workstream_ended "$gate_dir" "$base" && continue
		gen="$(gg_claim_current_gen "$gate_dir" "$base")"
		[ "$gen" -gt 0 ] || continue
		lock="$(gg_claim_dir "$gate_dir" "$base" "$gen")"
		owner="$(gg_claim_owner "$lock")" || owner=""
		[ "$owner" = "$identity" ] && continue
		if ! gg_claim_is_stale "$lock"; then
			# Owned by someone else, and that someone is still alive. A workstream
			# that has ENDED cannot reach here: this pass tests the status itself,
			# at the top of the loop — gg_adoptable_workstreams does NOT filter
			# terminal statuses, and an earlier version of this comment claiming it
			# did was simply wrong. What the listing does do is exclude `_ended-*`
			# names outright, so a properly retired loop never even reaches the
			# status test. A cancelled or completed loop under a live prefix —
			# cancel.sh records a terminal status without renaming anything — is
			# caught by the `gg_workstream_ended` guard above.
			foreign_live=1
			GG_FOREIGN_OWNER_CANDIDATE="${owner:-<unrecorded>}"
			continue
		fi
		if gg_claim_acquire "$gate_dir" "$base" "$((gen + 1))" "$identity"; then
			# As in pass 2: the candidate must still be here now that the claim
			# is held, or another conversation renamed it away between the
			# enumeration and this instant.
			if [ ! -f "$gate_dir/$base.state" ]; then
				gg_claim_release "$(gg_claim_dir "$gate_dir" "$base" "$((gen + 1))")"
				continue
			fi
			gg_claim_retire "$gate_dir" "$base" "$gen"
			GG_WORKSTREAM="$base"
			GG_CLAIM_EVENT="reclaimed"
			GG_CLAIM_PREV_OWNER="${owner:-<unrecorded>}"
			GG_CLAIM_REASON="$GG_CLAIM_STALE_REASON"
			# The loop has changed hands, so its name must change with it. This
			# is the `_ws-` to `_ws-` hop — the one the birth token exists for.
			gg_name_for_owner "$gate_dir" "$base" "$identity"
			return 0
		fi
	done <<<"$list"

	# --- pass 4: a bystander in someone else's tree -----------------------
	#
	# Every workstream here is claimed, live, and none of them is ours. This
	# conversation is not driving the loop and never was: a SECOND session
	# working in a repository where a first session is running a goal.
	#
	# Before this branch existed, such a session fell through to the self-bind
	# below, bound `<identity>.state` with no goal folder, derived an ACs path
	# from the gate directory's PARENT, found no file there, and refused with
	# "no acceptance criteria file at <repo>/ACs.md" — blocking a session that
	# had nothing to do with the goal, citing a file that was never meant to
	# exist. the predecessor, which this supersedes, handled concurrent sessions
	# correctly; that was a regression, not a design decision.
	#
	# WHY STANDING DOWN IS SAFE. The gate's guarantee is that no completion is
	# recorded which is not met AND evidenced. That guarantee lives entirely
	# with the OWNER: only the owning conversation can write a completion
	# record, and it stays blocked until its criteria are met and evidenced.
	# A bystander ending its turn establishes nothing about the owner's goal,
	# so it cannot manufacture a completion.
	#
	# WHY ABANDONMENT IS STILL COVERED. If the owner dies, its claim goes stale
	# after GOAL_GATE_LIVENESS_WINDOW and pass 3 above reclaims it — which runs
	# BEFORE this branch, so a stale owner is taken over rather than tiptoed
	# around. Abandonment is handled by reclaim, never by blocking bystanders.
	#
	# THIS DOES NOT CHANGE THE OUTCOME, ONLY THE EXPLANATION. An arriving
	# conversation still self-binds and still REFUSES, because a second session
	# is exactly how the gate would otherwise be bypassed: session identity is
	# trivially resettable, so a conversation that hit the gate could open a new
	# one and walk away with the goal unmet. The gate governs the TREE, not the
	# session, and test-binding.sh §9 pins that ("binding never becomes a
	# verdict" — no binding outcome may end a turn as a completion).
	#
	# What WAS wrong is what the refusal said. The self-bound bystander derived
	# an ACs path from the gate directory's PARENT and reported "no acceptance
	# criteria file at <repo>/ACs.md" — a file that was never meant to exist,
	# naming nothing the operator could act on. Recording the live owner here
	# lets the refusal say what is actually true.
	if [ "$foreign_live" -eq 1 ]; then
		GG_FOREIGN_OWNER="${GG_FOREIGN_OWNER_CANDIDATE:-<unrecorded>}"
	fi

	# --- last resort: our own workstream, already ended --------------------
	#
	# Nothing live was found. If this conversation owns a workstream that has
	# ended, it gets it back — so a regression against a completed checklist is
	# still seen, and a blocked loop is still re-reported. Deferred to here, and
	# no further, so a freshly started workstream always wins.
	#
	# A RETIRED loop is looked up by identity rather than found by scanning,
	# because it is not in the pool to be scanned. The glob narrows; gg_ended_own
	# proves ownership from the candidate's own `binding_identity`, and fails
	# closed on every unknown.
	if [ -z "$ended_own" ]; then
		ended_own="$(gg_ended_own "$gate_dir" "$identity")" || ended_own=""
	fi
	if [ -n "$ended_own" ]; then
		gen="$(gg_claim_current_gen "$gate_dir" "$ended_own")"
		if [ "$gen" -gt 0 ]; then
			gg_claim_touch "$(gg_claim_dir "$gate_dir" "$ended_own" "$gen")" || true
		fi
		GG_WORKSTREAM="$ended_own"
		GG_CLAIM_EVENT="existing"
		return 0
	fi

	# --- no claimable workstream: self-bind, exactly as before T2.3 -------
	#
	# `<identity>.state` is named for its owner, carries no lock, and is never a
	# candidate above. That is what stops two sessions in different repositories
	# sharing one user-global state directory from ever taking each other's.
	#
	# It is also NEVER RENAMED — not on binding, and not when it ends. Both
	# renames exist to move a file between adoption POOLS, and this file is in
	# none of them: no pass can ever see it, so there is nothing to hide it from.
	# Renaming it would only break the one property it has, which is that its own
	# owner finds it again next turn under a name derived from its own identity.
	GG_WORKSTREAM="$identity"
	GG_CLAIM_EVENT="self"
	return 0
}

# ===========================================================================
# STAGE 6 — record, bound, decide
# ===========================================================================

# The loop file is written a dozen or more times per decision once the decision
# trail (below) is included, so the cost of a write is worth stating.
#
# MEASURED, NOT ASSUMED. loop-state.sh documents sourcing as a supported entry
# point, and the obvious optimisation is to source it once and call
# loop_state_set in-process rather than spawning `bash loop-state.sh` per field.
# That was built and measured against this same file: it made NO DIFFERENCE
# (4-6 s either way for a full decision on the development machine). The cost is
# not process startup — `bash -c true` is ~20 ms here — it is the `mktemp` inside
# loop-state.sh's atomic-write path, at ~90 ms a call, which the in-process form
# pays identically.
#
# It was reverted, because sourcing is EXECUTION and this is the decision path.
# A loop-state module that calls `exit` at load — a truncated copy, a stub, a
# wrong GOAL_GATE_LOOP_STATE — terminates THIS shell from inside the `.`, and
# the gate dies with an empty stdout, which is the one shape a host reads as
# consent. That is a fail-open, and it was not hypothetical: the T2.1 suite's
# broken-module fixture (`exit 9`) reproduced it immediately. A subshell probe
# can make sourcing safe, but paying an extra process to guard an optimisation
# that saves nothing is a worse trade than not optimising.
#
# The subprocess form below is isolated by construction: a broken module's exit
# status comes back as a failed write, and the write checks refuse on it.

# gg_state_set <file> <field> <value>
gg_state_set() {
	bash "$GG_LOOP_STATE" set "$1" "$2" "$3" 2>/dev/null
}

# gg_state_get <file> <field> — prints the value, or nothing when absent.
gg_state_get() {
	bash "$GG_LOOP_STATE" get "$1" "$2" 2>/dev/null
}

# ===========================================================================
# STAGE 6 — the completion decision (T2.2)
# ===========================================================================

# --- the timing budget (review finding R3) ---------------------------------

GG_BUDGET=120
GG_BUDGET_START=0

gg_budget_init() {
	GG_BUDGET="${GOAL_GATE_DECISION_BUDGET:-120}"
	case "$GG_BUDGET" in
	'' | *[!0-9]*) GG_BUDGET=120 ;;
	esac
	[ "$GG_BUDGET" -gt 0 ] || GG_BUDGET=120
	GG_BUDGET_START="$SECONDS"
}

# gg_budget_left — whole seconds still available to the decision.
gg_budget_left() {
	local left=$((GG_BUDGET - (SECONDS - GG_BUDGET_START)))
	[ "$left" -lt 0 ] && left=0
	printf '%s' "$left"
}

# gg_run_bounded <outfile> <errfile> <cmd...> — run a delegate under whatever
# is left of the budget.
#
# Returns the command's own exit status, or 124 when the budget ran out. 124 is
# NEVER confused with a delegate exit code: neither parse-acs.sh nor
# validate-acs.sh documents 124, so a timeout cannot be misread as a verdict.
#
# `timeout(1)` is deliberately not used — it is GNU coreutils and absent from a
# stock macOS, and a missing timeout binary would leave the budget unenforced,
# which is exactly the silent fail-open this guards against.
gg_run_bounded() {
	local outf="$1" errf="$2"
	shift 2
	local budget deadline pid rc

	budget="$(gg_budget_left)"
	[ "$budget" -gt 0 ] || return 124
	deadline=$((SECONDS + budget))

	"$@" >"$outf" 2>"$errf" &
	pid=$!

	# Waiting is measured against a WALL-CLOCK deadline, never by counting
	# `sleep 0.1` ticks. A tick count assumes each tick costs 0.1s; under load
	# it costs more, so `budget * 10` ticks silently overran the budget — with
	# a 1 s budget and an 8 s delegate the observed elapsed time was 9 s.
	# That matters because the budget is the TIGHTEST HOST timeout (Claude's
	# registration uses `timeout: 120`): a hook that overruns is killed by the
	# host instead of refusing, and a host that kills a hook may treat the dead
	# hook as consent. The gate must reach its own refusal FIRST, so the clock
	# it enforces has to be the same one the host is using.
	while [ "$SECONDS" -lt "$deadline" ]; do
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.1
	done

	if kill -0 "$pid" 2>/dev/null; then
		kill -9 "$pid" 2>/dev/null
		wait "$pid" 2>/dev/null
		return 124
	fi

	wait "$pid"
	rc=$?
	return "$rc"
}

# --- reading a delegate's key=value output ---------------------------------

# gg_kv <text> <key> — the value of `<key>=...`, or empty. The key is one of
# this file's own literals, never anything read from the payload or the file
# under evaluation, so no pattern can be injected here.
gg_kv() {
	printf '%s\n' "${1-}" | grep -E "^${2}=" | head -1 | cut -d'=' -f2-
}

# gg_is_count <value> — a delegate count must be a plain non-negative integer.
# Anything else means the output was not the shape this gate understands, which
# is a could-not-run, not a zero.
gg_is_count() {
	case "${1-}" in
	'' | *[!0-9]*) return 1 ;;
	esac
	return 0
}

# --- the evaluation --------------------------------------------------------
#
# Sets, for the caller:
#   GG_EVAL_STATE   met | partial | unmet | error   (error is fail-closed)
#
#                   `partial` means: nothing outstanding, something BLOCKED.
#                   The loop may end, as a REPORTED NON-COMPLETION. It is not a
#                   pass and must never be treated as one — only `met` permits.
#   GG_EVAL_REASON  the sentence to refuse with, when the state is not `met`
#   GG_EVAL_*       counts and trail, recorded whether or not the run concluded
#
# GG_EVAL_STATE starts at `error` and only ever moves to `met` at the very end,
# once every check has been passed. There is no path on which an unhandled case
# leaves it at `met`.

GG_EVAL_STATE="error"
GG_EVAL_REASON=""
GG_EVAL_TOTAL=""
GG_EVAL_CHECKED=""
GG_EVAL_UNCHECKED=""
GG_EVAL_UNKNOWN=""
GG_EVAL_BLOCKED=""
GG_EVAL_TWE=""
# The outstanding criteria split by whether anyone has explained them (R12
# rule 3). Reported separately because they are different problems: one has a
# stated reason, the other has been left silently unaddressed.
GG_EVAL_UWE=""
GG_EVAL_UWOE=""
GG_EVAL_TRAIL=""
GG_EVAL_VERDICT=""
GG_EVAL_PARSE_RC=""
GG_EVAL_VALIDATE_RC=""

# gg_delegate_note <rc> — how a delegate exit is described in a refusal.
# Anything outside the documented set is `not-run`, never a verdict.
gg_delegate_note() {
	case "${1-}" in
	2) printf 'the checklist contains zero criteria, so completion is vacuous and is refused' ;;
	3) printf 'the acceptance criteria file could not be read reliably (missing, a directory, a symlink, or it changed mid-read)' ;;
	4) printf 'the acceptance criteria file does not conform to the required format' ;;
	5) printf 'ticked-without-evidence: a criterion is ticked but carries no evidence block, so it is not accepted as met' ;;
	6) printf 'a criterion is unticked and carries no explanation' ;;
	7) printf 'evidence is not substantive, or names a surrogate (a mock, stub or fake)' ;;
	8) printf 'blocked-without-reason: a criterion is marked blocked but states no reason, so the blocker is refused rather than honoured' ;;
	124) printf 'the evaluation exceeded the decision budget and was stopped; the check is reported as not-run' ;;
	*) printf 'the evaluation could not run and is reported as not-run' ;;
	esac
}

# gg_evaluate <acs-file>
gg_evaluate() {
	local acs="$1"
	local outp errp outv errv
	local ptext vtext prc vrc
	local vtotal vchecked vunchecked vblocked

	GG_EVAL_STATE="error"

	outp="$(mktemp "${TMPDIR:-/tmp}/gg-parse.XXXXXX")" || {
		GG_EVAL_REASON="cannot verify completion: no temporary file could be created, so the acceptance evaluation could not run and is reported as not-run."
		return 0
	}
	errp="${outp}.err"
	outv="${outp}.v"
	errv="${outp}.verr"
	: >"$errp"
	: >"$outv"
	: >"$errv"

	# --- delegate 1: parse-acs.sh (T1.3) — counting and the verdict -----
	if [ ! -f "$GG_PARSE_ACS" ] || [ ! -r "$GG_PARSE_ACS" ]; then
		GG_EVAL_REASON="cannot verify completion: the acceptance criteria parser is missing or unreadable at $(gg_safe_text "$GG_PARSE_ACS"), so the check is reported as not-run. A check that could not run is NOT a pass."
		rm -f -- "$outp" "$errp" "$outv" "$errv"
		return 0
	fi

	prc=0
	gg_run_bounded "$outp" "$errp" bash "$GG_PARSE_ACS" "$acs" || prc=$?
	ptext="$(cat -- "$outp" 2>/dev/null)"
	GG_EVAL_PARSE_RC="$prc"

	if [ "$prc" -ne 0 ] && [ "$prc" -ne 1 ]; then
		GG_EVAL_REASON="cannot verify completion: the acceptance criteria parser exited $prc: $(gg_delegate_note "$prc"). A check that could not run is NOT a pass."
		rm -f -- "$outp" "$errp" "$outv" "$errv"
		return 0
	fi

	GG_EVAL_VERDICT="$(gg_kv "$ptext" verdict)"
	GG_EVAL_TOTAL="$(gg_kv "$ptext" total)"
	GG_EVAL_CHECKED="$(gg_kv "$ptext" checked)"
	GG_EVAL_UNCHECKED="$(gg_kv "$ptext" unchecked)"
	GG_EVAL_UNKNOWN="$(gg_kv "$ptext" unknown)"
	# A parser that predates the third state emits no `blocked=`. That reads as
	# zero, which is the honest answer: nothing it saw was blocked.
	GG_EVAL_BLOCKED="$(gg_kv "$ptext" blocked)"
	gg_is_count "$GG_EVAL_BLOCKED" || GG_EVAL_BLOCKED=0

	# The D1 guard, stated positively: an exit the gate would otherwise read
	# as a verdict must actually CARRY one. An empty stdout on exit 0 is what
	# the ancestor consumed as "nothing outstanding"; here it is a not-run.
	if [ -z "$GG_EVAL_VERDICT" ] ||
		! gg_is_count "$GG_EVAL_TOTAL" ||
		! gg_is_count "$GG_EVAL_CHECKED" ||
		! gg_is_count "$GG_EVAL_UNCHECKED"; then
		GG_EVAL_REASON="cannot verify completion: the acceptance criteria parser exited $prc but produced no usable verdict or counts, so the check is reported as not-run. An empty result is NOT a pass."
		rm -f -- "$outp" "$errp" "$outv" "$errv"
		return 0
	fi

	# --- delegate 2: validate-acs.sh (T1.6) — the evidence enforcement ---
	if [ ! -f "$GG_VALIDATE_ACS" ] || [ ! -r "$GG_VALIDATE_ACS" ]; then
		GG_EVAL_REASON="cannot verify completion: the evidence validator is missing or unreadable at $(gg_safe_text "$GG_VALIDATE_ACS"), so the evidence check is reported as not-run. A check that could not run is NOT a pass."
		rm -f -- "$outp" "$errp" "$outv" "$errv"
		return 0
	fi

	vrc=0
	gg_run_bounded "$outv" "$errv" bash "$GG_VALIDATE_ACS" "$acs" || vrc=$?
	vtext="$(cat -- "$outv" 2>/dev/null)"
	GG_EVAL_VALIDATE_RC="$vrc"

	if [ "$vrc" -eq 0 ] || [ "$vrc" -eq 1 ]; then
		GG_EVAL_TWE="$(gg_kv "$vtext" ticked_without_evidence)"
		GG_EVAL_UWE="$(gg_kv "$vtext" unticked_with_explanation)"
		GG_EVAL_UWOE="$(gg_kv "$vtext" unticked_without_explanation)"
		GG_EVAL_TRAIL="$(printf '%s\n' "$vtext" | grep '^criterion ' || true)"
		vtotal="$(gg_kv "$vtext" total)"
		vchecked="$(gg_kv "$vtext" checked)"
		vunchecked="$(gg_kv "$vtext" unchecked)"
		vblocked="$(gg_kv "$vtext" blocked)"
		gg_is_count "$vblocked" || vblocked=0
	fi

	if [ "$vrc" -ne 0 ] && [ "$vrc" -ne 1 ]; then
		GG_EVAL_REASON="cannot verify completion: the evidence validator exited $vrc: $(gg_delegate_note "$vrc") ($GG_EVAL_CHECKED of $GG_EVAL_TOTAL criteria are ticked). A check that could not run is NOT a pass."
		rm -f -- "$outp" "$errp" "$outv" "$errv"
		return 0
	fi

	if [ -z "$(gg_kv "$vtext" verdict)" ] || ! gg_is_count "$vtotal"; then
		GG_EVAL_REASON="cannot verify completion: the evidence validator exited $vrc but produced no usable verdict or counts, so the evidence check is reported as not-run. An empty result is NOT a pass."
		rm -f -- "$outp" "$errp" "$outv" "$errv"
		return 0
	fi

	# Two independent evaluations of the same file. If they do not agree on
	# what they read, neither is trustworthy — refuse rather than pick one.
	if [ "$vtotal" != "$GG_EVAL_TOTAL" ] ||
		[ "$vchecked" != "$GG_EVAL_CHECKED" ] ||
		[ "$vunchecked" != "$GG_EVAL_UNCHECKED" ] ||
		[ "$vblocked" != "$GG_EVAL_BLOCKED" ]; then
		GG_EVAL_REASON="cannot verify completion: the parser and the evidence validator disagree about the acceptance criteria file (parser saw ${GG_EVAL_TOTAL}/${GG_EVAL_CHECKED}/${GG_EVAL_UNCHECKED}/${GG_EVAL_BLOCKED} total/checked/unchecked/blocked, validator saw ${vtotal}/${vchecked}/${vunchecked}/${vblocked}). The evaluation is reported as not-run."
		rm -f -- "$outp" "$errp" "$outv" "$errv"
		return 0
	fi

	rm -f -- "$outp" "$errp" "$outv" "$errv"

	# --- the verdict -----------------------------------------------------
	#
	# Every one of these must hold before `met` is reachable. Zero criteria
	# never gets here (both delegates exit 2 on it, handled above), but the
	# total>0 test is kept anyway: the vacuous-truth trap is the single most
	# expensive thing to get wrong, and it should not depend on a delegate.
	if [ "$GG_EVAL_TOTAL" -eq 0 ]; then
		GG_EVAL_REASON="cannot verify completion: the acceptance criteria file lists zero criteria. Zero criteria is NOT 'all complete' - there is nothing to have completed."
		return 0
	fi

	# --- the PARTIAL ending (T3.1) ---------------------------------------
	#
	# THE DEFECT THIS CLOSES: a criterion that can never be met used to hold the
	# loop open forever, and the only way out was for a human to notice. With
	# nothing outstanding and something blocked, the loop ENDS — but as a
	# REPORTED NON-COMPLETION, never as a pass. Nothing is marked met and no
	# completion record is written.
	#
	# It is evaluated BEFORE `unmet` because both delegates return exit 1 for
	# `partial` and `not_done` alike (deliberately — see parse-acs.sh), so the
	# state is told apart by the VERDICT, not by the exit code. Every other
	# not-run guard above has already run, so reaching here means the evaluation
	# itself was trustworthy.
	#
	# `unchecked=0` is re-tested rather than trusted from the verdict: `partial`
	# releasing a turn that still had real work in it would be the worst
	# possible bug in this feature, and it must not depend on one delegate.
	if [ "$prc" -eq 1 ] && [ "$vrc" -eq 1 ] &&
		[ "$GG_EVAL_VERDICT" = "partial" ] &&
		[ "$GG_EVAL_UNCHECKED" = "0" ] &&
		[ "$GG_EVAL_BLOCKED" -gt 0 ] &&
		{ ! gg_is_count "$GG_EVAL_UNKNOWN" || [ "$GG_EVAL_UNKNOWN" = "0" ]; }; then
		GG_EVAL_STATE="partial"
		GG_EVAL_REASON="the remaining work is BLOCKED and cannot be completed: ${GG_EVAL_BLOCKED} of ${GG_EVAL_TOTAL} acceptance criteria are marked blocked, ${GG_EVAL_CHECKED} are met and evidenced, and none are outstanding. This is a reported NON-COMPLETION, not a pass."
		return 0
	fi

	if [ "$prc" -ne 0 ] || [ "$vrc" -ne 0 ] ||
		[ "$GG_EVAL_VERDICT" != "done" ] ||
		[ "$GG_EVAL_UNCHECKED" != "0" ] ||
		{ gg_is_count "$GG_EVAL_UNKNOWN" && [ "$GG_EVAL_UNKNOWN" != "0" ]; }; then
		GG_EVAL_STATE="unmet"
		# Mentioned only when there IS one: ", 0 blocked" on every ordinary
		# refusal is noise, and it invites the reading that zero is a shortfall.
		local blocked_note=""
		if gg_is_count "$GG_EVAL_BLOCKED" && [ "$GG_EVAL_BLOCKED" -gt 0 ]; then
			blocked_note=", ${GG_EVAL_BLOCKED} blocked"
		fi
		# T3.2 — the escape is named HERE, on the ordinary refusal, not only in
		# the stall message eight idle turns later. Not knowing that a criterion
		# CAN be declared blocked is the direct cause of the reported indefinite
		# looping: an agent that cannot see an honest exit keeps retrying one it
		# will never reach. The cost is stated in the same breath so this reads
		# as an accounting rule and not as an invitation.
		GG_EVAL_REASON="completion is not established: ${GG_EVAL_UNCHECKED} of ${GG_EVAL_TOTAL} acceptance criteria are not yet met and evidenced (${GG_EVAL_CHECKED} met${blocked_note}). Keep working against the acceptance criteria in $(gg_safe_text "$acs"). If a criterion GENUINELY cannot be met - not merely hard, not merely slow - mark it blocked: change its box to [!] and give it an indented '- blocked: <reason>' line saying what is stopping it. A blocked criterion stops driving this message. It does NOT pass: the run then ends as a reported non-completion with that criterion unmet, so blocking one you could still finish only records that you did not."
		return 0
	fi

	GG_EVAL_STATE="met"
	return 0
}

# --- the structured run log (T2.6) -----------------------------------------
#
# Requirement E, and the fix for ancestor defect D7: `last_result`,
# `last_output` and `history` were DOCUMENTED as hook-managed and never
# written. A log that is described but absent is worse than no log — a reader
# trusts it, finds it empty, and concludes the loop never ran.
#
# THE SURFACE CONTRACT. A reader answers "is this loop healthy, and if not what
# is it stuck on?" from the log alone, in under a minute. Every field exists to
# serve that question: iteration (how far), met/unmet (how much is left),
# decision (what happened), agent (which host), elapsed (how long).
#
# LOGGING NEVER CHANGES THE DECISION. A log that cannot be written degrades and
# says so. Observability that can alter the verdict is a second decision path,
# and one nobody tests — so every write here is best-effort and every failure
# is reported rather than propagated.
#
# S31 — the log lives OUTSIDE the guarded state directory (beside it, in the
# goal folder), because writing into the guarded area would trip the very
# protection the gate exists to respect. It stays INSIDE the goal folder, so
# containment is not traded away to satisfy S31.
#
# ATOMICITY. One record is a single `printf` of one line to a file opened in
# append mode. POSIX guarantees an O_APPEND write below PIPE_BUF (4096) is
# atomic, so concurrent conversations cannot splice a record through the middle
# of another. Records are therefore CAPPED at 3072 bytes — the cap is what makes
# the guarantee apply, not a tidiness rule.
GG_DECISION_LABEL=""
GG_LOG_ITERATION=""
GG_LOG_WORKSTREAM=""
GG_LOG_AGENT=""
GG_LOG_SHAPE=""
GG_LOG_STALL_COUNT=""
# The blocked criteria, named with their reasons, for the run log. Set only on
# the turn a blocked ending is decided — every other turn logs the count alone.
GG_LOG_BLOCKED_NAMED=""
GG_RUNLOG=""
GG_RUNLOG_MAX_BYTES="${GOAL_GATE_MAX_LOG_BYTES:-1048576}"
GG_RUNLOG_RECORD_CAP=3072

# gg_runlog_init <goal-folder> — decide where the log lives. Never inside the
# guarded gate directory.
gg_runlog_init() {
	GG_RUNLOG="${1%/}/run-log.jsonl"
}

# gg_runlog_bound — keep the log from growing without limit.
#
# Policy, stated so it is not mistaken for a leak: when the log exceeds
# GOAL_GATE_MAX_LOG_BYTES (1 MiB by default) the OLDEST half is dropped and the
# newest half is kept, in one atomic replace. Recent history is what answers the
# health question; ancient history is what fills a disk on a loop left running
# for days.
gg_runlog_bound() {
	local size keep tmp
	[ -f "$GG_RUNLOG" ] || return 0

	size="$(wc -c <"$GG_RUNLOG" 2>/dev/null | tr -d ' ')"
	case "$size" in
	'' | *[!0-9]*) return 0 ;;
	esac
	[ "$size" -gt "$GG_RUNLOG_MAX_BYTES" ] || return 0

	keep="$(wc -l <"$GG_RUNLOG" 2>/dev/null | tr -d ' ')"
	case "$keep" in
	'' | *[!0-9]*) return 0 ;;
	esac
	keep=$((keep / 2))
	[ "$keep" -ge 1 ] || keep=1

	tmp="$(mktemp "${GG_RUNLOG}.XXXXXX" 2>/dev/null)" || return 0
	if tail -n "$keep" -- "$GG_RUNLOG" >"$tmp" 2>/dev/null; then
		mv -f -- "$tmp" "$GG_RUNLOG" 2>/dev/null || rm -f -- "$tmp" 2>/dev/null
	else
		rm -f -- "$tmp" 2>/dev/null
	fi
	return 0
}

# gg_runlog_emit <decision> — one record for this evaluation.
#
# A no-op before the goal folder is known: an evaluation that never resolved a
# workstream has no log to belong to.
gg_runlog_emit() {
	local decision="$1" line elapsed

	[ -n "$GG_RUNLOG" ] || return 0

	elapsed=$((SECONDS - GG_BUDGET_START))
	[ "$elapsed" -ge 0 ] || elapsed=0

	line="$(printf '{"ts":"%s","iteration":%s,"workstream":"%s","agent":"%s","payload_shape":"%s","decision":"%s","evaluation_state":"%s","total":%s,"met":%s,"unmet":%s,"unmet_with_explanation":%s,"unmet_without_explanation":%s,"ticked_without_evidence":%s,"blocked":%s,"blocked_criteria":"%s","stall_count":%s,"wait_state":"%s","elapsed_s":%s}' \
		"$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" \
		"$(gg_runlog_num "${GG_LOG_ITERATION:-}")" \
		"$(gg_json_escape "$(gg_safe_text "${GG_LOG_WORKSTREAM:-}")")" \
		"$(gg_json_escape "$(gg_safe_text "${GG_LOG_AGENT:-}")")" \
		"$(gg_json_escape "$(gg_safe_text "${GG_LOG_SHAPE:-}")")" \
		"$(gg_json_escape "$(gg_safe_text "$decision")")" \
		"$(gg_json_escape "$(gg_safe_text "${GG_EVAL_STATE:-}")")" \
		"$(gg_runlog_num "${GG_EVAL_TOTAL:-}")" \
		"$(gg_runlog_num "${GG_EVAL_CHECKED:-}")" \
		"$(gg_runlog_num "${GG_EVAL_UNCHECKED:-}")" \
		"$(gg_runlog_num "${GG_EVAL_UWE:-}")" \
		"$(gg_runlog_num "${GG_EVAL_UWOE:-}")" \
		"$(gg_runlog_num "${GG_EVAL_TWE:-}")" \
		"$(gg_runlog_num "${GG_EVAL_BLOCKED:-}")" \
		"$(gg_json_escape "$(gg_safe_text "$(printf '%s' "${GG_LOG_BLOCKED_NAMED:-}" | cut -c1-600)")")" \
		"$(gg_runlog_num "${GG_LOG_STALL_COUNT:-}")" \
		"$(gg_json_escape "$(gg_safe_text "${GG_WAIT_STATE:-none}")")" \
		"$elapsed")"

	# The cap is what makes the append atomic (see the header). A record that
	# would exceed it is truncated to a still-valid minimal record rather than
	# written long and risking a splice.
	if [ "${#line}" -gt "$GG_RUNLOG_RECORD_CAP" ]; then
		line="$(printf '{"ts":"%s","iteration":%s,"decision":"%s","elapsed_s":%s,"note":"record truncated to preserve append atomicity"}' \
			"$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" \
			"$(gg_runlog_num "${GG_LOG_ITERATION:-}")" \
			"$(gg_json_escape "$(gg_safe_text "$decision")")" \
			"$elapsed")"
	fi

	gg_runlog_bound

	# Best effort, ALWAYS. A failure here is reported and never propagated:
	# the decision has already been made and must not change because a disk is
	# full or a path is occupied.
	if ! printf '%s\n' "$line" >>"$GG_RUNLOG" 2>/dev/null; then
		gg_note "run log degraded: could not append to $(gg_safe_text "$GG_RUNLOG"); the decision is unaffected"
	fi
	return 0
}

# gg_runlog_num <value> — a JSON number, or null. Never an unquoted empty
# string, which would make the whole record unparseable.
gg_runlog_num() {
	case "${1-}" in
	'' | *[!0-9]*) printf 'null' ;;
	*) printf '%s' "$1" ;;
	esac
}

# --- the sanctioned wait (T2.5) --------------------------------------------

# gg_wait_evaluate <gate-dir> <loop-file>
#
# Sets GG_WAIT_STATE to exactly one of:
#   none       no declaration — ordinary accounting
#   active     a valid, unexpired, budgeted wait — SUSPEND stall accounting
#   expired    the declared deadline has passed — ordinary accounting
#   rejected   the declaration is unusable — ordinary accounting, and SAID
#   exhausted  the R7 aggregate ceiling is spent — ordinary accounting, and SAID
#
# Every outcome other than `active` resumes ordinary accounting. None of them
# ever permits completion: this function decides whether the loop is allowed to
# stand still, never whether the work is done.
GG_WAIT_STATE="none"
GG_WAIT_NOTE=""
GG_WAIT_DEADLINE=""

gg_wait_evaluate() {
	local gate_dir="$1" loop_file="$2"
	local decl raw now deadline cum last spent max_cum

	GG_WAIT_STATE="none"
	GG_WAIT_NOTE=""
	GG_WAIT_DEADLINE=""

	decl="$gate_dir/WAIT"
	[ -e "$decl" ] || return 0

	if [ ! -f "$decl" ] || [ ! -r "$decl" ]; then
		GG_WAIT_STATE="rejected"
		GG_WAIT_NOTE="the wait declaration exists but could not be read, so no wait is in force"
		return 0
	fi

	# One line, whitespace trimmed. Nothing is stripped from WITHIN the value:
	# stripping is exactly how the ancestor turned `abc123def` into 123.
	raw="$(head -1 -- "$decl" 2>/dev/null | tr -d ' \t\r\n')"

	if [ -z "$raw" ]; then
		GG_WAIT_STATE="rejected"
		GG_WAIT_NOTE="the wait declaration is empty, so no wait is in force"
		return 0
	fi

	case "$raw" in
	*[!0-9]*)
		GG_WAIT_STATE="rejected"
		GG_WAIT_NOTE="the wait declaration $(gg_safe_text "$raw") is not a plain epoch-second deadline, so no wait is in force. Deadlines are epoch seconds - a date string is not parsed, because a parser that works on one userland and not another would fail silently"
		return 0
		;;
	esac

	# A value too long to be an epoch second is refused rather than truncated
	# into something plausible.
	if [ "${#raw}" -gt 11 ]; then
		GG_WAIT_STATE="rejected"
		GG_WAIT_NOTE="the wait declaration $(gg_safe_text "$raw") is not a usable epoch-second deadline (too large), so no wait is in force"
		return 0
	fi

	now="$(date +%s 2>/dev/null)"
	case "$now" in
	'' | *[!0-9]*)
		# No readable clock means staleness cannot be established. Ordinary
		# accounting is the conservative answer: a stall stays reachable.
		GG_WAIT_STATE="rejected"
		GG_WAIT_NOTE="the system clock could not be read, so no wait can be established"
		return 0
		;;
	esac

	deadline="$raw"

	# The clamp, REPORTED. Silently discarding an over-long deadline is the
	# ancestor's defect: the operator believes a wait is in force and it is not.
	if [ "$deadline" -gt "$((now + GG_WAIT_MAX_SINGLE))" ]; then
		GG_WAIT_NOTE="the declared deadline is further out than a single wait may run, so it was CLAMPED to ${GG_WAIT_MAX_SINGLE}s from now"
		deadline=$((now + GG_WAIT_MAX_SINGLE))
	fi

	# Not in the future is not a wait. `-le` and not `-lt`: a deadline of
	# exactly now has arrived.
	if [ "$deadline" -le "$now" ]; then
		GG_WAIT_STATE="expired"
		GG_WAIT_NOTE="the declared wait has expired, so ordinary stall accounting is running again"
		return 0
	fi

	# --- R7: the aggregate ceiling ---------------------------------------
	max_cum="$GG_WAIT_MAX_CUMULATIVE"
	case "$max_cum" in
	'' | *[!0-9]*) max_cum=86400 ;;
	esac

	cum="$(gg_state_get "$loop_file" "wait_cumulative")" || cum=""
	case "$cum" in
	'' | *[!0-9]*) cum=0 ;;
	esac

	# Time actually spent waiting is accumulated turn by turn, from the last
	# observation. Charging the DECLARED span instead would let a loop declare
	# a 24h wait, be killed for it immediately, and never wait at all.
	last="$(gg_state_get "$loop_file" "wait_last_seen")" || last=""
	case "$last" in
	'' | *[!0-9]*) last="" ;;
	esac
	if [ -n "$last" ] && [ "$now" -gt "$last" ]; then
		spent=$((now - last))
		# A single gap longer than the ceiling is capped, so a machine asleep
		# for a week does not overflow the accounting in one step.
		[ "$spent" -le "$max_cum" ] || spent="$max_cum"
		cum=$((cum + spent))
	fi

	if [ "$cum" -ge "$max_cum" ]; then
		gg_state_set "$loop_file" "wait_cumulative" "$cum" || true
		GG_WAIT_STATE="exhausted"
		GG_WAIT_NOTE="the cumulative wait budget for this loop (${max_cum}s) is spent, so no further wait is honoured and ordinary stall accounting has resumed. A wait is a delay, not an exemption"
		return 0
	fi

	gg_state_set "$loop_file" "wait_cumulative" "$cum" || true
	gg_state_set "$loop_file" "wait_last_seen" "$now" || true

	GG_WAIT_STATE="active"
	GG_WAIT_DEADLINE="$deadline"
	if [ -z "$GG_WAIT_NOTE" ]; then
		GG_WAIT_NOTE="a sanctioned wait is in force until epoch ${deadline}; stall accounting is suspended, and completion is still refused"
	else
		GG_WAIT_NOTE="${GG_WAIT_NOTE}; stall accounting is suspended, and completion is still refused"
	fi
	return 0
}

# --- stall detection (T2.4) ------------------------------------------------

# gg_stall_hash — hash stdin, printing the bare hex digest.
#
# Returns 1 if no hashing tool is available OR the tool produced nothing usable.
# It NEVER prints an empty hash on the success path: that is ancestor D8, where
# an absent tool's empty output matched the previous empty output and declared a
# stall that had not happened. The caller must treat a non-zero return as an
# error to refuse on, never as "no change".
gg_stall_hash() {
	local out="" tool="${GOAL_GATE_HASH_TOOL-}"

	if [ -n "$tool" ]; then
		# An explicit tool is used as given and is NOT silently replaced by a
		# fallback — otherwise a test (or an operator) pinning a specific tool
		# would be measuring the fallback instead.
		command -v "$tool" >/dev/null 2>&1 || return 1
		out="$("$tool" 2>/dev/null | head -1 | tr -d ' \t\r\n-')"
	elif command -v shasum >/dev/null 2>&1; then
		out="$(shasum -a 256 2>/dev/null | head -1 | tr -d ' \t\r\n-')"
	elif command -v sha256sum >/dev/null 2>&1; then
		out="$(sha256sum 2>/dev/null | head -1 | tr -d ' \t\r\n-')"
	else
		return 1
	fi

	# A tool that ran but said nothing is the same failure as no tool at all.
	[ -n "$out" ] || return 1
	printf '%s' "$out"
}

# A recovery token is a capability for one precise loop owner and progress
# hash. It is not a general stall reset. The token changes when measurable
# progress changes, so an old command cannot credit a later work state.
gg_recovery_token() {
	local loop_file="$1" identity="$2" turn_id="$3" stall_hash="$4" raw_count="$5"
	printf 'loop=%s\nowner=%s\nturn=%s\nhash=%s\nraw=%s\n' \
		"$loop_file" "$identity" "$turn_id" "$stall_hash" "$raw_count" |
		gg_stall_hash
}

gg_valid_recovery_token() {
	[ "${#1}" -eq 64 ] || return 1
	case "$1" in
	*[!0-9a-f]*) return 1 ;;
	esac
	return 0
}

# Remove only the marker named by a token that the gate itself recorded.
# `rmdir` cannot remove a populated or unrelated path.
gg_recovery_remove_marker() {
	local gate_dir="$1" token="$2"
	gg_valid_recovery_token "$token" || return 0
	rmdir -- "$gate_dir/.recovery-ack.$token" 2>/dev/null || true
}

gg_recovery_clear() {
	local loop_file="$1" gate_dir="$2" old_token="$3" field
	gg_recovery_remove_marker "$gate_dir" "$old_token"
	for field in recovery_token recovery_hash recovery_owner recovery_turn_id \
		recovery_guard_hash recovery_ack_at recovery_credits recovery_credit_applied; do
		gg_state_set "$loop_file" "$field" "" || true
	done
	GG_RECOVERY_ACK_COMMAND=""
}

# Issue a new capability and place its exact invocation in the next refusal.
gg_recovery_issue() {
	local loop_file="$1" identity="$2" turn_id="$3" stall_hash="$4" raw_count="$5"
	local goal_folder="$6" guard_hash="$7"
	local token
	token="$(gg_recovery_token "$loop_file" "$identity" "$turn_id" "$stall_hash" "$raw_count")" || return 1
	gg_valid_recovery_token "$token" || return 1

	gg_state_set "$loop_file" recovery_token "$token" || return 1
	gg_state_set "$loop_file" recovery_hash "$stall_hash" || return 1
	gg_state_set "$loop_file" recovery_owner "$identity" || return 1
	gg_state_set "$loop_file" recovery_turn_id "$turn_id" || return 1
	gg_state_set "$loop_file" recovery_guard_hash "$guard_hash" || return 1
	gg_state_set "$loop_file" recovery_credits 0 || return 1
	gg_state_set "$loop_file" recovery_credit_applied 0 || return 1
	gg_state_set "$loop_file" recovery_ack_at "" || return 1
	printf -v GG_RECOVERY_ACK_COMMAND 'bash %q recovery-ack %q %q' \
		"$GG_CANCEL" "$token" "$goal_folder"
	return 0
}

gg_recovery_command_if_unused() {
	local gate_dir="$1" token="$2" goal_folder="$3"
	GG_RECOVERY_ACK_COMMAND=""
	gg_valid_recovery_token "$token" || return 0
	[ -d "$gate_dir/.recovery-ack.$token" ] && return 0
	printf -v GG_RECOVERY_ACK_COMMAND 'bash %q recovery-ack %q %q' \
		"$GG_CANCEL" "$token" "$goal_folder"
}

# gg_repo_progress <dir> — a fingerprint of the WORK, not of the checklist.
#
# WHY THE CHECKLIST ALONE IS NOT A PROGRESS SIGNAL. Stall accounting used to hash
# the acceptance criteria file and nothing else, so "no change" meant "no
# criterion was ticked or evidenced this turn". A single large criterion takes
# more turns than that to satisfy — the agent writes code, runs tests, commits,
# and ticks nothing until the whole thing is true. Five such turns were
# indistinguishable from five turns of doing nothing, and the loop was killed for
# working exactly as intended. That is not a threshold that was set too low; it
# was the wrong measurement.
#
# So the repository itself is measured too: the committed HEAD, plus a digest of
# the working tree's dirty state. An agent that commits, edits, adds or deletes
# anything moves this, and the loop is credited with progress.
#
# EVERY FAILURE HERE IS SILENT AND SAFE. No git, not a repository, an unreadable
# tree, no hash tool: the function returns nothing and the checklist hash stands
# on its own, exactly as before. It can never manufacture a stall — the failure
# direction is a fingerprint that CHANGES (resetting the counter), never one that
# spuriously repeats.
gg_repo_progress() {
	local d="${1-}" head tree
	[ -n "$d" ] || return 1
	command -v git >/dev/null 2>&1 || return 1
	head="$(git -C "$d" rev-parse HEAD 2>/dev/null)" || return 1
	[ -n "$head" ] || return 1
	# Piped into the hash rather than into a variable: a working tree with tens of
	# thousands of dirty paths must not be held in memory to be measured.
	tree="$(git -C "$d" status --porcelain 2>/dev/null | gg_sha256)" || tree=""
	printf 'head=%s\nworktree=%s' "$head" "$tree"
}

# Bind an acknowledgment to the current work surfaces. The main stall hash
# includes evaluated criterion state. This guard adds the complete criteria
# file and repository fingerprint, so recovery-ack can reject a token when work
# changes before the next Stop evaluation.
gg_recovery_guard_hash() {
	local goal_folder="$1" acs_file="$2" repo="" acs=""
	repo="$(gg_repo_progress "$goal_folder")" || repo=""
	acs="$(gg_stall_hash <"$acs_file")" || return 1
	printf 'repo=%s\nacs=%s\n' "$repo" "$acs" | gg_stall_hash
}

# Increment an untrusted decimal state field without octal parsing or overflow.
gg_count_increment() {
	local value="${1-}" fallback="${2:-1}" normalized
	case "$value" in
	'' | *[!0-9]*) printf '%s' "$fallback"; return 0 ;;
	esac
	normalized="$(printf '%s' "$value" | sed 's/^0*//')"
	[ -n "$normalized" ] || normalized=0
	[ "${#normalized}" -le 9 ] || { printf '%s' "$fallback"; return 0; }
	printf '%s' "$((normalized + 1))"
}

# gg_stall_distinct <window-text> — how many DISTINCT hashes the window holds.
gg_stall_distinct() {
	printf '%s\n' "$1" | grep -c . >/dev/null 2>&1 || {
		printf '0'
		return 0
	}
	printf '%s\n' "$1" | sed '/^$/d' | sort -u | wc -l | tr -d ' '
}

# gg_stall_unmet_breakdown — the outstanding criteria, split by whether anyone
# has explained them (review finding R12 rule 3).
#
# "1 of 2 outstanding" is not actionable, and blurring the two categories is
# precisely what lets an unaddressed criterion sit silently while the report
# reads as orderly progress. When the evaluation could not run far enough to
# produce the breakdown, that is SAID rather than guessed at.
gg_stall_unmet_breakdown() {
	if gg_is_count "${GG_EVAL_UWOE:-}" && gg_is_count "${GG_EVAL_UWE:-}"; then
		printf '%s outstanding with a written explanation, %s with NONE' \
			"$GG_EVAL_UWE" "$GG_EVAL_UWOE"
		return 0
	fi
	printf 'the explained/unexplained breakdown is unavailable because the evaluation did not run to completion'
}

# gg_stall_criteria_text <acs-file> — the unmet criteria, named.
#
# A stall report that does not name what is outstanding leaves the reader with
# nothing to act on, which is the R6 defect wearing a different hat.
# gg_blocked_criteria_text <acs-file>
#
# Every blocked criterion, each with the reason given for it, for the ending
# report and the run log (T3.4). A partial ending that named no reasons would be
# the same silence this feature exists to remove — the operator has to be able
# to answer "what is blocked, and why?" without opening the file.
#
# A CRITICAL blocked criterion is marked as such: "the load-bearing criterion is
# blocked" is a materially different report from "two minor items are blocked".
#
# The text comes from an agent-writable file, so every field goes through
# gg_safe_text at the point of display, and is truncated the same way the other
# reason surfaces already truncate.
gg_blocked_criteria_text() {
	local acs="$1" out="" line text reason crit
	[ -r "$acs" ] || return 1
	while IFS= read -r line; do
		case "$line" in
		'- [!] '*)
			[ -n "$out" ] && out="$out; "
			text="${line:6}"
			crit=""
			case "$text" in
			'**CRITICAL** '*)
				crit="CRITICAL: "
				text="${text#'**CRITICAL** '}"
				;;
			esac
			out="$out$crit$(printf '%s' "$text" | cut -c1-160)"
			;;
		[[:space:]]*'- blocked:'*)
			# Belongs to the criterion just opened; ignored for any other state
			# because only a `- [!] ` line ever opens one here.
			[ -n "$out" ] || continue
			reason="${line#*- blocked:}"
			reason="${reason#"${reason%%[![:space:]]*}"}"
			[ -n "$reason" ] && out="$out -- reason: $(printf '%s' "$reason" | cut -c1-240)"
			;;
		esac
	done <"$acs"
	[ -n "$out" ] || return 1
	printf '%s' "$out"
}

gg_stall_criteria_text() {
	local acs="$1" text
	[ -r "$acs" ] || return 1
	text="$(grep -nE '^[[:space:]]*([-*+]|[0-9]+[.)])[[:space:]]+\[[[:space:]]\]' -- "$acs" 2>/dev/null |
		head -20 |
		sed -e 's/^[0-9]*:[[:space:]]*//' -e 's/^\([-*+]\|[0-9]*[.)]\)[[:space:]]*\[[[:space:]]\][[:space:]]*//' |
		cut -c1-160 |
		tr '\n' '~')"
	text="${text//\~/; }"
	[ -n "$text" ] || return 1
	printf '%s' "$text"
}

# gg_stall_terminal <loop-file> <kind> <count> <max> <acs> <identity> <iteration>
#
# The terminal decision. R6: reaching the threshold must STOP BLOCKING and say
# so — a stall that only logs leaves the session blocked indefinitely, which is
# the failure the threshold exists to prevent. It is a NON-COMPLETION: nothing
# is marked met and no completion record is written.
gg_stall_terminal() {
	local loop_file="$1" kind="$2" count="$3" max="$4" acs="$5" identity="$6" iteration="$7"
	local named how

	named="$(gg_stall_criteria_text "$acs")" ||
		named="(the criteria file could not be read to name them)"

	if [ "$kind" = "flap" ]; then
		how="the loop is oscillating between a small number of repeated states rather than advancing: the last ${count} evaluations hold no more than two distinct outcomes"
	else
		how="the last ${count} consecutive evaluations reached an identical outcome, meeting the threshold of ${max}"
	fi

	GG_DECISION_LABEL="stalled"
	gg_state_set "$loop_file" "decision" "stalled" || true

	# As on the permit path: `status=stalled` is what RETIRES the workstream, so
	# a failed write would leave a dead loop re-tripping this same stall on every
	# turn. Refusing costs one iteration; the alternative is an immortal loop.
	if ! gg_state_set "$loop_file" "status" "stalled"; then
		GG_DECISION_LABEL="refused_unrecordable"
		gg_refuse "the loop has stalled (${how}) but the stalled status could not be written to $(gg_safe_text "$loop_file"), so it cannot be retired and would re-trip this stall every turn. Fix the state directory, then cancel the loop deliberately."
	fi
	gg_state_set "$loop_file" "stall_kind" "$kind" || true
	gg_state_set "$loop_file" "unmet_at_stall" "${GG_EVAL_UNCHECKED:-<not-run>}" || true

	# The status is written; now take the name out of the adoptable pool too, so
	# a stalled loop cannot present itself to another conversation as work to
	# pick up. The label is read from the loop file FIRST, because the rename
	# moves the file the label comes from.
	local stall_label
	stall_label="$(gg_loop_label "$loop_file")"
	gg_retire_workstream "$GG_GATE_DIR" "$identity" || true

	gg_terminal "STALLED - the loop is repeating without progress and is being ended WITHOUT completion. This is not a pass: no criterion is marked met and no completion record has been written. How this was established: ${how}. Outstanding: ${GG_EVAL_UNCHECKED:-<not-run>} of ${GG_EVAL_TOTAL:-<not-run>} acceptance criteria - $(gg_stall_unmet_breakdown). Still to do: $(gg_safe_text "$named") (goal $(gg_safe_text "$stall_label"), iteration ${iteration})."
}

# --- the completion record -------------------------------------------------

# gg_write_completion_record <path> <acs> <identity> <agent> <iteration>
#
# Names the criteria and their evidence by embedding the evaluated file
# VERBATIM alongside the per-criterion decision trail. The file's text is
# written with `cat` and `printf '%s'` only — never expanded, never evaluated,
# never used as a format string — so criterion text remains inert data here
# exactly as it is everywhere else in this gate.
gg_write_completion_record() {
	local path="$1" acs="$2" identity="$3" agent="$4" iteration="$5"
	local tmp when

	when="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || when=""
	[ -n "$when" ] || when="<clock unavailable>"

	tmp="${path}.tmp.$$"
	{
		printf '# Goal-gate completion record\n\n'
		printf 'decision: permitted\n'
		printf 'workstream: %s\n' "$identity"
		printf 'agent: %s\n' "$agent"
		printf 'iteration: %s\n' "$iteration"
		printf 'recorded-at: %s\n' "$when"
		printf 'acceptance-criteria-file: %s\n' "$acs"
		printf 'total: %s\n' "$GG_EVAL_TOTAL"
		printf 'checked: %s\n' "$GG_EVAL_CHECKED"
		printf 'unchecked: %s\n' "$GG_EVAL_UNCHECKED"
		printf 'ticked-with-evidence: %s\n' "$GG_EVAL_CHECKED"
		printf '\n## Per-criterion decision trail\n\n'
		printf '%s\n' "$GG_EVAL_TRAIL"
		printf '\n## Acceptance criteria as evaluated\n\n'
	} >"$tmp" 2>/dev/null || {
		rm -f -- "$tmp"
		return 1
	}

	cat -- "$acs" >>"$tmp" 2>/dev/null || {
		rm -f -- "$tmp"
		return 1
	}

	mv -f -- "$tmp" "$path" 2>/dev/null || {
		rm -f -- "$tmp"
		return 1
	}
	return 0
}

# ===========================================================================
# main
# ===========================================================================

gg_main() {
	case "${1-}" in
	-h | --help)
		# Deliberately on STDERR. This script's stdout is a control channel:
		# whatever appears there is read as the decision. The help text quotes
		# the contract, so it contains a literal {"decision":"block",...} — if
		# that went to stdout, a harness invoking --help would read a genuine
		# block decision out of the documentation.
		# The whole leading comment block, however long it grows. A hardcoded
		# line range would silently start truncating mid-sentence the first
		# time a later stage (T2.2-T2.6) extends this header.
		awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0" >&2
		return 0
		;;
	'') : ;;
	*)
		printf 'goal-gate: unknown argument: %s\n' "$1" >&2
		printf 'goal-gate: usage: goal-gate-stop.sh < request.json\n' >&2
		return 64
		;;
	esac

	# --- Stage 1: read stdin once -------------------------------------
	gg_read_payload

	# --- Stage 2: tooling ---------------------------------------------
	#
	# Before anything else that needs a parsed payload. Without jq the payload
	# cannot be understood at all, so the gate directory is resolved from the
	# process's own working directory — enough to answer the one question that
	# still matters: is a workstream being guarded here? If yes, REFUSE and say
	# why; the ancestor had no such guard and silently allowed the stop.
	if ! gg_have_jq; then
		gg_gate_absent_here "$PWD" &&
			gg_no_claim "jq is unavailable and no ${GG_MARKER} directory governs $PWD"
		gg_refuse "cannot verify completion: jq is not installed or not on PATH, so the hook request cannot be parsed. Install jq. The gate refuses rather than assume the work is done."
	fi

	if ! gg_b64_init; then
		gg_gate_absent_here "$PWD" &&
			gg_no_claim "base64 is unavailable and no ${GG_MARKER} directory governs $PWD"
		gg_refuse "cannot verify completion: no usable base64 decoder was found, so payload fields cannot be read safely."
	fi

	# --- Empty stdin ---------------------------------------------------
	if [ -z "$GG_PAYLOAD" ]; then
		gg_refuse "cannot verify completion: the hook request was empty. No session or workstream could be identified."
	fi

	# --- Stage 3: parse ------------------------------------------------
	local parse_rc=0
	gg_parse_payload || parse_rc=$?
	case "$parse_rc" in
	0) : ;;
	2) gg_refuse "cannot verify completion: the hook request is valid JSON but is not an object, so it carries no identifiable fields." ;;
	3) gg_refuse "cannot verify completion: the hook request contained more than one JSON document." ;;
	*) gg_refuse "cannot verify completion: the hook request is not valid JSON and could not be parsed." ;;
	esac

	# --- Stage 4: agent detection --------------------------------------
	#
	# Detection is by SHARED FIELD, never by a field unique to one agent being
	# mandatory. An unrecognised shape refuses.
	local agent="unknown"
	local have_session=0 have_turn=0

	if [ "$GG_SESSION_ID_PRESENT" -eq 1 ] && gg_identity_usable "$GG_SESSION_ID"; then
		have_session=1
	fi
	if [ "$GG_TURN_ID_PRESENT" -eq 1 ] && gg_identity_usable "$GG_TURN_ID"; then
		have_turn=1
	fi

	# `turn_id` is tested FIRST because it is the discriminating field: the live
	# Codex payload (T3.4, live-evidence/codex-stop-payload.json) carries BOTH
	# session_id and turn_id, while the Claude payload carries session_id and no
	# turn_id. Testing session_id first therefore labelled every Codex run
	# `claude`. Nothing behavioural hangs on the label — binding, claiming and
	# the decision are identical either way — but a run log that misnames the
	# agent is a run log that misleads whoever reads it next.
	#
	# This does NOT weaken the shared-field rule above: identity still requires
	# session_id OR turn_id, and neither is mandatory on its own.
	if [ "$have_turn" -eq 1 ]; then
		agent="codex"
	elif [ "$have_session" -eq 1 ]; then
		agent="claude"
	fi
	if [ "$agent" = "codex" ] && [ "$have_session" -eq 1 ] && [ "$have_turn" -eq 1 ]; then
		GG_CODEX_RECOVERY_ELIGIBLE=1
	fi

	gg_record_fire "$agent"

	if [ "$agent" = "unknown" ]; then
		gg_refuse "cannot verify completion: the hook request carries no usable identity - neither session_id nor turn_id was a non-empty string. The agent shape is unrecognised, so no workstream could be bound."
	fi

	# --- Stage 5: gate directory ---------------------------------------
	#
	# The payload's cwd when it is usable, otherwise this process's own working
	# directory. cwd is Claude-shaped and absent from the Codex payload, so
	# requiring it would break portability — hence the fallback.
	local base_dir="$PWD"
	if [ "$GG_CWD_PRESENT" -eq 1 ] && gg_identity_usable "$GG_CWD" && [ -d "$GG_CWD" ]; then
		base_dir="$GG_CWD"
	fi

	local gate_dir locate_rc=0
	gate_dir="$(gg_locate_gate_dir "$base_dir")" || locate_rc=$?
	# The resolved directory, in a global as well, for the terminal helpers that
	# are reached through several frames and cannot be handed gg_main's local.
	GG_GATE_DIR="$gate_dir"
	case "$locate_rc" in
	0) : ;;
	2)
		# EXISTS but could not be entered. Reported, never mistaken for absence:
		# standing down silently on an unreadable state directory would end the
		# turn with an empty stdout, which a host reads as consent.
		gg_refuse "cannot verify completion: the workstream state directory $(gg_safe_text "${GOAL_GATE_DIR:-$base_dir}") exists but could not be entered or read, so no workstream could be resolved and no loop state could be read. The gate reports this rather than assume it governs nothing."
		;;
	*)
		gg_no_claim "no ${GG_MARKER} directory above $(gg_safe_text "$base_dir") - no workstream is being guarded"
		;;
	esac
	if [ ! -r "$gate_dir" ] || [ ! -x "$gate_dir" ]; then
		gg_refuse "cannot verify completion: the workstream state directory $(gg_safe_text "$gate_dir") cannot be read, so no workstream could be resolved. A state directory that cannot be read is reported, not treated as empty."
	fi
	if [ ! -w "$gate_dir" ]; then
		gg_refuse "cannot verify completion: the gate directory is not writable, so loop state cannot be recorded."
	fi

	# --- Stage 5b: bind the identity -----------------------------------
	local identity=""
	if [ "$have_session" -eq 1 ]; then
		# A session_id comes from the payload, so it is attacker-shaped input
		# and must clear the allow-list before it can name a file.
		if [ "$GG_SESSION_ID_LOSSY" -eq 1 ]; then
			gg_refuse "cannot verify completion: session_id contains a NUL byte or does not survive intact, so it cannot safely identify a workstream."
		fi
		if ! gg_identity_safe "$GG_SESSION_ID"; then
			gg_refuse "cannot verify completion: session_id contains characters that are not permitted in a workstream identity (only letters, digits, dot, dash and underscore are allowed). Rejected before composing any path."
		fi
		# The three namespace prefixes are RESERVED. An identity beginning with
		# one of them would name its own self-bound file inside a pool it does
		# not belong to — `_anon-x.state` is an unclaimed workstream to every
		# other conversation in this directory. Refused before any path exists.
		if gg_identity_reserved "$GG_SESSION_ID"; then
			gg_refuse "cannot verify completion: session_id begins with a reserved workstream namespace prefix ($(gg_safe_text "$GG_ANON_PREFIX"), $(gg_safe_text "$GG_WS_PREFIX") or $(gg_safe_text "$GG_ENDED_PREFIX")), so it cannot name a conversation without colliding with the unclaimed, claimed or retired pool. Rejected before composing any path."
		fi
		identity="$GG_SESSION_ID"
	else
		# No session_id. Bind on the DERIVED STABLE KEY — never on turn_id,
		# which changes every turn and would reset the iteration counter to 1
		# forever, making a stall undetectable.
		if ! identity="$(gg_derived_identity "$gate_dir")"; then
			gg_refuse "cannot verify completion: no SHA-256 tool (shasum or sha256sum) is available, so a stable workstream key cannot be derived."
		fi
		if ! gg_identity_safe "$identity"; then
			gg_refuse "cannot verify completion: the derived workstream key is not a safe filename."
		fi
		# `derived-<hex>` cannot begin with a reserved prefix, and the test is
		# applied anyway: the derivation is one edit away from producing a
		# different shape, and the collision it would cause is silent.
		if gg_identity_reserved "$identity"; then
			gg_refuse "cannot verify completion: the derived workstream key begins with a reserved workstream namespace prefix, so it cannot name a conversation without colliding with an adoption pool."
		fi
	fi

	# --- Stage 5a': IS A LOOP IN OPERATION HERE AT ALL? -------------------
	#
	# THE FIRST GATE, and it is a file-existence test. A loop exists in this
	# directory only if one of these is on disk:
	#
	#   * `_anon-<hash>.state` — written by pursue-goal BEFORE any session
	#     exists to name it, which is exactly why the name is a hash: it is a
	#     binding handle, not a description, and it is never shown to a reader;
	#   * `_ws-<identity>.state` — a claimed loop, this conversation's or
	#     another's. Both count: a live loop belonging to somebody else still
	#     means a loop is in operation here, and the stand-down that follows is
	#     the honest answer for a bystander rather than silence about a running
	#     goal. Probing only `_anon-*` was a latent bug that this change would
	#     have turned into a real one — every claimed loop is `_ws-*` now, so a
	#     gate directory holding one live loop and nothing else would have looked
	#     empty and its own owner would have been stood down every turn;
	#   * `_ended-<identity>-*.state` — a RETIRED loop belonging to THIS
	#     conversation. It is how an owner returns to its own finished loop and
	#     has a regression against a completed checklist seen. Retired loops
	#     belonging to anybody else are deliberately not probed for: they are
	#     history, and nobody else has any business being held by one;
	#   * `<session-id>.state` — a loop already bound to THIS conversation;
	#   * an `ACs.md` beside the gate directory — the co-located layout, where
	#     the checklist itself is the evidence that a goal is being driven here.
	#
	# None of the three means no goal is being pursued in this tree, and the
	# honest answer is silence. Returning HERE, before the claim handshake,
	# matters for more than speed: everything downstream — generation counting,
	# lock acquisition, liveness touching, stale reclaim — is machinery for
	# deciding WHICH loop is ours, and running it when there is no loop at all
	# is how an unrelated conversation ends up self-bound to a workstream it
	# never started. The later stand-down catches that case too, but only after
	# the handshake has already run.
	#
	# The prefixes come from the constants, never re-typed as literals: this
	# probe hard-coded `_anon-*` while everything else used GG_ANON_PREFIX, and
	# the two drifting apart is precisely how a namespace gets added everywhere
	# except the one place that decides whether the gate runs at all.
	local gg_has_loop=0 gg_probe gg_prefix
	for gg_prefix in "$GG_ANON_PREFIX" "$GG_WS_PREFIX"; do
		for gg_probe in "$gate_dir/$gg_prefix"*.state; do
			[ -f "$gg_probe" ] && gg_has_loop=1 && break 2
		done
	done
	if [ "$gg_has_loop" -eq 0 ] && gg_identity_safe "$identity"; then
		# This conversation's own retired loops. The glob is a prefilter and
		# nothing more — `_ended-sess-*` also matches `_ended-sess-happy-*` — so
		# it can only ever say "there may be a loop here", which is all this
		# stage decides. gg_ended_own proves ownership afterwards, and a stranger
		# who gets this far self-binds and stands down.
		for gg_probe in "$gate_dir/${GG_ENDED_PREFIX}${identity}-"*.state; do
			[ -f "$gg_probe" ] && gg_has_loop=1 && break
		done
	fi
	if [ "$gg_has_loop" -eq 0 ] && gg_identity_safe "$identity" &&
		[ -f "$gate_dir/$identity.state" ]; then
		gg_has_loop=1
	fi
	if [ "$gg_has_loop" -eq 0 ]; then
		local gg_colocated="${GOAL_GATE_ACS:-$(dirname -- "$gate_dir")/ACs.md}"
		[ -f "$gg_colocated" ] && [ -r "$gg_colocated" ] && gg_has_loop=1
	fi
	# A RAISED BLOCKER IS ALSO EVIDENCE THAT A LOOP EXISTS HERE, and it outranks
	# every other consideration: a declared blocker must ALWAYS be brought to a
	# reported end. A workstream can be blocked with its criteria file already
	# gone — lost in a bad rebase is the case the suite pins — and standing down
	# on "no ACs.md" would leave that blocker raised and unreported for ever,
	# which is the indefinite-loop defect wearing a different hat.
	# Caught by `r5/a-blocked-workstream-with-no-criteria-file-still-terminates`.
	if [ "$gg_has_loop" -eq 0 ]; then
		for gg_probe in "$gate_dir"/*.LOOP_BLOCKED; do
			[ -f "$gg_probe" ] && gg_has_loop=1 && break
		done
	fi
	if [ "$gg_has_loop" -eq 0 ]; then
		gg_no_claim "no goal loop exists in this tree - no workstream state file and no co-located ACs.md. The gate is passive this turn and writes nothing. Run pursue-goal to start one."
	fi

	# --- Stage 5b': the claim handshake (T2.3) --------------------------
	#
	# Which workstream this conversation is bound to. Resolution runs BEFORE the
	# loop file is named, because the whole point is that the file may be one
	# `pursue-goal` wrote and this conversation has yet to claim.
	local claim_rc=0
	gg_resolve_workstream "$gate_dir" "$identity" || claim_rc=$?
	if [ "$claim_rc" -ne 0 ]; then
		gg_refuse "cannot verify completion: ${GG_CLAIM_ERROR:-the workstream could not be bound to this conversation}. The gate will not evaluate a workstream it does not own."
	fi

	# --- the gate is PASSIVE when no goal is being pursued here -------------
	#
	# A `self` binding means this conversation claimed NO adoptable workstream:
	# `pursue-goal` started no loop for it. Such a conversation is only DRIVING a
	# goal if an acceptance checklist genuinely sits where it stands — the
	# co-located layout, an `ACs.md` at the gate directory's parent. In the
	# normal layout the gate directory is the REPOSITORY ROOT's `.goal-gate/` and
	# real goals live in `X.goal/`, bound through the claimed workstream, not
	# here — so there is no such checklist, and the honest answer is "no goal is
	# being pursued", not a refusal.
	#
	# So the gate STANDS DOWN NOW, before it writes a single byte of state: no
	# self-bound `<identity>.state`, no iteration bump, no evaluation. The
	# predecessor instead self-bound every unrelated conversation and REFUSED it
	# each turn, citing a `<repo>/ACs.md` that was never meant to exist — a fresh
	# session blocked forever for a goal it never started. The one bypass this
	# guarded against — an agent "resetting its session id" to escape a live goal
	# — does not exist: an agent cannot rewrite the host-issued session_id, and a
	# genuinely abandoned loop is recovered by pass 3's stale-reclaim, not by
	# holding bystanders hostage. Standing down writes no completion record and
	# emits no permit, so it can never be mistaken for one (test-binding.sh §9).
	# A raised LOOP_BLOCKED is the one thing that must ALWAYS be brought to a
	# reported end, so it is honoured even for a self binding — the stand-down is
	# skipped when the blocked signal is present and the normal terminal handling
	# in Stage 6 runs.
	#
	# It consults the KEYED path, and only the keyed path. Testing a bare
	# `LOOP_BLOCKED` here is the v0.51.4 regression: a bystander conversation in
	# a repository where SOME OTHER session had declared a blocker skipped its
	# own silent stand-down and was refused instead, every turn, over a signal
	# that was never about it. A `self`-bound conversation in the co-located
	# layout still honours ITS OWN keyed signal, which is why the case is
	# consulted rather than skipped outright.
	local self_blocked_signal=""
	self_blocked_signal="$(gg_blocked_signal_path "$gate_dir" "$GG_WORKSTREAM")" || self_blocked_signal=""
	if [ "$GG_CLAIM_EVENT" = "self" ] &&
		{ [ -z "$self_blocked_signal" ] || [ ! -f "$self_blocked_signal" ]; }; then
		local self_acs="${GOAL_GATE_ACS-}"
		if [ -z "$self_acs" ]; then
			self_acs="$(dirname -- "$gate_dir")/ACs.md"
		fi
		if [ ! -f "$self_acs" ] || [ ! -r "$self_acs" ]; then
			if [ -n "$GG_FOREIGN_OWNER" ]; then
				# Stand down SILENTLY — see the note above the other stand-down.
				gg_no_claim "a goal loop is running in this tree, owned by conversation $(gg_safe_text "$GG_FOREIGN_OWNER"), and this conversation is not driving it. Standing down: nothing is written and nothing about the owner's goal is claimed."
			fi
			gg_no_claim "no goal is being pursued in this tree - the gate is passive this turn. Run pursue-goal to start one."
		fi
	fi

	local loop_file="$gate_dir/$GG_WORKSTREAM.state"

	# NOTE — WHY `complete` IS *NOT* SHORT-CIRCUITED HERE, AND EVERY OTHER END IS.
	#
	# `complete` is re-evaluated on every turn, deliberately. A permit is NOT a
	# one-shot: re-evaluating a completed workstream is what makes a REGRESSION
	# visible — add an unmet criterion to a completed checklist and the next turn
	# withdraws the permit and blocks again. Skip it and a goal recorded as done
	# stays recorded as done however far its criteria drift afterwards, which is
	# the exact failure mode this whole mechanism exists to prevent
	# (test-decision.sh, section "discipline").
	#
	# THE ARGUMENT DOES NOT CARRY TO THE OTHER TERMINAL STATUSES, and treating the
	# set as one made a cancelled loop INESCAPABLE (field defect, 2026-08-05). A
	# reported END — cancelled, stalled, bound-exceeded, blocked — issued no
	# permit, so there is nothing to withdraw, and its criteria are abandoned by
	# definition, so re-evaluating can only ever produce `refused_unmet`. The
	# owner's own binding survives a cancel (cancel.sh records the status without
	# retiring the claim), so the owner resolved its cancelled workstream through
	# that surviving claim, was refused, and could not end a turn again: cancel.sh
	# then declines to act because the status is already terminal, and hand-editing
	# state and unregistering the hook are both forbidden. Standing down here is
	# the honest reading of "this loop has ended".
	#
	# Restarting still works: `pursue-goal` writes a FRESH `_anon-*`, and an ended
	# workstream is deferred to gg_resolve_workstream's last resort — retired out
	# of the pool by name, or held back by pass 1's status test if it could not be
	# renamed — so the new one wins and is evaluated normally.
	# A STATUS SET BUT NEVER REPORTED IS NOT YET AN END (pre-existing defect,
	# confirmed against git HEAD: `r5/loop-blocked-via-state-terminates-too`
	# failed there too, so this predates the blocked-criteria work).
	#
	# A skill raises a blocker by writing `status=LOOP_BLOCKED` into the loop
	# file, which is the documented way to do it without touching the gate
	# directory's layout. But the short-circuit below fired first and stood the
	# turn down generically — so the blocker's REASON was never reported, and the
	# one message the operator needed ("this ended, and here is why") was
	# replaced by "this already ended", on the very turn it ended. The blocker
	# was swallowed by the mechanism meant to announce it.
	#
	# The test is whether the ending has been REPORTED, not whether the status is
	# terminal: `decision` is written by the branch that announces it. So an
	# unreported terminal status falls through to Stage 6 exactly once, is
	# announced there with its reason, and stands down on every turn after.
	# A BLOCKED STATUS SET BUT NEVER ANNOUNCED IS NOT YET A REPORTED END
	# (pre-existing defect, confirmed against git HEAD, where
	# `r5/loop-blocked-via-state-terminates-too` fails too — it predates the
	# blocked-criteria work).
	#
	# A skill raises a blocker by writing `status=LOOP_BLOCKED` into the loop
	# file — the documented way to do it without touching the gate directory's
	# layout. The short-circuit below fired first and stood the turn down
	# generically, so the blocker's REASON was never reported: on the very turn
	# the loop ended, the operator got "this already ended" instead of "this
	# ended, and here is why". The blocker was swallowed by the mechanism meant
	# to announce it.
	#
	# The exception is deliberately narrow — only the two statuses that carry a
	# REASON someone has to read, and only until it has been announced once.
	# `cancelled`, `stalled` and `recursion_bound_exceeded` keep the plain
	# short-circuit: they carry no reason the gate is holding back, and letting
	# `cancelled` fall through is what made a cancelled loop inescapable in the
	# 2026-08-05 field defect.
	#
	# "Announced" is the matching `decision` label, written by the branch that
	# announces it. `decision` alone is not the test: it is rewritten on every
	# turn, so a loop refused once already carries one.
	local ended_status ended_decision announce_once=0
	ended_status="$(gg_state_get "$loop_file" "status")" || ended_status=""
	ended_decision="$(gg_state_get "$loop_file" "decision")" || ended_decision=""
	case "$ended_status" in
	LOOP_BLOCKED) [ "$ended_decision" = "loop_blocked" ] || announce_once=1 ;;
	LOOP_PARTIAL) [ "$ended_decision" = "loop_partial" ] || announce_once=1 ;;
	esac
	if [ "$ended_status" != "complete" ] && [ "$announce_once" -eq 0 ]; then
		case " $GG_TERMINAL_STATUSES " in
		*" $ended_status "*)
			# THE SIXTH STATUS RETIRES HERE, and so does any retirement that
			# failed earlier. `cancelled` is written by cancel.sh, in another
			# process, which cannot rename a workstream out of the pool without
			# duplicating the whole claim protocol — so the gate does it on the
			# first turn it sees the ended loop, which is the earliest moment a
			# bound identity exists to name the retired file with. The same line
			# re-attempts any rename that could not complete on the turn the loop
			# actually ended, so a transient filesystem failure costs a turn
			# rather than leaving a finished loop in the pool for good.
			#
			# It is best-effort and it changes no verdict: this branch stands the
			# turn down either way, and the status alone already keeps the loop
			# out of every resolution pass. The label is read before the rename,
			# because the rename moves the file it is read from.
			local ended_label
			ended_label="$(gg_loop_label "$loop_file")"
			if gg_retire_workstream "$gate_dir" "$identity"; then
				loop_file="$GG_RETIRED_LOOP_FILE"
			fi
			gg_no_claim "the goal $(gg_safe_text "$ended_label") has already reached a reported END (status=${ended_status}) - it is not re-evaluated and nothing is written. This is NOT a completion: no criterion is marked met and no completion record exists. Start a new loop with pursue-goal if the work is to continue."
			;;
		esac
	fi

	# --- Stage 5c: record ----------------------------------------------
	if ! gg_state_set "$loop_file" "binding_identity" "$identity"; then
		gg_refuse "cannot verify completion: the loop state file could not be written, so progress cannot be tracked."
	fi
	gg_state_set "$loop_file" "agent" "$agent" || true

	# The claim, recorded so that who owns what — and every takeover — is
	# reconstructable from the loop file afterwards.
	gg_state_set "$loop_file" "workstream" "$GG_WORKSTREAM" || true
	gg_state_set "$loop_file" "claimed_by" "$identity" || true
	gg_state_set "$loop_file" "claim_event" "$GG_CLAIM_EVENT" || true
	case "$GG_CLAIM_EVENT" in
	claimed)
		gg_state_set "$loop_file" "claimed_at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || true
		if [ -n "$GG_CLAIM_RENAMED_FROM" ]; then
			gg_state_set "$loop_file" "claimed_from_name" "$GG_CLAIM_RENAMED_FROM" || true
			gg_note "claimed unclaimed workstream $(gg_safe_text "$GG_CLAIM_RENAMED_FROM") for conversation ${identity}, and renamed it ${GG_WORKSTREAM} to say so"
		else
			gg_note "claimed unclaimed workstream ${GG_WORKSTREAM} for conversation ${identity}"
		fi
		;;
	reclaimed)
		# S58/R8: a reclamation is never silent. Without this a crashed session
		# would look indistinguishable from a clean hand-over.
		gg_state_set "$loop_file" "claimed_at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || true
		gg_state_set "$loop_file" "reclaimed_from" "$GG_CLAIM_PREV_OWNER" || true
		gg_state_set "$loop_file" "reclaim_reason" "$GG_CLAIM_REASON" || true
		gg_state_set "$loop_file" "reclaimed_at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || true
		if [ -n "$GG_CLAIM_RENAMED_FROM" ]; then
			gg_state_set "$loop_file" "claimed_from_name" "$GG_CLAIM_RENAMED_FROM" || true
			gg_note "RECLAIMED workstream $(gg_safe_text "$GG_CLAIM_RENAMED_FROM") from conversation $(gg_safe_text "$GG_CLAIM_PREV_OWNER") for ${identity}, now named ${GG_WORKSTREAM}: $(gg_safe_text "$GG_CLAIM_REASON")."
		else
			gg_note "RECLAIMED workstream ${GG_WORKSTREAM} from conversation $(gg_safe_text "$GG_CLAIM_PREV_OWNER") for ${identity}: $(gg_safe_text "$GG_CLAIM_REASON")."
		fi
		;;
	esac

	# turn_id is recorded for diagnostics ONLY. It is deliberately stored well
	# after the identity is bound, so there is no path on which it influences
	# which file was chosen.
	#
	# A turn_id that did not survive the trip into a shell variable intact (an
	# embedded NUL, say) is recorded as an explicit marker rather than as its
	# truncated remains. Recording "tt" for a turn_id of "tt\0tt" would put a
	# value in the loop file that never existed on the wire, and a diagnostic
	# that quietly lies is worse than one that admits it could not be read.
	if [ "$have_turn" -eq 1 ]; then
		if [ "$GG_TURN_ID_LOSSY" -eq 1 ]; then
			gg_state_set "$loop_file" "last_turn_id" "<unreadable>" || true
		else
			gg_state_set "$loop_file" "last_turn_id" "$GG_TURN_ID" || true
		fi
	fi
	if [ -n "$GG_LAM_LEN" ]; then
		gg_state_set "$loop_file" "last_message_bytes" "$GG_LAM_LEN" || true
	fi

	# --- Stage 5d: iteration + the D6 recursion bound -------------------
	local iteration
	iteration="$(gg_state_get "$loop_file" "iteration")" || iteration=""
	case "$iteration" in
	'' | *[!0-9]*) iteration=0 ;;
	esac
	iteration=$((iteration + 1))
	gg_state_set "$loop_file" "iteration" "$iteration" || true

	local max="$GG_MAX_ITERATIONS"
	case "$max" in
	'' | *[!0-9]*) max=50 ;;
	esac

	# THE RUN-LOG FIELDS ARE CAPTURED BEFORE THE FIRST PATH THAT CAN END THE
	# LOOP, not after it. The bound below retires the workstream and stands down;
	# capturing the workstream only at gg_runlog_init — which is further down,
	# past this branch — left this one ending with an EMPTY workstream field
	# while every other ending named one. They are set again there, once the goal
	# folder is known and the log is live; setting them twice costs nothing and
	# means no ending can outrun the capture.
	GG_LOG_ITERATION="$iteration"
	GG_LOG_WORKSTREAM="${GG_WORKSTREAM:-$identity}"

	if [ "$GG_STOP_HOOK_ACTIVE" = "true" ] && [ "$iteration" -gt "$max" ]; then
		# D6. The ancestor would re-block here forever. The bound is the escape
		# hatch, and it is recorded so that tripping it is evident rather than
		# looking like a clean finish.
		gg_state_set "$loop_file" "status" "recursion_bound_exceeded" || true
		gg_user_note "THE LOOP HAS ENDED WITHOUT COMPLETION - the recursion bound was reached at iteration ${iteration} of ${max}. The work is NOT confirmed done. Goal: $(gg_safe_text "$(gg_loop_label "$loop_file")") (status=recursion_bound_exceeded)."
		# The label above is read from the loop file, so the retirement rename
		# happens AFTER it. Every terminal path in this script follows the same
		# order for the same reason.
		if gg_retire_workstream "$gate_dir" "$identity"; then
			loop_file="$GG_RETIRED_LOOP_FILE"
			GG_LOG_WORKSTREAM="$GG_WORKSTREAM"
		fi
		gg_no_claim "recursion bound reached: iteration $iteration exceeds ${max} with the recursion flag set. The gate is standing down to avoid an unbounded block; the work is NOT confirmed done and 'status=recursion_bound_exceeded' is recorded in $(gg_safe_text "$loop_file")."
	fi

	# --- Stage 6: the completion decision (T2.2) ------------------------
	#
	# T2.4 adds stall detection, T2.5 the sanctioned wait, T2.6 the run log —
	# all after this point.

	gg_budget_init

	local goal_folder acs_file
	# The gate directory sits on an ANCESTOR of the session's working directory
	# — that is the only place the upward walk can find it — so it is usually
	# NOT inside the goal folder. `pursue-goal` therefore records the folder it
	# bound as an absolute `goal_folder` field, and that binding wins. The
	# dirname is the fallback for the co-located layout and for loop state
	# written before the field existed.
	goal_folder="$(gg_state_get "$loop_file" "goal_folder")" || goal_folder=""
	if [ -z "$goal_folder" ] || [ ! -d "$goal_folder" ]; then
		goal_folder="$(dirname -- "$gate_dir")"
	fi

	# The run log (T2.6): beside the guarded state directory, inside the goal
	# folder. Initialised BEFORE the evaluation so that every decision below --
	# including the ones that could not run -- lands in the log.
	gg_runlog_init "$goal_folder"
	GG_LOG_ITERATION="$iteration"
	GG_LOG_WORKSTREAM="${GG_WORKSTREAM:-$identity}"
	GG_LOG_AGENT="$agent"
	GG_LOG_SHAPE="$agent"

	# --- a bystander in someone else's tree STANDS DOWN --------------------
	#
	# A live conversation owns a workstream here and this one does not. This
	# turn is not held: the gate governs the OWNER's loop, and this conversation
	# is not in it.
	#
	# THIS REPLACES AN EARLIER REFUSAL, DELIBERATELY AND ON INSTRUCTION. That
	# refusal argued the gate governs the TREE, not the session, because a
	# second session would otherwise be a trivial bypass. Two things overturned
	# it. First, the bypass it feared is narrower than it looked: a bystander
	# cannot write a completion record, cannot mark any criterion met, and
	# cannot touch the owner's state file, so "bypass" here means abandoning the
	# goal unfinished — which is not a false completion, and is exactly what the
	# owner's own still-blocked loop keeps visible. Second, the cost was real
	# and daily: any unrelated conversation in the same checkout was held
	# hostage by a loop it had no part in, including an owner whose session
	# identity changed underneath it, which strands the loop's own driver behind
	# a refusal naming a conversation that no longer exists.
	#
	# WHAT REMAINS ENFORCED, and what the suites pin:
	#   - the OWNER is still gated, on its real criteria, unchanged
	#   - a STALE owner is still RECLAIMED by pass 3, which runs first, so
	#     abandonment is handled by takeover and never by blocking bystanders
	#   - an unowned `.goal-gate/` still REFUSES (a goal nobody is driving)
	#   - standing down writes NO completion record and emits NO permit; it is
	#     not a verdict, it is the absence of one. test-binding.sh §9 pins that
	#     distinction, which the old block-shaped assertion conflated.
	#
	# PLACED AFTER THE D6 BOUND AND AFTER gg_runlog_init, DELIBERATELY — kept
	# from the refusal this replaces. The run log stays live, so the stand-down
	# is recorded like every other decision; sited earlier it emitted nothing,
	# leaving a hole in the decision trail precisely where concurrent-session
	# incidents get diagnosed from.
	# THE STAND-DOWN IS SILENT TO THE USER, DELIBERATELY. It used to emit a
	# gg_user_note naming the owner and suggesting `cancel.sh adopt`. That note
	# fired on EVERY turn of every bystander session in the tree, for the whole
	# life of the goal — a permanent banner on conversations doing unrelated
	# work. It was advisory only (systemMessage, no decision), so dropping it
	# changes no control flow, and it told nobody anything the decision trail
	# does not already carry: `foreign_owner` lands in the loop file and
	# `stood_down_not_owner` lands in the run log, both immediately below.
	# Its one actionable hint — hand the loop over — is only needed to take
	# over BEFORE the liveness window expires; a genuinely dead owner is
	# reclaimed automatically by pass 3 within GOAL_GATE_LIVENESS_WINDOW.
	if [ -n "$GG_FOREIGN_OWNER" ] && [ "$GG_CLAIM_EVENT" = "self" ]; then
		gg_state_set "$loop_file" "foreign_owner" "$GG_FOREIGN_OWNER" || true
		GG_DECISION_LABEL="stood_down_not_owner"
		gg_runlog_emit "$GG_DECISION_LABEL"
		gg_no_claim "a goal loop is running in this tree, owned by conversation $(gg_safe_text "$GG_FOREIGN_OWNER"), and this conversation is not driving it. Standing down: this turn is not held, and nothing about the owner's goal is claimed either way."
	fi


	# Precedence: an explicit host/test override, then the binding written by
	# `pursue-goal` into the loop file, then the folder-layout default.
	acs_file="${GOAL_GATE_ACS-}"
	if [ -z "$acs_file" ]; then
		acs_file="$(gg_state_get "$loop_file" "acs_path")" || acs_file=""
	fi
	if [ -z "$acs_file" ]; then
		acs_file="$goal_folder/ACs.md"
	fi
	case "$acs_file" in
	/*) : ;;
	*) acs_file="$goal_folder/$acs_file" ;;
	esac

	# The blocked signal is read BEFORE the evaluation runs, so that a
	# workstream whose criteria file is itself missing or broken can still be
	# brought to a reported end rather than blocking forever. It is ACTED ON
	# afterwards, so the unmet counts it must preserve have been gathered first.
	local blocked=0 blocked_reason="" blocked_signal="" legacy_note=""
	blocked_signal="$(gg_blocked_signal_path "$gate_dir" "$GG_WORKSTREAM")" || blocked_signal=""
	if [ -n "$blocked_signal" ] && [ -f "$blocked_signal" ]; then
		blocked=1
		if [ ! -r "$blocked_signal" ]; then
			# Reported, never treated as absent: a signal that exists but cannot
			# be read is not evidence that no blocker was declared.
			GG_DECISION_LABEL="blocked_unreadable"
			gg_refuse "cannot verify completion: a blocked signal exists at $(gg_safe_text "$blocked_signal") but could not be read, so whether this run is blocked is UNKNOWN. An unreadable blocker is not the same as no blocker. Fix its permissions, then end the turn again."
		fi
		blocked_reason="$(head -c 4096 -- "$blocked_signal" 2>/dev/null | tr '\n\r' '  ')"
	fi
	# Surfaced on every turn until it is dealt with, and never acted on.
	legacy_note="$(gg_legacy_blocked_note "$gate_dir" "$GG_WORKSTREAM")" && gg_note "$legacy_note"
	if [ "$(gg_state_get "$loop_file" "status")" = "LOOP_BLOCKED" ]; then
		blocked=1
		if [ -z "$blocked_reason" ]; then
			blocked_reason="$(gg_state_get "$loop_file" "blocked_reason" | tr '\n\r' '  ')"
		fi
	fi

	# An absent criteria file is its own refusal rather than a delegate's, so
	# the reason names the path the gate actually looked at. It is recorded the
	# same way as any other failed evaluation — never as a completion.
	if [ ! -e "$acs_file" ]; then
		GG_EVAL_STATE="error"
		GG_EVAL_REASON="cannot verify completion: no acceptance criteria file at $(gg_safe_text "$acs_file"). With no criteria to evaluate, completion cannot be established: absence is NOT 'all complete'."
	else
		gg_evaluate "$acs_file"
	fi

	# The decision trail, recorded whether or not the evaluation concluded, so
	# that every outcome below — including the ones that could not run — is
	# reconstructable from the loop file afterwards (S38/S39).
	gg_state_set "$loop_file" "acs_path" "$acs_file" || true
	gg_state_set "$loop_file" "acs_evaluated_at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || true
	gg_state_set "$loop_file" "acs_verdict" "${GG_EVAL_VERDICT:-<not-run>}" || true
	gg_state_set "$loop_file" "acs_total" "${GG_EVAL_TOTAL:-<not-run>}" || true
	gg_state_set "$loop_file" "acs_checked" "${GG_EVAL_CHECKED:-<not-run>}" || true
	gg_state_set "$loop_file" "acs_unchecked" "${GG_EVAL_UNCHECKED:-<not-run>}" || true
	gg_state_set "$loop_file" "acs_blocked" "${GG_EVAL_BLOCKED:-<not-run>}" || true
	gg_state_set "$loop_file" "acs_ticked_without_evidence" "${GG_EVAL_TWE:-<not-run>}" || true
	gg_state_set "$loop_file" "acs_unticked_with_explanation" "${GG_EVAL_UWE:-<not-run>}" || true
	gg_state_set "$loop_file" "acs_unticked_without_explanation" "${GG_EVAL_UWOE:-<not-run>}" || true
	gg_state_set "$loop_file" "acs_parse_rc" "${GG_EVAL_PARSE_RC:-<not-run>}" || true
	gg_state_set "$loop_file" "acs_validate_rc" "${GG_EVAL_VALIDATE_RC:-<not-run>}" || true
	gg_state_set "$loop_file" "criteria_trail" "${GG_EVAL_TRAIL:-<not-run>}" || true
	gg_state_set "$loop_file" "evaluation_state" "$GG_EVAL_STATE" || true

	# --- LOOP_BLOCKED (R5) ----------------------------------------------
	#
	# Checked BEFORE the permit branch, so a blocked signal can never be
	# combined with a completion claim however the criteria happen to read.
	if [ "$blocked" -eq 1 ]; then
		case "$blocked_reason" in
		*[![:space:]]*) : ;;
		*)
			GG_DECISION_LABEL="blocked_without_reason"
		gg_state_set "$loop_file" "decision" "blocked_without_reason" || true
			gg_refuse "cannot verify completion: a LOOP_BLOCKED signal was raised with no written reason. A blocker must be stated to be honoured, so the signal is refused rather than acted on. The work is not done (${GG_EVAL_UNCHECKED:-<not-run>} of ${GG_EVAL_TOTAL:-<not-run>} criteria outstanding)."
			;;
		esac

		# A reported non-completion. Nothing is marked met, no completion
		# record is written, and the unmet counts stand as they were.
		GG_DECISION_LABEL="loop_blocked"
		gg_state_set "$loop_file" "decision" "loop_blocked" || true
		gg_state_set "$loop_file" "status" "LOOP_BLOCKED" || true
		gg_state_set "$loop_file" "blocked_reason" "$blocked_reason" || true
		gg_state_set "$loop_file" "unmet_at_block" "${GG_EVAL_UNCHECKED:-<not-run>}" || true
		local blocked_label
		blocked_label="$(gg_loop_label "$loop_file")"
		if gg_retire_workstream "$gate_dir" "$identity"; then
			loop_file="$GG_RETIRED_LOOP_FILE"
			# The run log's `workstream` field must name the file this record is
			# ABOUT. It was captured before the evaluation, when the loop was
			# still `_ws-<owner>`, and gg_terminal emits the record below — so
			# without this refresh every terminal entry in the log names a file
			# that no longer exists, and the retired name it does have appears in
			# no record at all.
			GG_LOG_WORKSTREAM="$GG_WORKSTREAM"
		fi
		gg_terminal "LOOP_BLOCKED - the loop ends WITHOUT completion. This is not a pass: no criterion is marked met and no completion record has been written. Reason given: $(gg_safe_text "$blocked_reason"). Outstanding: ${GG_EVAL_UNCHECKED:-<not-run>} of ${GG_EVAL_TOTAL:-<not-run>} acceptance criteria (goal $(gg_safe_text "$blocked_label"), iteration ${iteration})."
	fi

	# --- LOOP_PARTIAL: the remaining work is blocked (T3.1) --------------
	#
	# THE ENDING THIS FEATURE EXISTS FOR. Every criterion is either met and
	# evidenced or explicitly blocked with a stated reason; none is outstanding.
	# Before this branch the loop had no ending for that shape and simply
	# refused every turn until an operator noticed — the reported defect.
	#
	# Placed here deliberately:
	#   * AFTER the whole-loop LOOP_BLOCKED branch, which still outranks it. A
	#     declared blocker is a statement about the run; this is a statement
	#     about what is left in it.
	#   * BEFORE the stall branch, so an all-blocked remainder ends honestly and
	#     immediately rather than waiting out eight idle turns to be killed as
	#     inactive. Reaching a stall for this is a slower, less truthful road to
	#     the same stop.
	#
	# It is a NON-COMPLETION. No criterion is marked met, no completion record
	# is written, and no permit is emitted: the turn is released, and the record
	# says plainly that the goal did not pass.
	if [ "$GG_EVAL_STATE" = "partial" ]; then
		local blocked_named
		blocked_named="$(gg_blocked_criteria_text "$acs_file")" ||
			blocked_named="(the criteria file could not be read to name them)"

		GG_DECISION_LABEL="loop_partial"
		# Into the run log too, not only the state file: "what was blocked, and
		# why" has to be answerable from the log after the loop is gone. Capped
		# at the field rather than left to the record cap, which would truncate
		# the whole entry to a minimal one and drop exactly these reasons.
		GG_LOG_BLOCKED_NAMED="$blocked_named"
		gg_state_set "$loop_file" "decision" "loop_partial" || true
		gg_state_set "$loop_file" "blocked_criteria" "$blocked_named" || true
		gg_state_set "$loop_file" "unmet_at_partial" "${GG_EVAL_BLOCKED:-<not-run>}" || true

		# As on every other terminal path: `status` is what RETIRES the
		# workstream. A partial that cannot be recorded would re-trip this same
		# branch every turn, so it is refused rather than announced — exactly as
		# the `complete` and `stalled` paths already do.
		if ! gg_state_set "$loop_file" "status" "LOOP_PARTIAL"; then
			GG_DECISION_LABEL="refused_unrecordable"
			gg_refuse "the remaining acceptance criteria are all blocked, but the LOOP_PARTIAL status could not be written to $(gg_safe_text "$loop_file"), so the ending cannot be recorded and would re-trip every turn. A partial ending that cannot be recorded is not accepted. Fix the state directory, then cancel the loop deliberately."
		fi

		local partial_label
		partial_label="$(gg_loop_label "$loop_file")"
		if gg_retire_workstream "$gate_dir" "$identity"; then
			loop_file="$GG_RETIRED_LOOP_FILE"
			GG_LOG_WORKSTREAM="$GG_WORKSTREAM"
		fi
		gg_terminal "LOOP_PARTIAL - the loop ends WITHOUT completion. This is NOT a pass: ${GG_EVAL_BLOCKED} of ${GG_EVAL_TOTAL} acceptance criteria are BLOCKED and remain unmet, no completion record has been written, and no criterion has been marked met on their account. Met and evidenced: ${GG_EVAL_CHECKED} of ${GG_EVAL_TOTAL}. Blocked: $(gg_safe_text "$blocked_named") (goal $(gg_safe_text "$partial_label"), iteration ${iteration})."
	fi

	# --- stall accounting (T2.4) -----------------------------------------
	#
	# Runs only on the NOT-met path. A met checklist goes straight to the permit
	# below however many turns it took to get there: stall accounting exists to
	# end a loop going nowhere, and intercepting a finished one would be a
	# spurious stall on the single path where the work is actually done.
	#
	# It sits AFTER the LOOP_BLOCKED branch above, which is terminal in its own
	# right. Both outcomes end the loop, so the risk is not a wrong decision but
	# a wrong REPORT — a declared blocker names a cause repetition cannot infer,
	# and it would be lost to a generic stall message.
	#
	# The sanctioned wait (T2.5) is evaluated FIRST, because an active one
	# suspends the accounting below. It is evaluated on the not-met path only:
	# a met checklist permits regardless, since the criteria decide completion
	# and the wait only ever decides whether standing still is allowed.
	if [ "$GG_EVAL_STATE" != "met" ]; then
		gg_wait_evaluate "$gate_dir" "$loop_file"
		gg_state_set "$loop_file" "wait_state" "$GG_WAIT_STATE" || true
		gg_state_set "$loop_file" "wait_deadline" "$GG_WAIT_DEADLINE" || true
		if [ -n "$GG_WAIT_NOTE" ]; then
			gg_state_set "$loop_file" "wait_note" "$GG_WAIT_NOTE" || true
			gg_note "wait (${GG_WAIT_STATE}): ${GG_WAIT_NOTE}"
		fi
	fi

	if [ "$GG_EVAL_STATE" != "met" ] && [ "$GG_WAIT_STATE" != "active" ]; then
		local stall_max="${GOAL_GATE_STALL_MAX:-$GG_STALL_MAX_DEFAULT}"
		# A garbage, zero or negative threshold falls back to the documented
		# default. The ancestor stripped non-digits and mangled bad input into
		# a plausible number; a threshold that silently became 0 would stall
		# every loop on its first turn.
		case "$stall_max" in
		'' | *[!0-9]*) stall_max="$GG_STALL_MAX_DEFAULT" ;;
		0) stall_max="$GG_STALL_MAX_DEFAULT" ;;
		esac

		# What "the same outcome" means: the per-criterion trail, the counts, the
		# evaluation's own state, AND the state of the repository. The trail
		# changes when a criterion is ticked or evidenced; the state changes when
		# a broken evaluation starts working; the repository fingerprint changes
		# when the agent does any work at all, which is what stops a loop being
		# killed for spending several turns on one large criterion.
		local stall_input stall_hash="" stall_progress=""
		stall_progress="$(gg_repo_progress "$goal_folder")" || stall_progress=""
		stall_input="progress=${stall_progress}
state=${GG_EVAL_STATE}
verdict=${GG_EVAL_VERDICT}
total=${GG_EVAL_TOTAL}
checked=${GG_EVAL_CHECKED}
unchecked=${GG_EVAL_UNCHECKED}
twe=${GG_EVAL_TWE}
uwe=${GG_EVAL_UWE}
uwoe=${GG_EVAL_UWOE}
reason=${GG_EVAL_REASON}
${GG_EVAL_TRAIL}"

		if ! stall_hash="$(printf '%s' "$stall_input" | gg_stall_hash)"; then
			# D8, refused rather than reproduced. No hash means the loop cannot
			# be measured, and an unmeasurable loop is never terminated on a
			# guess — the gate keeps blocking, which is the safe direction.
			GG_DECISION_LABEL="refused_unhashable"
		gg_state_set "$loop_file" "decision" "refused_unhashable" || true
			gg_refuse "cannot verify completion: no working hash tool is available (tried ${GOAL_GATE_HASH_TOOL:-shasum, sha256sum}), so progress cannot be measured and a stall cannot be told apart from steady work. The gate refuses rather than end a loop it cannot measure. Outstanding: ${GG_EVAL_UNCHECKED:-<not-run>} of ${GG_EVAL_TOTAL:-<not-run>} acceptance criteria."
		fi

		local prev_hash prev_count prev_raw prev_period old_token
		local stall_raw_count=1 stall_period_raw_count=1 stall_count=1 guard_hash=""
		local recovery_token="" recovery_credit=0 recovery_credit_applied=0 append_window=1
		prev_hash="$(gg_state_get "$loop_file" "stall_hash")" || prev_hash=""
		prev_count="$(gg_state_get "$loop_file" "stall_count")" || prev_count=""
		prev_raw="$(gg_state_get "$loop_file" "stall_raw_count")" || prev_raw=""
		prev_period="$(gg_state_get "$loop_file" "stall_period_raw_count")" || prev_period=""
		old_token="$(gg_state_get "$loop_file" "recovery_token")" || old_token=""
		guard_hash="$(gg_recovery_guard_hash "$goal_folder" "$acs_file")" || guard_hash=""

		# Raw history is lifetime-monotonic. The period counter restarts only the
		# threshold calculation after measurable progress.
		case "$prev_raw" in
		'' | *[!0-9]*)
			if [ -n "$prev_hash" ]; then
				stall_raw_count="$(gg_count_increment "$prev_count" 2)"
			fi
			;;
		*) stall_raw_count="$(gg_count_increment "$prev_raw" 1)" ;;
		esac

		# An EMPTY previous hash never matches. Without this an emptied or
		# truncated state file would manufacture a stall out of nothing — D8
		# arriving through the state file instead of through the tool.
		if [ -n "$prev_hash" ] && [ "$prev_hash" = "$stall_hash" ]; then
			case "$prev_period" in
			'' | *[!0-9]*)
				stall_period_raw_count="$(gg_count_increment "$prev_count" 2)"
				;;
			*) stall_period_raw_count="$(gg_count_increment "$prev_period" 2)" ;;
			esac

			recovery_token="$old_token"
			if [ "$GG_CODEX_RECOVERY_ELIGIBLE" -eq 1 ] && \
				gg_valid_recovery_token "$recovery_token" && \
				[ "$(gg_state_get "$loop_file" recovery_hash)" = "$stall_hash" ] && \
				[ "$(gg_state_get "$loop_file" recovery_owner)" = "$identity" ] && \
				[ -n "$(gg_state_get "$loop_file" recovery_turn_id)" ] && \
				[ -n "$guard_hash" ] && \
				[ "$(gg_state_get "$loop_file" recovery_guard_hash)" = "$guard_hash" ]; then
				if [ -d "$gate_dir/.recovery-ack.$recovery_token" ] && \
					[ -n "$(gg_state_get "$loop_file" recovery_ack_at)" ]; then
					recovery_credit=1
					if [ "$(gg_state_get "$loop_file" recovery_credit_applied)" != "1" ]; then
						append_window=0
						recovery_credit_applied=1
					else
						recovery_credit_applied=1
					fi
				elif [ -d "$gate_dir/.recovery-ack.$recovery_token" ]; then
					# A marker without the sanctioned command's state record is not
					# an acknowledgment. Remove only this exact empty capability dir.
					gg_recovery_remove_marker "$gate_dir" "$recovery_token"
				fi
				gg_recovery_command_if_unused "$gate_dir" "$recovery_token" "$goal_folder"
			elif [ "$GG_CODEX_RECOVERY_ELIGIBLE" -eq 1 ]; then
				# A reclaimed loop or a partial state write must not strand the new
				# owner without a capability for the current progress state.
				gg_recovery_clear "$loop_file" "$gate_dir" "$old_token"
				if [ -n "$guard_hash" ] && ! gg_recovery_issue "$loop_file" "$identity" \
					"$GG_TURN_ID" "$stall_hash" "$stall_raw_count" "$goal_folder" "$guard_hash"; then
					recovery_token="$(gg_state_get "$loop_file" recovery_token)" || recovery_token=""
					gg_recovery_clear "$loop_file" "$gate_dir" "$recovery_token"
				fi
			fi
		else
			gg_recovery_clear "$loop_file" "$gate_dir" "$old_token"
			if [ "$GG_CODEX_RECOVERY_ELIGIBLE" -eq 1 ] && [ -n "$guard_hash" ]; then
				if ! gg_recovery_issue "$loop_file" "$identity" "$GG_TURN_ID" \
					"$stall_hash" "$stall_raw_count" "$goal_folder" "$guard_hash"; then
					recovery_token="$(gg_state_get "$loop_file" recovery_token)" || recovery_token=""
					gg_recovery_clear "$loop_file" "$gate_dir" "$recovery_token"
				fi
			fi
		fi

		stall_count=$((stall_period_raw_count - recovery_credit))
		[ "$stall_count" -ge 1 ] || stall_count=1

		# The bounded window, newest last. Capped so a long-running loop cannot
		# grow the state file without limit.
		local window window_len window_max
		window_max=$((stall_max * 2))
		[ "$window_max" -le "$GG_STALL_WINDOW_CAP" ] || window_max="$GG_STALL_WINDOW_CAP"
		window="$(gg_state_get "$loop_file" "stall_window")" || window=""
		if [ "$append_window" -eq 1 ]; then
			if [ -n "$window" ]; then
				window="${window}
${stall_hash}"
			else
				window="$stall_hash"
			fi
		fi
		window="$(printf '%s\n' "$window" | sed '/^$/d' | tail -n "$window_max")"
		window_len="$(printf '%s\n' "$window" | sed '/^$/d' | wc -l | tr -d ' ')"

		gg_state_set "$loop_file" "stall_hash" "$stall_hash" || true
		gg_state_set "$loop_file" "stall_raw_count" "$stall_raw_count" || true
		gg_state_set "$loop_file" "stall_period_raw_count" "$stall_period_raw_count" || true
		gg_state_set "$loop_file" "stall_count" "$stall_count" || true
		gg_state_set "$loop_file" "recovery_credits" "$recovery_credit" || true
		gg_state_set "$loop_file" "recovery_credit_applied" "$recovery_credit_applied" || true
		GG_LOG_STALL_COUNT="$stall_count"
		gg_state_set "$loop_file" "stall_window" "$window" || true
		gg_state_set "$loop_file" "stall_max" "$stall_max" || true

		# The loop ENDS at twice the threshold; the threshold itself only warns.
		local stall_kill=$((stall_max * 2))
		if [ "$stall_count" -ge "$stall_kill" ]; then
			gg_stall_terminal "$loop_file" "repeat" "$stall_count" "$stall_max" \
				"$acs_file" "$identity" "$iteration"
		fi

		# --- the warning ---------------------------------------------------
		#
		# Still a refusal, so the loop keeps running — but the reason the model
		# reads names the repetition rather than restating the criteria counts,
		# and the operator is told too. Recorded once so the run log shows when
		# the escalation began, while the warning itself repeats every turn: it
		# is the model's only prompt to change approach, and delivering it once
		# and then falling silent for the remaining turns would waste them.
		if [ "$stall_count" -ge "$stall_max" ]; then
			[ -n "$(gg_state_get "$loop_file" "stall_warned_at")" ] ||
				gg_state_set "$loop_file" "stall_warned_at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || true
			GG_DECISION_LABEL="refused_stall_warning"
			gg_state_set "$loop_file" "decision" "refused_stall_warning" || true
			GG_USER_MESSAGE="no measurable progress for ${stall_count} turns (no criterion ticked or evidenced, and nothing committed or edited). The loop ends automatically at ${stall_kill}. Run 'cancel.sh status' to inspect it. If needless turn endings consumed the counter, an explicitly authorised 'cancel.sh reset-stall' resets accounting only; it never marks work done."
			gg_refuse "completion is not established, AND this loop is not advancing: the last ${stall_count} evaluations reached an identical outcome and the repository has not changed with them, against a warning threshold of ${stall_max} and an automatic end at ${stall_kill}. Repeating the same approach will not clear it. Either change approach on the outstanding criteria - ${GG_EVAL_UNCHECKED:-<not-run>} of ${GG_EVAL_TOTAL:-<not-run>} remain, $(gg_stall_unmet_breakdown) - or, if something outside this loop is genuinely blocking it, declare that: write the reason into ${gate_dir}/${GG_WORKSTREAM}.LOOP_BLOCKED to end the run as a reported non-completion (the file is keyed to this workstream, so it ends THIS loop and no other), or a deadline in epoch seconds into ${gate_dir}/WAIT if you are waiting on an external result. If excess turn endings, rather than real inactivity, consumed the active loop's counter, inspect it with cancel.sh status and reset it only on explicit user direction: cancel.sh reset-stall clears accounting only and never marks criteria done. Still to do: $(gg_safe_text "$(gg_stall_criteria_text "$acs_file" || printf 'the criteria file could not be read to name them')")."
		fi

		# The flap rule, applied only once the window is FULL — a young window
		# holding two states is an ordinary loop that has taken two turns.
		if [ "$window_len" -ge "$window_max" ] &&
			[ "$(gg_stall_distinct "$window")" -le 2 ]; then
			gg_stall_terminal "$loop_file" "flap" "$window_len" "$stall_max" \
				"$acs_file" "$identity" "$iteration"
		fi
	fi

	# --- refuse ----------------------------------------------------------
	if [ "$GG_EVAL_STATE" != "met" ]; then
		if [ "$GG_EVAL_STATE" = "unmet" ]; then
			GG_DECISION_LABEL="refused_unmet"
		gg_state_set "$loop_file" "decision" "refused_unmet" || true
		else
			GG_DECISION_LABEL="refused_not_run"
		gg_state_set "$loop_file" "decision" "refused_not_run" || true
		fi
		gg_refuse "${GG_EVAL_REASON:-cannot verify completion: the acceptance evaluation produced no result, so it is reported as not-run.}"
	fi

	# --- permit ----------------------------------------------------------
	#
	# The only path to here: both delegated evaluations RAN, agreed, and
	# reported every criterion met AND evidenced.
	local record="$gate_dir/completion-record.md"
	if ! gg_write_completion_record "$record" "$acs_file" "$identity" "$agent" "$iteration"; then
		# Completion that cannot be recorded is not completion. Refusing here
		# costs an iteration; permitting would leave a claim with no trail.
		GG_DECISION_LABEL="refused_unrecordable"
		gg_state_set "$loop_file" "decision" "refused_unrecordable" || true
		gg_refuse "cannot verify completion: every acceptance criterion is met and evidenced, but the completion record could not be written to $(gg_safe_text "$record"). A completion that cannot be recorded is not accepted."
	fi

	GG_DECISION_LABEL="permitted"
	gg_state_set "$loop_file" "decision" "permitted" || true

	# `status=complete` is what ENDS this workstream — every resolution pass
	# skips a terminal status — so this single write is the difference between a
	# finished loop and one that re-evaluates itself on every turn for the rest
	# of the session. It is therefore not best-effort: a completion whose ending
	# cannot be recorded is refused for the same reason a completion whose record
	# cannot be written is refused.
	if ! gg_state_set "$loop_file" "status" "complete"; then
		GG_DECISION_LABEL="refused_unrecordable"
		gg_refuse "cannot verify completion: every acceptance criterion is met and evidenced, but the completed status could not be written to $(gg_safe_text "$loop_file"), so the loop cannot be retired and would keep re-evaluating itself. A completion that cannot be recorded is not accepted."
	fi
	gg_state_set "$loop_file" "completion_record" "$record" || true

	# ...and the RENAME is what takes it out of the adoptable pool, so that no
	# other conversation can ever see it as work to pick up. Ordered after every
	# state write above, because the write path is `mktemp` + `mv -f` and a write
	# racing the rename would re-create the old name from its temporary file.
	#
	# BEST-EFFORT, AND DELIBERATELY SO: a rename that cannot complete must not
	# withdraw a permit that has already been established, recorded and written.
	# The status alone still keeps the loop out of every resolution pass; the
	# name is belt to the status's braces.
	local permit_label
	permit_label="$(gg_loop_label "$loop_file")"
	if gg_retire_workstream "$gate_dir" "$identity"; then
		loop_file="$GG_RETIRED_LOOP_FILE"
		GG_LOG_WORKSTREAM="$GG_WORKSTREAM"
	fi
	gg_permit "all ${GG_EVAL_TOTAL} acceptance criteria are met and evidenced (goal $(gg_safe_text "$permit_label"), agent ${agent}, iteration ${iteration}). Completion record: $(gg_safe_text "$record")."
}

# Only run when executed, not when sourced by the test suite. `set -e` is scoped
# to execution so that sourcing this file never changes the caller's shell mode.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -uo pipefail
	gg_main "$@"
	exit $?
fi
