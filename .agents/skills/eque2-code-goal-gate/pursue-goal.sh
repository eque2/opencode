#!/usr/bin/env bash
# pursue-goal.sh — the loop STARTER. The mechanical half of the `pursue-goal`
# skill: everything that must be exact rather than interpreted.
#
# Contract: {skills-root}/eque2-code-prepare-goal/references/goal-folder.md
#
# Usage:
#   pursue-goal.sh <prepared-goal-folder>
#   pursue-goal.sh --help
#
# THE DIVISION OF RESPONSIBILITY, ONCE. `pursue-goal` starts the loop; the gate
# is PASSIVE. The gate runs on every turn end and does nothing unless it finds
# loop state to claim. So this script writes an UNCLAIMED workstream file named
# `_anon-<token>.state` into the gate directory and then STOPS, so the next
# turn-end fires the gate, which claims that file and begins blocking. Doing
# further work here before the gate has claimed it leaves the loop unbound —
# the predecessor's documented failure mode.
#
# THE FILE IS RENAMED AFTERWARDS, BY THE GATE, NEVER BY THIS SCRIPT. On the turn
# it is claimed it becomes `_ws-<owner>.state`, and on the turn it reaches a
# terminal status it becomes `_ended-<owner>-<token>.state` — which is what
# stops a finished loop sitting in the adoptable pool looking live. This script
# writes the unclaimed name and only the unclaimed name: being born unclaimed IS
# the handshake, and a file born under either later name would be naming an
# owner that does not exist yet.
#
# WRITING STATE IS NOT STARTING A LOOP. A written state file that no registered
# gate will ever read is a run that looks like the mechanism and has none. So
# registration is verified BEFORE any state is written, and a failure to verify
# it is a refusal, not a warning.
#
# EVERY REFUSAL WRITES NOTHING. There is no path on which this script reports a
# problem and still leaves loop state behind: the state file is the LAST thing
# written, after every check has passed.
#
# Exit codes:
#   0   loop state written; end the one bootstrap turn so the gate can claim it
#   2   invalid input (empty, missing, not a prepared goal folder)
#   3   the folder or a required artefact could not be read
#   4   nothing to do — every criterion is already met and evidenced
#   5   filesystem failure (gate directory not creatable or not writable)
#   6   the gate is NOT registered for the running agent — refused
#   7   a loop is already active for this folder
#   64  usage error
#
# Environment overrides (tests use them):
#   GOAL_GATE_AGENT    force the running agent (claude|codex)
#   GOAL_GATE_ANCHOR   force the gate-directory anchor, skipping the git/cwd walk
#   GOAL_GATE_SKIP_REGISTRATION_CHECK
#                      set to 1 ONLY in fixtures that have no host config

PG_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

PG_PARSE_ACS="${GOAL_GATE_PARSE_ACS:-$PG_SELF_DIR/parse-acs.sh}"
PG_LOOP_STATE="${GOAL_GATE_LOOP_STATE:-$PG_SELF_DIR/loop-state.sh}"
PG_INSTALL="${GOAL_GATE_INSTALL:-$PG_SELF_DIR/install.sh}"
PG_FOLDER_PATH="${GOAL_GATE_FOLDER_PATH:-$PG_SELF_DIR/goal-folder-path.sh}"
PG_MIRROR="${GOAL_GATE_MIRROR_SPEC:-$PG_SELF_DIR/mirror-spec.sh}"

PG_MARKER="${GOAL_GATE_MARKER:-.goal-gate}"

pg_die() {
	local code="$1"
	shift
	printf 'pursue-goal: %s\n' "$*" >&2
	return "$code"
}

pg_note() {
	printf 'pursue-goal: %s\n' "$*" >&2
}

# --- the running agent ------------------------------------------------------
#
# Detected from the environment, because this runs inside a skill and not from
# a hook payload — there is no `session_id`/`turn_id` to read. An agent that
# cannot be identified is NOT assumed to be either one: it falls through to the
# strict registration rule below.
pg_detect_agent() {
	if [ -n "${GOAL_GATE_AGENT-}" ]; then
		printf '%s' "$GOAL_GATE_AGENT"
		return 0
	fi
	if [ -n "${CLAUDECODE-}" ] || [ -n "${CLAUDE_CODE_ENTRYPOINT-}" ]; then
		printf 'claude'
		return 0
	fi
	if [ -n "${CODEX_HOME-}" ] || [ -n "${CODEX_SANDBOX-}" ] || [ "${AI_AGENT-}" = "codex" ]; then
		printf 'codex'
		return 0
	fi
	printf 'unknown'
}

# pg_project_registration <agent> <anchor> — 0 when this working tree registers
# the gate for itself, FOR THAT AGENT.
#
# Found live while proving the gate fires (T3.4): a registration may be
# PROJECT-scoped, and `doctor` only ever inspects user-global configuration. A
# project-scoped gate is a completely valid installation — it is how the live
# test registers it — so treating it as "not registered" would refuse a run the
# gate would in fact have governed. The command must still be executable; a
# project registration pointing at a missing script is as inert as a global one.
# AGENT-BLIND WAS A FAIL-OPEN (review finding). This used to inspect
# `.claude/settings.json` whatever agent was running, and pg_registration_ok
# consulted it FIRST — so under Codex, a repo carrying a Claude project hook and
# no Codex registration at all satisfied the check, loop state was written, the
# agent yielded, and nothing ever fired. That is precisely the "drives the folder
# to completion with nothing checking it" outcome the refusal exists to prevent.
# Codex also discovers `.codex/hooks.json` from the project configuration
# layer. In a linked worktree it uses the file from the main checkout, so an
# inert worktree-local file is ignored here too. The function prints the exact
# registered executable.
pg_direct_command_path() {
	command -v python3 >/dev/null 2>&1 || return 1
	# shellcheck disable=SC2016 # The single-quoted text is a Python program.
	python3 -c 'import base64, binascii, os, shlex, sys
try:
    command = base64.b64decode(sys.argv[1], validate=True).decode("utf-8")
except (binascii.Error, UnicodeDecodeError):
    raise SystemExit(1)
if "\n" in command or "\0" in command:
    raise SystemExit(1)
anchor, home, agent = sys.argv[2], sys.argv[3], sys.argv[4]
try:
    words = shlex.split(command, posix=True)
except ValueError:
    raise SystemExit(1)
if len(words) != 1:
    raise SystemExit(1)
word = words[0]
if agent == "claude":
    for token, value in (("${CLAUDE_PROJECT_DIR}", anchor),
                         ("$CLAUDE_PROJECT_DIR", anchor),
                         ("${HOME}", home), ("$HOME", home)):
        if word == token or word.startswith(token + "/"):
            word = value + word[len(token):]
            break
        if token in word:
            raise SystemExit(1)
    if "$" in word:
        raise SystemExit(1)
if not os.path.isabs(word) or "\n" in word or "\0" in word:
    raise SystemExit(1)
sys.stdout.write(word)' "$1" "$2" "$HOME" "$3" 2>/dev/null
}

pg_project_registration() {
	local agent="${1-}" anchor="${2-}" f encoded real cmds primary_root=""
	local found="" found_count=0
	[ -n "$anchor" ] || return 1

	case "$agent" in
	claude)
		set -- "$anchor/.claude/settings.json" "$anchor/.claude/settings.local.json"
		;;
	codex)
		primary_root="$(git -C "$anchor" worktree list --porcelain 2>/dev/null |
			sed -n 's/^worktree //p' | head -1)" || primary_root=""
		case "$primary_root" in
		/*) [ -d "$primary_root" ] || primary_root="" ;;
		*) primary_root="" ;;
		esac
		# A .git FILE identifies a linked checkout or a submodule. Falling
		# back to its local hook file can approve a source Codex ignores.
		if [ -f "$anchor/.git" ] && [ -z "$primary_root" ]; then
			return 1
		fi
		[ -n "$primary_root" ] || primary_root="$anchor"
		set -- "$primary_root/.codex/hooks.json"
		;;
	*) return 1 ;;
	esac

	for f in "$@"; do
		[ -f "$f" ] || continue
		# Reject a file the host cannot load. Do not accept a valid-looking
		# command emitted before jq reaches a malformed later entry.
		jq -e '
			type == "object" and
			((has("hooks") | not) or (.hooks | type == "object")) and
			((.hooks // {}) | all(.[];
				type == "array" and all(.[];
					type == "object" and
					((has("matcher") | not) or (.matcher | type == "string")) and
					(.hooks | type == "array") and all(.hooks[];
						type == "object" and (.type | type == "string") and
						(if .type == "command" then
							(.command | type == "string") and (.command | length > 0) and
							((has("timeout") | not) or
							 ((.timeout | type == "number") and .timeout > 0))
						 else true end)
					)
				)
			))' "$f" >/dev/null 2>&1 || continue
		# Use one encoded record per command. A literal newline inside a JSON
		# string must not become a second shell-loop record.
		cmds="$(jq -r '
			.hooks.Stop[]? |
			select(.matcher == "*") |
			.hooks[]? |
			select(.type == "command" and .timeout == 120 and
			       (.command | type == "string") and
			       ((keys_unsorted - ["type", "command", "timeout"]) | length == 0)) |
			.command | @base64' "$f" 2>/dev/null)" || continue
		[ -n "$cmds" ] || continue
		while IFS= read -r encoded; do
			[ -n "$encoded" ] || continue
			# Registrations use host variables in portable Claude project files.
			# Decode and expand them before the executable check.
			real="$(pg_direct_command_path "$encoded" "$anchor" "$agent")" || continue
			[ "$(basename -- "$real")" = "goal-gate-stop.sh" ] || continue
			# Only the normalized direct gate command is valid. A wrapper that
			# mentions the gate belongs to another hook owner.
			if [ -x "$real" ]; then
				found="$real"
				found_count=$((found_count + 1))
			fi
		done <<EOF
$cmds
EOF
	done
	[ "$found_count" -eq 1 ] || return 1
	printf '%s\n' "$found"
	return 0
}

# pg_require_mirrored_spec <folder> — the workstream's documents live in the
# workstream's folder.
#
# goal-folder.md §2: "No artefact produced for the workstream may be written
# outside `X.goal/`, with the single named exception in §5." §5 is the SPEC —
# the create-spec pipeline owns its own output path, so prepare-goal MIRRORS the
# result into `X.goal/spec/` with `MANIFEST.md` recording where it came from.
#
# That mirror was instructed in prose and enforced by nothing, so a run could
# invoke the spec pipeline, leave `spec.md` sitting in the pipeline's output
# directory, and finish with a goal folder that was not self-contained. Observed
# in the field. Prose an agent can skip is not a contract.
#
# WHAT IS REFUSED vs REPORTED, and why they differ:
#   - a mirror that does not verify (drift, or its source has gone) -> REFUSED.
#     The folder claims a provenance that is not true.
#   - `spec/` with no MANIFEST -> REFUSED. A mirror with no provenance is
#     indistinguishable from files someone dropped in by hand.
#   - NEITHER present -> REPORTED, not refused. "No spec was ever produced" and
#     "a spec was produced and not mirrored" are not distinguishable from here,
#     and refusing would break every goal folder prepared before this check
#     existed. Loud is the honest answer; fatal would be a guess.
pg_require_mirrored_spec() {
	local folder="$1" rc=0
	local manifest="$folder/MANIFEST.md"
	local spec="$folder/spec"

	if [ ! -e "$manifest" ] && [ ! -e "$spec" ]; then
		pg_note "this folder carries no spec/ and no MANIFEST.md. If a spec was produced for this workstream it belongs IN the folder — mirror it with 'mirror-spec.sh mirror $folder <pipeline-dir>' so the folder is self-contained."
		return 0
	fi

	if [ ! -f "$manifest" ]; then
		pg_die 2 "$folder has spec/ but no MANIFEST.md, so nothing records where those artefacts came from. A mirror without provenance is not a mirror. Re-run: mirror-spec.sh mirror $folder <pipeline-dir>" || return
	fi

	if [ ! -r "$PG_MIRROR" ]; then
		pg_note "cannot verify the SPEC mirror: $PG_MIRROR is not readable. Proceeding, but the folder's self-containment is UNVERIFIED."
		return 0
	fi

	bash "$PG_MIRROR" verify "$folder" >/dev/null 2>&1 || rc=$?
	case "$rc" in
	0) return 0 ;;
	3) pg_die 2 "the SPEC mirror in $folder cannot be verified: its canonical source no longer exists. The folder records a provenance that is gone. Re-mirror from the current pipeline directory." || return ;;
	4) pg_die 2 "the SPEC mirror in $folder has DRIFTED from its canonical source. The folder's spec/ and the pipeline no longer agree, so the workstream's own documents are not trustworthy. Re-run mirror-spec.sh mirror." || return ;;
	*) pg_die 2 "the SPEC mirror in $folder failed verification (mirror-spec exit $rc). Run 'mirror-spec.sh verify $folder' to see why." || return ;;
	esac
}

# pg_registration_ok <agent> [anchor] — 0 when the gate is registered AND runnable.
#
# `doctor` is the check, not a bare grep for the file: a registration whose
# command is missing or non-executable is present in config and completely
# inert, which is precisely the state this refusal exists to catch.
#
# Codex never reaches this check: see the Codex branch in pg_main.
pg_registration_ok() {
	local agent="$1"

	# A project-scoped registration governs this tree regardless of what the
	# user-global configuration says — but only for the agent that reads it.
	[ -n "$(pg_project_registration "$agent" "${2-}")" ] && return 0

	if [ "$agent" = "unknown" ]; then
		# An unidentified host is not a licence to guess. Both agents must be
		# registered before we will start a loop we cannot attribute.
		bash "$PG_INSTALL" doctor claude >/dev/null 2>&1 &&
			bash "$PG_INSTALL" doctor codex >/dev/null 2>&1
		return
	fi

	bash "$PG_INSTALL" doctor "$agent" >/dev/null 2>&1
}

# --- resolving the folder from whatever the caller typed --------------------
#
# Four forms reach this script in practice and all four name the same
# workstream, so all four resolve rather than fail: the folder, the folder with
# a trailing slash, a relative path, `X.goal/goal.md`, and the idea document
# `X.md`. Resolving them is the handling; guessing a DIFFERENT workstream would
# not be.
pg_resolve_folder() {
	local arg="${1-}" folder base

	if [ -z "$arg" ]; then
		pg_die 2 "no goal folder given. Usage: pursue-goal.sh <prepared-goal-folder>" || return
	fi

	# Trailing slashes, but never reduce a bare `/` to the empty string.
	while [ "${#arg}" -gt 1 ] && [ "${arg%/}" != "$arg" ]; do
		arg="${arg%/}"
	done

	if [ -d "$arg" ]; then
		folder="$arg"
	elif [ -f "$arg" ]; then
		base="$(basename -- "$arg")"
		if [ "$base" = "goal.md" ] || [ "$base" = "ACs.md" ]; then
			folder="$(dirname -- "$arg")"
		else
			# An idea document: derive its sibling folder by the normative rule
			# rather than by string surgery here.
			folder="$(bash "$PG_FOLDER_PATH" -- "$arg" 2>/dev/null)" || {
				pg_die 2 "not a prepared goal folder, and not an idea document this could derive one from: $arg" || return
			}
			if [ ! -d "$folder" ]; then
				pg_die 2 "no prepared goal folder for that idea document — expected $folder. Run prepare-goal first." || return
			fi
		fi
	elif [ -e "$arg" ]; then
		pg_die 2 "not a directory or a regular file: $arg" || return
	else
		pg_die 2 "no such path: $arg" || return
	fi

	if [ ! -r "$folder" ] || [ ! -x "$folder" ]; then
		pg_die 3 "goal folder cannot be read: $folder" || return
	fi

	# Physical resolution: the recorded binding must survive a symlinked or
	# relative invocation unchanged.
	if ! folder="$(cd -- "$folder" 2>/dev/null && pwd -P)"; then
		pg_die 3 "goal folder cannot be entered: $folder" || return
	fi

	printf '%s' "$folder"
}

# pg_require_artefact <folder> <name> — present, regular, readable, non-empty.
pg_require_artefact() {
	local folder="$1" name="$2" path="$1/$2"

	if [ ! -e "$path" ]; then
		pg_die 2 "$folder is not a prepared goal folder: $name is missing. Run prepare-goal on the idea document first." || return
	fi
	if [ -d "$path" ] || [ ! -f "$path" ]; then
		pg_die 2 "$name is not a regular file: $path" || return
	fi
	if [ ! -r "$path" ]; then
		pg_die 3 "$name cannot be read: $path" || return
	fi
	if [ ! -s "$path" ]; then
		pg_die 2 "$name is empty: $path. An empty acceptance contract is refused, not treated as satisfied." || return
	fi
}

# --- the gate-directory anchor ----------------------------------------------
#
# THE ONE PLACEMENT FACT WORTH KNOWING. The gate finds its directory by walking
# UP from the session's working directory. So the gate directory has to sit on
# an ANCESTOR of where the work happens — a `.goal-gate` inside the goal folder
# is never found when the session runs from the repository root, which is where
# the work actually happens.
#
# The anchor is therefore the repository root (or the working directory when
# there is no repository), and the loop file carries the goal folder as an
# absolute `goal_folder` binding.
pg_anchor() {
	if [ -n "${GOAL_GATE_ANCHOR-}" ]; then
		(cd -- "$GOAL_GATE_ANCHOR" 2>/dev/null && pwd -P) || return 1
		return 0
	fi
	git rev-parse --show-toplevel 2>/dev/null && return 0
	pwd -P
}

# The statuses that mean a loop is HISTORY rather than a competitor. The same
# list lives in cancel.sh as GG_TERMINAL_STATUSES and the two MUST agree — they
# did not, and the disagreement let `cancel` end a dead workstream while the
# live one kept blocking.

# LOOP_PARTIAL was added with the blocked-criteria state: a loop whose remaining
# work is all blocked ends as a reported non-completion. It is HISTORY, exactly
# as the other five are — omitting it here would let a partially-ended loop read
# as a live competitor.
PG_TERMINAL_STATUSES="complete cancelled stalled recursion_bound_exceeded LOOP_BLOCKED LOOP_PARTIAL"

# pg_active_loop <gate-dir> — prints the path of an already-active loop file.
pg_active_loop() {
	local gate_dir="$1" f status
	for f in "$gate_dir"/*.state; do
		[ -f "$f" ] || continue
		status="$(bash "$PG_LOOP_STATE" get "$f" status 2>/dev/null)" || status=""
		case " $PG_TERMINAL_STATUSES " in
		*" $status "*) continue ;;
		esac
		printf '%s' "$f"
		return 0
	done
	return 1
}

pg_token() {
	local t=""
	t="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom 2>/dev/null | dd bs=1 count=16 2>/dev/null)"
	if [ -z "$t" ]; then
		t="$$-$(date -u '+%Y%m%d%H%M%S' 2>/dev/null)"
	fi
	printf '%s' "$t"
}

pg_main() {
	local arg="${1-}"

	case "$arg" in
	-h | --help)
		sed -n '2,42p' "$0"
		return 0
		;;
	esac

	if [ "$#" -gt 1 ]; then
		pg_die 64 "usage: pursue-goal.sh <prepared-goal-folder>" || return
	fi

	local folder
	folder="$(pg_resolve_folder "$arg")" || return

	pg_require_artefact "$folder" "goal.md" || return
	pg_require_artefact "$folder" "ACs.md" || return
	pg_require_mirrored_spec "$folder" || return

	# --- the acceptance contract, read through the one source of truth ----
	local acs="$folder/ACs.md" parse_rc=0
	bash "$PG_PARSE_ACS" "$acs" >/dev/null 2>&1 || parse_rc=$?

	case "$parse_rc" in
	0)
		# Already done. Starting a loop here would start one that can never
		# block — a run whose only possible outcome is an immediate permit.
		pg_note "nothing to do: every criterion in $acs is already met. No loop started."
		return 4
		;;
	1) : ;; # outstanding work — the only state a loop makes sense in
	2)
		pg_die 2 "$acs contains no criteria. An empty checklist is refused, never read as complete." || return
		;;
	*)
		pg_die 3 "$acs could not be parsed (parse-acs exit $parse_rc), so what is outstanding is unknown. Refusing to start a loop against a contract that cannot be read." || return
		;;
	esac

	# --- the working tree the gate will govern -----------------------------
	#
	# Resolved BEFORE the registration check, because a project-scoped
	# registration lives in that tree and is a valid installation.
	local anchor gate_dir
	if ! anchor="$(pg_anchor)" || [ -z "$anchor" ]; then
		pg_die 5 "cannot resolve a working-tree anchor for the gate directory." || return
	fi

	# --- the gate must actually be there ----------------------------------
	local agent
	agent="$(pg_detect_agent)"

	# --- provision this checkout before judging it (T4.3) -----------------
	#
	# A goal folder prepared in a git WORKTREE arrives without the machinery:
	# the gate skills and the Stop registration are frequently UNTRACKED in the
	# originating checkout, so `git worktree add` does not bring them across.
	# The starter then refused with exit 6 — correctly, but uselessly: it had a
	# perfectly good copy one directory away and declined to fetch it.
	#
	# So: copy first, judge second. The refusal is kept for the case it was
	# written for — no originating checkout to copy from — where starting really
	# would drive the folder to completion with nothing checking it.
	if [ "${GOAL_GATE_SKIP_PROVISION-}" != "1" ]; then
		pg_provision_worktree "$anchor" || true
	fi

	# ponytail: Codex skips every hook check. Codex cloud lets an agent write
	# .codex/hooks.json, but it offers no way to trust the hook (no /hooks
	# review), and Codex silently skips an untrusted hook. So proof-of-fire can
	# never pass there, and requiring it only made agents burn turns trying.
	# Under Codex the agent drives the criteria to done itself; a gate that
	# does fire still claims the loop state at its first turn end.
	if [ "$agent" != "codex" ] && [ "${GOAL_GATE_SKIP_REGISTRATION_CHECK-}" != "1" ]; then
		if ! pg_registration_ok "$agent" "$anchor"; then
			pg_die 6 "the goal-gate stop hook is not registered (or is registered but cannot run) for agent '$agent', in this project or user-globally. Refusing to start: without the gate, this would drive the folder to completion with nothing checking it. Install it first, then re-run." || return
		fi
	fi

	# The right-hand side of `case` is a PATTERN, so an anchor containing a
	# glob metacharacter would be matched as one — `/repo/a*b` would admit
	# `/repo/axxb/`, a folder outside the tree the gate governs. Compare the
	# prefix by string instead.
	case "${folder}/" in
	"${anchor}/"*) : ;;
	*)
		pg_die 2 "the goal folder is outside the working tree the session runs from ($anchor), so the gate would never find it. Move the folder inside, or run from a directory above it." || return
		;;
	esac

	gate_dir="$anchor/$PG_MARKER"

	if [ -e "$gate_dir" ] && [ ! -d "$gate_dir" ]; then
		pg_die 5 "collision: $gate_dir exists but is not a directory." || return
	fi
	if [ ! -d "$gate_dir" ] && ! mkdir -p -- "$gate_dir" 2>/dev/null; then
		pg_die 5 "cannot create the gate directory: $gate_dir" || return
	fi
	if [ ! -w "$gate_dir" ]; then
		pg_die 5 "the gate directory is not writable: $gate_dir" || return
	fi

	# The guard and the ignore entries (T3.5). Best-effort: a missing guard makes
	# the state directory easier to misread, but it is not a reason to refuse to
	# start a loop that is otherwise fully valid.
	GOAL_GATE_DIR="$gate_dir" bash "${GOAL_GATE_CANCEL:-$PG_SELF_DIR/cancel.sh}" scaffold "$anchor" >/dev/null 2>&1 || true

	# --- one loop at a time -------------------------------------------------
	#
	# The lock makes the check-then-create atomic, so two conversations starting
	# on the same folder at the same moment cannot both create a workstream.
	local lock="$gate_dir/.pursue.lock" tries=0
	while ! mkdir -- "$lock" 2>/dev/null; do
		tries=$((tries + 1))
		if [ "$tries" -ge 100 ]; then
			pg_die 5 "cannot acquire the starter lock after $tries tries: $lock (remove it if no starter is running)" || return
		fi
		sleep 0.05
	done

	local rc=0
	pg_start_locked "$folder" "$acs" "$gate_dir" "$agent" || rc=$?
	rmdir -- "$lock" 2>/dev/null || true
	return "$rc"
}

# pg_start_locked <folder> <acs> <gate-dir> <agent> — caller holds the lock.
# pg_provision_worktree <anchor> — carry the gate machinery into this checkout.
#
# THE DEFECT: `prepare-goal` creates a git worktree for the workstream, and the
# gate skills plus the Stop registration are usually UNTRACKED in the checkout
# it was created from. `git worktree add` copies tracked files only, so the
# prepared folder lands in a tree that cannot start it, and the starter refused
# with exit 6 while a working copy sat one directory away. A prepared goal that
# cannot be started is the "prepared but unstartable" failure in miniature.
#
# WHAT IS COPIED, and only into gaps:
#   * the goal-gate skill and the two goal skills, if absent here;
#   * the gate's Stop registration in .claude/settings.json, if absent here.
# Nothing is overwritten. A checkout that already has its own copy keeps it —
# this provisions, it does not synchronise, and silently replacing a local
# edit would be a worse surprise than a refusal.
#
# Every item copied is REPORTED. Machinery that appears without being announced
# is machinery nobody knows to maintain.
#
# A no-op unless this is a linked worktree with a resolvable main checkout.
pg_provision_worktree() {
	local anchor="$1" gitdir commondir main src dst copied=0 name

	command -v git >/dev/null 2>&1 || return 0
	gitdir="$(git -C "$anchor" rev-parse --git-dir 2>/dev/null)" || return 0
	commondir="$(git -C "$anchor" rev-parse --git-common-dir 2>/dev/null)" || return 0
	# Same dir means this is the main checkout: nothing to provision FROM.
	[ "$gitdir" != "$commondir" ] || return 0

	case "$commondir" in
	/*) main="$(dirname -- "$commondir")" ;;
	*) main="$(cd -- "$anchor" && cd -- "$(dirname -- "$commondir")" && pwd -P)" || return 0 ;;
	esac
	[ -n "$main" ] && [ -d "$main" ] && [ "$main" != "$anchor" ] || return 0

	for name in eque2-code-goal-gate eque2-code-pursue-goal eque2-code-prepare-goal eque2-code-plan-goal eque2-code-agent-hannibal; do
		src="$main/.claude/skills/$name"
		dst="$anchor/.claude/skills/$name"
		[ -d "$src" ] || continue
		[ -d "$dst" ] && continue
		mkdir -p -- "$anchor/.claude/skills" 2>/dev/null || continue
		if cp -R -- "$src" "$dst" 2>/dev/null; then
			chmod +x -- "$dst"/*.sh 2>/dev/null || true
			copied=$((copied + 1))
			printf 'pursue-goal: provisioned %s from the originating checkout (%s).\n' "$name" "$main"
		fi
	done

	# The registration itself. Untracked in the same way, and without it the
	# skills are present but inert — which looks identical to installed.
	local here="$anchor/.claude/settings.json" there="$main/.claude/settings.json"
	if [ -f "$there" ] && command -v jq >/dev/null 2>&1; then
		if ! grep -q 'eque2-code-goal-gate/goal-gate-stop.sh' "$here" 2>/dev/null &&
			grep -q 'eque2-code-goal-gate/goal-gate-stop.sh' "$there" 2>/dev/null; then
			local reg tmp
			reg="$(jq -c '[.hooks.Stop[]? | select(tostring | contains("eque2-code-goal-gate/goal-gate-stop.sh"))]' "$there" 2>/dev/null)"
			if [ -n "$reg" ] && [ "$reg" != "[]" ]; then
				[ -f "$here" ] || printf '{}\n' >"$here" 2>/dev/null
				tmp="$(mktemp -- "${here%/*}/.pursue-goal.XXXXXX" 2>/dev/null)" || tmp=""
				if [ -n "$tmp" ] &&
					jq --argjson reg "$reg" '.hooks.Stop = ((.hooks.Stop // []) + $reg)' "$here" >"$tmp" 2>/dev/null &&
					mv -f -- "$tmp" "$here" 2>/dev/null; then
					copied=$((copied + 1))
					printf 'pursue-goal: provisioned the goal-gate Stop registration into %s from %s.\n' "$here" "$there"
				else
					rm -f -- "$tmp" 2>/dev/null
				fi
			fi
		fi
	fi

	if [ "$copied" -gt 0 ]; then
		printf 'pursue-goal: this worktree was created without the goal-gate machinery (it is untracked in the originating checkout, so git worktree add did not carry it). %s item(s) copied. Hook changes load at agent start, so restart the agent if the gate does not claim the loop.\n' "$copied"
	fi
	return 0
}

pg_start_locked() {
	local folder="$1" acs="$2" gate_dir="$3" agent="$4"
	local existing loop_file token

	# The blocked signal is a FILE, not only a status field: a run brought to a
	# reported end by LOOP_BLOCKED must not be silently restarted around.
	#
	# The signals are KEYED per workstream (`<workstream>.LOOP_BLOCKED`). Any
	# raised signal still stops a start here, because one gate directory governs
	# one loop at a time — but the refusal NAMES the workstream, so an operator
	# is not left hunting for a blocker that belongs to some other run.
	local sig sig_ws
	for sig in "$gate_dir"/*.LOOP_BLOCKED; do
		[ -f "$sig" ] || continue
		sig_ws="$(basename -- "$sig")"
		sig_ws="${sig_ws%.LOOP_BLOCKED}"
		pg_die 7 "a blocked signal is raised for workstream ${sig_ws} in $gate_dir. That is a reported non-completion, not a cleared loop — read its reason, resolve or remove it deliberately, then start again." || return
	done
	# A bare file from a version that predates the keyed name. It binds no
	# workstream, so it is reported with the exact correction rather than
	# silently honoured or silently ignored.
	if [ -f "$gate_dir/LOOP_BLOCKED" ]; then
		pg_die 7 "an UNKEYED blocked signal sits at $gate_dir/LOOP_BLOCKED. It names no workstream, so it is not honoured for any loop and it is not clear which run it was meant to end. Read it, then either delete it or key it: mv $gate_dir/LOOP_BLOCKED $gate_dir/<workstream>.LOOP_BLOCKED" || return
	fi

	if existing="$(pg_active_loop "$gate_dir")"; then
		local bound
		bound="$(bash "$PG_LOOP_STATE" get "$existing" goal_folder 2>/dev/null)" || bound="<unrecorded>"
		if [ "$bound" = "$folder" ]; then
			pg_die 7 "a loop is already active for this folder ($existing). Let it run, or cancel it, rather than starting a second one against the same criteria." || return
		fi
		pg_die 7 "a loop is already active in this working tree for a different workstream ($bound, state $existing). One gate directory governs one loop at a time." || return
	fi

	# The unclaimed name is the handshake: `_anon-*` is the only shape this
	# script ever writes, and the gate claims exactly one on its next turn end.
	#
	# THE GATE RENAMES IT AFTERWARDS, AND THIS SCRIPT MUST NOT ANTICIPATE THAT.
	# On the turn it is claimed the file becomes `_ws-<owner>.state`, and when it
	# reaches a terminal status it becomes `_ended-<owner>-<token>.state`. Being
	# born unclaimed is the whole handshake: a file written under either of the
	# other two names would be claiming an owner that does not exist yet.
	token="$(pg_token)"
	loop_file="$gate_dir/_anon-$token.state"

	if [ -e "$loop_file" ]; then
		pg_die 5 "refusing to overwrite an existing state file: $loop_file" || return
	fi

	# Written to a temp name and renamed, so the gate can never observe a
	# half-written workstream and claim it.
	local tmp
	if ! tmp="$(mktemp -- "$gate_dir/.pursue.XXXXXX")"; then
		pg_die 5 "cannot create a temporary file in: $gate_dir" || return
	fi

	# `workstream_token` is the JOIN KEY, and it is written HERE, at birth,
	# alongside the name it matches — never derived from a filename later.
	#
	# The gate renames this file at least once and usually twice, and after the
	# first hop the base no longer contains the token at all. A later reader that
	# stripped `_ws-` off the current base would get the PREVIOUS OWNER'S session
	# id and call it the token, so a reclaimed loop would retire as
	# `_ended-<rescuer>-<previous-owner>`; two finished runs in one gate directory
	# would then collide on that name, the retiring rename would be skipped, and
	# a completed loop would be left sitting in the adoptable pool. Recording the
	# key at the one moment it is unambiguous removes the whole class.
	local field
	for field in \
		"status=active" \
		"workstream_token=$token" \
		"goal_folder=$folder" \
		"acs_path=$acs" \
		"goal_md=$folder/goal.md" \
		"iteration=0" \
		"started_by=pursue-goal" \
		"started_agent=$agent" \
		"started_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"; do
		if ! bash "$PG_LOOP_STATE" set "$tmp" "${field%%=*}" "${field#*=}"; then
			rm -f -- "$tmp"
			pg_die 5 "cannot write loop state: $tmp" || return
		fi
	done

	if ! mv -f -- "$tmp" "$loop_file"; then
		rm -f -- "$tmp"
		pg_die 5 "cannot place the loop state file: $loop_file" || return
	fi

	printf 'loop_state=%s\n' "$loop_file"
	printf 'goal_folder=%s\n' "$folder"
	printf 'acs_path=%s\n' "$acs"
	printf 'agent=%s\n' "$agent"
	if [ "$agent" = "codex" ]; then
		pg_note "loop state written. Continue in Codex now: work the outstanding criteria in this turn, and do not end it to wait for a gate. Do not register, trust, or prove the Stop hook."
		return 0
	fi
	pg_note "loop state written and UNCLAIMED. End this one bootstrap turn without further work so the gate can claim it. Once claimed, do not yield for ordinary waits: hard-wait/poll background work inside the active turn."
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -uo pipefail
	pg_main "$@"
	exit $?
fi
