#!/usr/bin/env bash
# install.sh — register the goal-gate stop hook with every installed agent.
#
# ONE INTERNAL DESCRIPTION, RENDERED TWICE (T3.1). The registration object is
# built in exactly one place and written to two locations. Two independently
# maintained registrations drift, and a drifted registration means the gate runs
# under one agent and not the other while BOTH look installed — a fail-open that
# hides behind a successful-looking install.
#
# WHAT THE A1 SPIKE SETTLED. This layer was specified against assumption A1.b:
# that the second agent's registration might differ in SHAPE, and that this is
# where the translation would live. It does not. Fired against real
# `codex-cli 0.144.5` with a real model, Codex's hook object AND its payload
# field names are IDENTICAL to Claude Code's:
#
#   {"hooks":{"Stop":[{"matcher":…,"hooks":[{"type":"command","command":…}]}]}}
#
# So there is no translation layer. The difference is the LOCATION:
#
#   claude   $HOME/.claude/settings.json     (matcher groups under .hooks.Stop)
#   codex    $CODEX_HOME/hooks.json          (same shape, its own file)
#
# TRUST IS NOT OPTIONAL UNDER CODEX — the spike's material finding. Codex gates
# hook execution on persisted trust and SILENTLY SKIPS an untrusted hook: the
# session ends normally, nothing blocks, no warning is printed, and an installer
# that only wrote config would report success over an INERT gate. That is a
# fail-open at the centre of a fail-closed feature. Writing the registration is
# therefore only half of installation; verifying the gate actually EXECUTES is
# the other half (T3.4), and this script must never claim success on the
# strength of a written file alone.
#
# THIS SCRIPT EDITS SHARED USER CONFIGURATION. `~/.claude/settings.json` and
# `~/.codex/config.toml` are occupied by tools this feature never heard of — a
# third-party `stop` registration is present on the development machine right
# now. Every write is additive and idempotent (T3.2), a backup is taken first,
# and the fixture-first canary ordering in the charter is mandatory, not
# advisory.
#
# Verbs:
#   render <agent>                     print the registration object
#   install <agent> [home]             write it, additively and idempotently
#   uninstall <agent> [home]           remove ONLY the gate's registrations
#   migrate <agent> [home] [--remove-predecessor]
#                                      install, and optionally hand over from
#                                      the predecessor as a reported step
#   doctor <agent> [home]              report a registration that cannot run
#   prove <agent> [home]               report whether the gate has been OBSERVED
#                                      to fire here, and how to establish it.
#                                      Configuration cannot answer this under
#                                      Codex; only a real fire can.
#   place-gate [home]                  copy the gate into the ONE shared location
#                                      every registration points at
#   gate-path [home]                   print that path; creates NOTHING
#   target-path <agent> [home]         print the config path; creates NOTHING
#   check-writable <agent> [home]      can that path be written? no side effects
#   place-skills <agent> [home] [--force]
#                                      copy the skills into that agent's skill
#                                      directory from the ONE source of truth
#   skills-path <agent> [home]         print that directory; creates NOTHING
#   detect <agent> [home]              present | absent | undetected
#   install-all [home]                 register with every agent actually
#                                      present; FAILS when that is none
#   migrate-signal [gate-dir]          rename a legacy unkeyed LOOP_BLOCKED to
#                                      <workstream>.LOOP_BLOCKED, but ONLY when
#                                      exactly one workstream state file exists.
#                                      Otherwise it is left in place and
#                                      reported: ownership is a guess, and
#                                      guessing ends the wrong loop.
#
# Exit codes:
#   0   success
#   1   a REPORTED non-success: no registration found, a registration that
#       cannot run, a drifted placed copy, or no agent present. `pursue-goal`
#       hangs its whole registration refusal off this code, so it is part of the
#       contract, not an accident.
#   2   invalid input (unknown agent, missing argument)
#   5   filesystem failure (unwritable target)
#   64  usage error

set -uo pipefail

GG_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# The host timeout. This must be at least the gate's OWN decision budget (120s,
# review finding R3): a shorter host timeout kills the hook before it can
# refuse, and a host that kills a hook may treat the dead hook as consent.
GG_HOOK_TIMEOUT="${GOAL_GATE_HOOK_TIMEOUT:-120}"

install_die() {
	local code="$1"
	shift
	printf 'goal-gate-install: %s\n' "$*" >&2
	return "$code"
}

# install_known_agent <agent> — the allow-list. An unknown agent is REJECTED,
# never defaulted to "the usual one": silently rendering for a typo'd name
# installs the gate somewhere nobody asked for and reports success.
install_known_agent() {
	case "${1-}" in
	claude | codex) return 0 ;;
	*) return 1 ;;
	esac
}

# --- the gate the registration points at (ONE location, both agents) --------
#
# WHY NOT THE CHECKOUT. `$GG_SELF_DIR/goal-gate-stop.sh` is a path inside
# whichever repository happened to run the installer, written into config that
# is USER-GLOBAL for both agents (`~/.claude/settings.json`, `$CODEX_HOME/
# hooks.json`). That produced two field failures at once:
#
#   1. LAST WRITER WINS, MACHINE-WIDE. Installing from a second project silently
#      repointed the global hook at that project. Observed live: hooks.json
#      naming a path under `vadz` while the operator worked in `jam-flow`.
#   2. EVERY RE-REGISTRATION BREAKS CODEX TRUST. Codex trusts a hook by hashing
#      it, so rewriting the command invalidates the recorded `trusted_hash` and
#      the hook is silently skipped again — trust has to be re-granted after
#      every install from any project, forever, with nothing saying it lapsed.
#
# ONE SHARED, AGENT-NEUTRAL LOCATION fixes both, and keeps the T3.1 invariant
# intact: the two renderings stay byte-identical because there is one path, not
# one per agent. Trust granted once keeps holding, and no project can steal the
# registration from another.
#
# The gate is repo-agnostic at runtime — it finds the workstream by walking UP
# from the session's cwd — so a single machine-global copy correctly gates every
# project, each with its own `.goal-gate/`.
#
# NOT UNDER `~/.goal-gate/`. That is the marker directory name the gate searches
# for, so a runtime tree there would make $HOME look like a bound workstream and
# every session on the machine would trip over it. That is not hypothetical: it
# happened, and it blocked every session until the directory was deleted.
install_gate_home() {
	local home="${1-}"
	if [ -n "$home" ]; then
		home="${home%/}"
		# NORMALISE AN AGENT-SPECIFIC HOME TO ITS PARENT. install_home blesses
		# both shapes — `<root>` and `<root>/.codex` — and callers use both
		# (test-install-additive.sh installs codex against `$H/.codex` while
		# claude gets `$H`). Taken literally that yields two DIFFERENT runtime
		# trees and two different registered commands, silently breaking T3.1
		# and reintroducing per-agent divergence through the back door. The gate
		# runtime is agent-neutral, so an agent's own directory resolves to the
		# home that contains it.
		case "$home" in
		*/.claude | */.codex) home="${home%/*}" ;;
		esac
		printf '%s/goal-gate-runtime' "$home"
		return 0
	fi
	printf '%s/goal-gate' "${GOAL_GATE_RUNTIME_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}}"
}

# install_gate_home_safe [home] — install_gate_home with the one property that
# must hold ENFORCED rather than merely commented.
#
# The base is operator-controlled (GOAL_GATE_RUNTIME_HOME, XDG_DATA_HOME), so
# nothing stops it naming the marker directory the gate walks UP looking for. A
# runtime tree at `$HOME/.goal-gate/...` makes $HOME look like a bound
# workstream and every session on the machine trips over it. That is not
# hypothetical: it happened, and it blocked every session on this machine until
# the directory was deleted. A comment saying so did not prevent it; this does.
install_gate_home_safe() {
	local dir marker component rest
	dir="$(install_gate_home "${1-}")" || return
	marker="${GOAL_GATE_MARKER:-.goal-gate}"

	rest="$dir"
	while [ -n "$rest" ] && [ "$rest" != "/" ]; do
		component="${rest##*/}"
		if [ "$component" = "$marker" ]; then
			install_die 2 "the gate runtime path $dir contains a component named '$marker' — the directory the gate walks up looking for. Placing the runtime there would make its parent look like a bound workstream and block every session beneath it. Point GOAL_GATE_RUNTIME_HOME somewhere else." || return
		fi
		rest="${rest%/*}"
	done

	printf '%s' "$dir"
}

# install_gate_path [agent] [home] — the command every registration carries.
# The agent is accepted and DELIBERATELY UNUSED: one path, both agents (T3.1).
install_gate_path() {
	if [ -n "${GOAL_GATE_STOP_PATH-}" ]; then
		printf '%s\n' "$GOAL_GATE_STOP_PATH"
		return 0
	fi
	local home_dir
	home_dir="$(install_gate_home_safe "${2-}")" || return
	printf '%s/gate/goal-gate-stop.sh\n' "$home_dir"
}

# install_place_gate [home] — copy the gate and the scripts it calls into the
# shared location, so the registered command exists before anything points at it.
#
# The gate resolves its delegates (parse-acs, validate-acs, loop-state) from its
# OWN directory, so they travel with it or it is inert on first fire.
install_place_gate() {
	local home="${1-}" dest src f
	dest="$(install_gate_home_safe "$home")/gate" || return
	src="$GG_SELF_DIR"

	if [ ! -f "$src/goal-gate-stop.sh" ]; then
		install_die 5 "no goal-gate-stop.sh beside the installer at $src" || return
	fi
	if ! mkdir -p -- "$dest" 2>/dev/null; then
		install_die 5 "cannot create the gate directory: $dest" || return
	fi

	for f in "$src"/*.sh; do
		[ -f "$f" ] || continue
		# The installer is not a delegate and must not travel: re-running it
		# from the runtime copy would cp a file onto itself and abort the install.
		case "$(basename -- "$f")" in install.sh) continue ;; esac
		cp -- "$f" "$dest/" 2>/dev/null || {
			install_die 5 "cannot copy $(basename -- "$f") into $dest" || return
		}
		chmod +x -- "$dest/$(basename -- "$f")" 2>/dev/null || true
	done

	# VERSION STAMP (B3). One machine-global copy now serves every project,
	# last-writer-wins, while `pursue-goal` still runs from its own checkout.
	# Before, both resolved from GG_SELF_DIR and were the same revision by
	# construction; now they are independently versioned with no handshake, and
	# a mismatch surfaces as a refusal naming nothing the operator changed.
	# Stamping what was placed is the minimum that makes skew diagnosable.
	local stamp prev
	stamp="$dest/.placed-from"
	prev=""
	[ -f "$stamp" ] && prev="$(head -1 -- "$stamp" 2>/dev/null)"
	printf '%s\n' "$src" >"$stamp" 2>/dev/null || true

	if [ -n "$prev" ] && [ "$prev" != "$src" ]; then
		printf 'goal-gate-install: NOTE — the shared gate was previously placed from %s and has now been replaced from %s. One copy serves every project on this machine, so any project still running the older gate is now running this one.\n' \
			"$prev" "$src" >&2
	fi

	printf 'goal-gate-install: gate placed at %s\n' "$dest/goal-gate-stop.sh"
}

# install_render <agent> — THE single source of the registration object.
#
# Both agents get the identical object (see the A1 note in the header). The
# function still takes the agent so that a future divergence has one obvious
# place to live — and so the suite can assert the two renderings are equal
# rather than assuming they are.
install_render() {
	local agent="${1-}"

	if ! install_known_agent "$agent"; then
		install_die 2 "unknown agent: ${agent:-<empty>} (known: claude, codex)" || return
	fi

	printf '{"matcher":"*","hooks":[{"type":"command","command":"%s","timeout":%s}]}\n' \
		"$(install_gate_path "$agent" "${2-}")" "$GG_HOOK_TIMEOUT"
}

# install_home <agent> [home] — the base directory for that agent's config.
install_home() {
	local agent="$1" home="${2-}"

	if [ -n "$home" ]; then
		printf '%s' "${home%/}"
		return 0
	fi

	case "$agent" in
	codex) printf '%s' "${CODEX_HOME:-$HOME/.codex}" ;;
	*) printf '%s' "$HOME" ;;
	esac
}

# install_target_path <agent> [home] — where the registration is written.
#
# Pure resolution: creates NOTHING. Resolution and mutation are separate steps,
# so a dry run cannot leave a trace.
install_target_path() {
	local agent="${1-}" home base

	if ! install_known_agent "$agent"; then
		install_die 2 "unknown agent: ${agent:-<empty>} (known: claude, codex)" || return
	fi

	home="$(install_home "$agent" "${2-}")"

	case "$agent" in
	claude)
		printf '%s/.claude/settings.json\n' "${home%/}"
		;;
	codex)
		# With an explicit home, the layout mirrors the real one so a fixture
		# exercises the same path shape the live install will take.
		base="${home%/}"
		case "$base" in
		*/.codex) printf '%s/hooks.json\n' "$base" ;;
		*) printf '%s/.codex/hooks.json\n' "$base" ;;
		esac
		;;
	esac
}

# install_check_writable <agent> [home] — can the registration be written?
#
# Reports without creating anything. The nearest EXISTING ancestor is what is
# tested, because a missing intermediate directory is only a problem if the
# directory that would hold it refuses to receive it.
install_check_writable() {
	local agent="${1-}" path dir
	path="$(install_target_path "$agent" "${2-}")" || return

	dir="$(dirname -- "$path")"
	while [ ! -e "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "." ]; do
		dir="$(dirname -- "$dir")"
	done

	if [ ! -d "$dir" ]; then
		install_die 5 "not a directory: $dir" || return
	fi
	if [ ! -w "$dir" ]; then
		install_die 5 "cannot write the registration: $dir is not writable" || return
	fi
	if [ -e "$path" ] && [ ! -w "$path" ]; then
		install_die 5 "cannot write the registration: $path exists and is not writable" || return
	fi

	printf '%s\n' "$path"
}

# --- additive, idempotent installation (T3.2) -------------------------------
#
# Every write PRESERVES what is already there and produces no duplicate when run
# again. This is not hypothetical: `~/.claude/settings.json` on the development
# machine registers a PREDECESSOR stop hook on the same event, and
# `~/.codex/config.toml` carries a third-party `[hooks.state]` table. A
# clobbering installer breaks software this feature never touched, in shared
# user configuration, affecting every project on the machine.
#
# The edit is STRUCTURAL (jq), never textual. A regex over someone's settings
# file is how unrelated content gets mangled.

# install_backup <path> — copy before modifying. Returns the backup path.
install_backup() {
	local path="$1" stamp backup
	[ -f "$path" ] || return 0
	stamp="$(date -u '+%Y%m%dT%H%M%SZ' 2>/dev/null)"
	backup="${path}.goal-gate-backup-${stamp}"
	cp -p -- "$path" "$backup" 2>/dev/null || {
		install_die 5 "could not write a backup of $path — refusing to modify it" || return
	}
	printf '%s' "$backup"
}

# install_read_json <path> — the file's JSON, or `{}` for absent/empty.
#
# An unparseable file is REFUSED, never overwritten: destroying settings the
# user cannot recover, to fix a problem we did not cause, is a worse outcome
# than declining. JSONC gets its own message because "invalid JSON" would send
# the reader hunting for a typo that is really a comment.
install_read_json() {
	local path="$1" content

	[ -e "$path" ] || {
		printf '{}'
		return 0
	}

	content="$(cat -- "$path" 2>/dev/null)" || {
		install_die 5 "cannot read $path" || return
	}

	case "$content" in
	'' | *[![:space:]]*) : ;;
	esac
	if [ -z "$(printf '%s' "$content" | tr -d '[:space:]')" ]; then
		printf '{}'
		return 0
	fi

	if printf '%s' "$content" | jq -e . >/dev/null 2>&1; then
		printf '%s' "$content"
		return 0
	fi

	if printf '%s' "$content" | grep -qE '^[[:space:]]*(//|/\*)|[^:"]//' 2>/dev/null; then
		install_die 4 "$path contains comments (JSONC), which cannot be edited structurally without rewriting your file. Remove the comments, or add the registration by hand:
  $(install_render claude)" || return
	fi

	install_die 4 "$path is not valid JSON, so it will NOT be modified. Fix or restore it, then re-run." || return
}

# install_apply <existing-json> <registration> — the structural edit.
#
# Idempotent by IDENTITY, not by position: an entry whose command names the gate
# is replaced wherever it sits, and empty matcher groups left behind are pruned.
# Matching on position would add a second group on the next run, and a duplicate
# one level up is invisible to a reader counting entries.
install_apply() {
	local existing="$1" reg="$2"

	printf '%s' "$existing" | jq --argjson reg "$reg" '
		. as $root
		| ($root.hooks // {}) as $hooks
		| ($hooks.Stop // []) as $stop
		# Drop every existing goal-gate entry, anywhere it appears.
		| ($stop | map(
			.hooks = ((.hooks // []) | map(select((.command // "") | test("goal-gate-stop") | not)))
		  )) as $cleaned
		# Prune groups that are now empty, so repeated runs cannot accumulate them.
		| ($cleaned | map(select((.hooks // []) | length > 0))) as $pruned
		| $root
		| .hooks = $hooks
		| .hooks.Stop = ($pruned + [$reg])
	' 2>/dev/null
}

# install_codex_ambiguity <codex-home> — surface Codex loading hooks from two
# places. Codex itself warns about this; the installer surfaces it rather than
# leaving the operator to find it in a log (spike finding F2).
install_codex_ambiguity() {
	local toml="${1%/}/config.toml"
	[ -f "$toml" ] || return 0
	if grep -qE '^[[:space:]]*\[+hooks' "$toml" 2>/dev/null; then
		printf 'goal-gate-install: NOTE — %s also declares hooks inline. Codex loads from BOTH config.toml and hooks.json and warns about the ambiguity; prefer a single representation.\n' \
			"$toml" >&2
	fi
	return 0
}

# install_install <agent> [home] — write the registration.
install_install() {
	local agent="${1-}" home="${2-}" path dir existing reg updated tmp

	path="$(install_check_writable "$agent" "$home")" || return

	if [ "$agent" = "codex" ]; then
		install_codex_ambiguity "$(install_home "$agent" "$home")"
	fi

	# The registration points at the shared copy, so that copy must exist FIRST.
	# A hook command that is missing fails OPEN: the host reports a non-blocking
	# error, the turn ends, and nothing is gated — silently, every turn.
	install_place_gate "$home" >/dev/null || return
	local gate
	gate="$(install_gate_path "$agent" "$home")" || return
	if [ ! -x "$gate" ]; then
		install_die 5 "the gate is not present and executable at $gate, so registering it would create a hook that cannot run (which fails OPEN)" || return
	fi

	# The home MUST be threaded: install_gate_path derives the command from it,
	# and dropping it registers a path that this run never placed — a hook
	# command that does not exist, which fails OPEN.
	reg="$(install_render "$agent" "$home")" || return
	existing="$(install_read_json "$path")" || return

	updated="$(install_apply "$existing" "$reg")"
	if [ -z "$updated" ] || ! printf '%s' "$updated" | jq -e . >/dev/null 2>&1; then
		install_die 5 "the structural edit produced nothing usable; $path is unchanged" || return
	fi

	install_backup "$path" >/dev/null || return

	dir="$(dirname -- "$path")"
	mkdir -p -- "$dir" 2>/dev/null || {
		install_die 5 "could not create $dir" || return
	}

	# Written to a temp file in the TARGET directory and renamed: a partial
	# write must never be what the agent reads on its next start.
	tmp="$(mktemp -- "${dir}/.goal-gate-install.XXXXXX" 2>/dev/null)" || {
		install_die 5 "could not create a temporary file in $dir" || return
	}
	if ! printf '%s\n' "$updated" | jq -S . >"$tmp" 2>/dev/null; then
		rm -f -- "$tmp"
		install_die 5 "could not write the updated configuration" || return
	fi
	if ! mv -f -- "$tmp" "$path" 2>/dev/null; then
		rm -f -- "$tmp"
		install_die 5 "could not replace $path" || return
	fi

	printf 'goal-gate-install: registered the gate in %s\n' "$path"
	install_report_predecessor "$path"
	printf 'goal-gate-install: NOTE — a written registration is NOT proof the gate runs. Under Codex an untrusted hook is silently skipped. Verify it actually fires before relying on it.\n' >&2
	return 0
}

# --- uninstall and dangling-command safety (T3.6) ---------------------------
#
# THE ONE SANCTIONED FAIL-OPEN IN THIS FEATURE. Everywhere else an unknown
# resolves to NOT DONE. Not here: the gate lives in a repo CHECKOUT but is
# registered into user-global config by ABSOLUTE PATH, so moving, renaming or
# deleting that checkout leaves a registration that fires on every turn of every
# project forever. If that blocked, the user would have no working agent left
# with which to fix it.
#
# It fails open by construction rather than by special-casing: the gate's block
# decision is carried on STDOUT, and a command that does not exist produces no
# stdout. The host sees a failed hook and no decision, so the turn proceeds.
# `doctor` exists so the condition is REPORTABLE rather than merely survivable.

# install_uninstall <agent> [home] — remove the gate's registrations only.
install_uninstall() {
	local agent="${1-}" home="${2-}" path existing updated tmp dir before after

	path="$(install_target_path "$agent" "$home")" || return

	if [ ! -e "$path" ]; then
		printf 'goal-gate-install: nothing to remove — %s does not exist\n' "$path" >&2
		return 0
	fi

	existing="$(install_read_json "$path")" || return
	before="$(printf '%s' "$existing" | jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") | test("goal-gate-stop"))] | length' 2>/dev/null)"

	if [ "${before:-0}" = "0" ]; then
		printf 'goal-gate-install: the gate is not registered in %s — nothing to remove\n' "$path" >&2
		return 0
	fi

	# Remove the gate's entries wherever they sit, then prune groups the removal
	# emptied. A third-party entry sharing a group is preserved by construction:
	# only entries whose command names the gate are dropped.
	updated="$(printf '%s' "$existing" | jq '
		.hooks.Stop = ((.hooks.Stop // [])
			| map(.hooks = ((.hooks // []) | map(select((.command // "") | test("goal-gate-stop") | not))))
			| map(select((.hooks // []) | length > 0)))
	' 2>/dev/null)"

	if [ -z "$updated" ] || ! printf '%s' "$updated" | jq -e . >/dev/null 2>&1; then
		install_die 5 "the removal produced nothing usable; $path is unchanged" || return
	fi

	install_backup "$path" >/dev/null || return

	dir="$(dirname -- "$path")"
	tmp="$(mktemp -- "${dir}/.goal-gate-install.XXXXXX" 2>/dev/null)" || {
		install_die 5 "could not create a temporary file in $dir" || return
	}
	if ! printf '%s\n' "$updated" | jq -S . >"$tmp" 2>/dev/null || ! mv -f -- "$tmp" "$path" 2>/dev/null; then
		rm -f -- "$tmp"
		install_die 5 "could not write the updated configuration" || return
	fi

	after="$(jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") | test("goal-gate-stop"))] | length' "$path" 2>/dev/null)"
	printf 'goal-gate-install: removed %s gate registration(s) from %s (now %s)\n' \
		"$before" "$path" "${after:-0}"
	return 0
}

# install_doctor <agent> [home] — report registrations that cannot actually run.
#
# "The config says so" is not evidence the gate works. This reports the two ways
# a registration is present but inert: a command that is missing, and one that is
# not executable. (Under Codex there is a third — untrusted — which the host
# alone can resolve.)
install_doctor() {
	local agent="${1-}" home="${2-}" path cmds problems=0

	path="$(install_target_path "$agent" "$home")" || return

	if [ ! -e "$path" ]; then
		printf 'goal-gate-install: no configuration at %s\n' "$path" >&2
		return 1
	fi

	cmds="$(jq -r '.hooks.Stop[]?.hooks[]? | select((.command // "") | test("goal-gate-stop")) | .command' "$path" 2>/dev/null)"

	if [ -z "$cmds" ]; then
		printf 'goal-gate-install: the gate is not registered in %s\n' "$path" >&2
		return 1
	fi

	while IFS= read -r cmd; do
		[ -n "$cmd" ] || continue
		# Registrations may be written $HOME-relative; expand before testing.
		local real="${cmd/#\$HOME/$HOME}"
		if [ ! -e "$real" ]; then
			printf 'goal-gate-install: PROBLEM — registered command not found: %s\n' "$real" >&2
			printf 'goal-gate-install: the gate is registered but cannot run. It fails OPEN (no decision on stdout), so sessions are not blocked — but nothing is being gated either. Re-run install, or uninstall.\n' >&2
			problems=$((problems + 1))
		elif [ ! -x "$real" ]; then
			printf 'goal-gate-install: PROBLEM — registered command is not executable: %s\n' "$real" >&2
			problems=$((problems + 1))
		else
			printf 'goal-gate-install: OK — %s exists and is executable\n' "$real"
		fi
	done <<EOF
$cmds
EOF

	if [ "$problems" -gt 0 ]; then
		return 1
	fi

	printf 'goal-gate-install: NOTE — an executable registration is still not proof the gate FIRES. Under Codex an untrusted hook is silently skipped.\n' >&2
	return 0
}

# --- the predecessor (T5.1) -------------------------------------------------
#
# Both hooks registered on the same event is the realistic interim state, so it
# is DEFINED rather than discovered: the default is COEXIST. Removing someone's
# working hook as a side effect of installing ours is exactly the clobbering the
# charter's canary exists to prevent, and an in-flight predecessor loop must not
# break because we arrived.
#
# Removal is therefore opt-in and REPORTED. The predecessor's own script is
# never deleted — unregistering is ours to do, deleting another tool's files is
# not.
GG_PREDECESSOR_PATTERN="jam-loop-stop"

install_predecessor_count() {
	jq "[.hooks.Stop[]?.hooks[]? | select((.command // \"\") | test(\"$GG_PREDECESSOR_PATTERN\"))] | length" "$1" 2>/dev/null
}

install_report_predecessor() {
	local path="$1" n
	[ -e "$path" ] || return 0
	n="$(install_predecessor_count "$path")"
	if [ -n "$n" ] && [ "$n" != "0" ]; then
		printf 'goal-gate-install: NOTE — the predecessor (%s) is also registered on Stop in %s and has been LEFT IN PLACE. Both will fire; the gate only blocks on its own workstreams. To hand over deliberately: migrate --remove-predecessor.\n' \
			"$GG_PREDECESSOR_PATTERN" "$path" >&2
	fi
	return 0
}

# install_migrate <agent> [home] [--remove-predecessor]
install_migrate() {
	local agent="${1-}" home="${2-}" remove=0 path existing updated tmp dir n
	shift 2 2>/dev/null || true
	while [ "$#" -gt 0 ]; do
		case "$1" in
		--remove-predecessor) remove=1 ;;
		*) install_die 2 "unknown option: $1" || return ;;
		esac
		shift
	done

	install_install "$agent" "$home" || return

	[ "$remove" -eq 1 ] || return 0

	path="$(install_target_path "$agent" "$home")" || return
	existing="$(install_read_json "$path")" || return
	n="$(printf '%s' "$existing" | jq "[.hooks.Stop[]?.hooks[]? | select((.command // \"\") | test(\"$GG_PREDECESSOR_PATTERN\"))] | length" 2>/dev/null)"

	if [ -z "$n" ] || [ "$n" = "0" ]; then
		printf 'goal-gate-install: no predecessor registration found in %s — nothing to hand over\n' "$path" >&2
		return 0
	fi

	updated="$(printf '%s' "$existing" | jq "
		.hooks.Stop = ((.hooks.Stop // [])
			| map(.hooks = ((.hooks // []) | map(select((.command // \"\") | test(\"$GG_PREDECESSOR_PATTERN\") | not))))
			| map(select((.hooks // []) | length > 0)))
	" 2>/dev/null)"

	if [ -z "$updated" ] || ! printf '%s' "$updated" | jq -e . >/dev/null 2>&1; then
		install_die 5 "the predecessor removal produced nothing usable; $path is unchanged" || return
	fi

	install_backup "$path" >/dev/null || return

	dir="$(dirname -- "$path")"
	tmp="$(mktemp -- "${dir}/.goal-gate-install.XXXXXX" 2>/dev/null)" || {
		install_die 5 "could not create a temporary file in $dir" || return
	}
	if ! printf '%s\n' "$updated" | jq -S . >"$tmp" 2>/dev/null || ! mv -f -- "$tmp" "$path" 2>/dev/null; then
		rm -f -- "$tmp"
		install_die 5 "could not write the updated configuration" || return
	fi

	printf 'goal-gate-install: removed %s predecessor registration(s) (%s) from %s. The script itself was NOT deleted and the pre-change file is backed up beside it.\n' \
		"$n" "$GG_PREDECESSOR_PATTERN" "$path" >&2
	return 0
}

# --- skill placement (T3.7) -------------------------------------------------
#
# RESOLVES R14. "One mechanism, two registrations" was specified for the HOOK
# only. Every skill path in the contract was `.claude/skills/…`, which Codex
# does not read — so under Codex `pursue-goal` would be present on disk and
# completely undiscoverable, and the two commands would be delivered on one of
# the two claimed platforms while both looked installed. Same defect shape as a
# drifted registration, one layer up.
#
# ONE SOURCE OF TRUTH. The repo checkout is authoritative; every agent location
# is a PLACED COPY of it. A placed copy that has drifted from source is
# REPORTED, never silently overwritten — a drifted copy is usually somebody's
# local edit, and destroying it to make an install look clean is the clobbering
# this whole script exists to avoid. `--force` is the deliberate override.

# The skills that make up the two user-facing commands, plus the machinery they
# both call. Named explicitly rather than globbed: a glob over the skills
# directory would place every unrelated skill in the checkout.
GG_SKILLS="eque2-code-prepare-goal eque2-code-pursue-goal eque2-code-goal-gate eque2-code-plan-goal eque2-code-agent-hannibal"

# install_skills_source — the checkout directory the skills are copied FROM.
install_skills_source() {
	printf '%s' "${GOAL_GATE_SKILLS_SOURCE:-$(dirname -- "$GG_SELF_DIR")}"
}

# install_skills_path <agent> [home] — where that agent looks for skills.
#
# The ONE divergence between the agents at this layer, and the reason this is a
# function rather than a constant.
install_skills_path() {
	local agent="${1-}" base

	if ! install_known_agent "$agent"; then
		install_die 2 "unknown agent: ${agent:-<empty>} (known: claude, codex)" || return
	fi

	# Codex's config home and user-skill home are deliberately different:
	# hooks live under $CODEX_HOME (normally ~/.codex), while user skills are
	# discovered under ~/.agents/skills. Deriving the latter from CODEX_HOME
	# placed valid skill trees under ~/.codex/skills, which Codex never scans.
	# An explicit fixture home may be either the user's home root or the agent's
	# config directory; without one, Codex skills always resolve from $HOME.
	if [ -n "${2-}" ]; then
		base="${2%/}"
	else
		case "$agent" in
		codex) base="${HOME%/}" ;;
		*) base="$(install_home "$agent")" ;;
		esac
	fi

	case "$agent" in
	claude)
		case "$base" in
		*/.claude) printf '%s/skills\n' "$base" ;;
		*) printf '%s/.claude/skills\n' "$base" ;;
		esac
		;;
	codex)
		case "$base" in
		*/.codex) printf '%s/.agents/skills\n' "${base%/*}" ;;
		*) printf '%s/.agents/skills\n' "$base" ;;
		esac
		;;
	esac
}

# install_skill_drifted <source-dir> <placed-dir> — 0 when the copy differs.
#
# Content AND mode. `diff -r -q` compares bytes only, so a placed copy whose
# goal-gate-stop.sh had lost its exec bit was reported "already current" — while
# `doctor` hard-requires -x and calls the same registration inert. Install saying
# clean and doctor saying broken, about one file, is worse than either alone.
install_skill_drifted() {
	if ! diff -r -q -- "$1" "$2" >/dev/null 2>&1; then
		return 0
	fi

	local f rel
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		rel="${f#"$1"/}"
		if [ -x "$f" ] && [ ! -x "$2/$rel" ]; then
			return 0
		fi
		if [ ! -x "$f" ] && [ -x "$2/$rel" ]; then
			return 0
		fi
	done < <(find "$1" -type f 2>/dev/null)

	return 1
}

# install_place_skills <agent> [home] [--force]
install_place_skills() {
	local agent="" home="" force=0 arg

	for arg in "$@"; do
		case "$arg" in
		--force) force=1 ;;
		*)
			if [ -z "$agent" ]; then
				agent="$arg"
			elif [ -z "$home" ]; then
				home="$arg"
			fi
			;;
		esac
	done

	local dest src skill placed problems=0 placed_n=0 skipped_n=0

	dest="$(install_skills_path "$agent" "$home")" || return
	src="$(install_skills_source)"

	if [ ! -d "$src" ]; then
		install_die 5 "the skills source directory does not exist: $src" || return
	fi

	# Empty/Null: the agent's skill directory absent -> created.
	if [ ! -d "$dest" ] && ! mkdir -p -- "$dest" 2>/dev/null; then
		install_die 5 "cannot create the skills directory: $dest" || return
	fi
	if [ ! -w "$dest" ]; then
		install_die 5 "the skills directory is not writable: $dest" || return
	fi

	for skill in $GG_SKILLS; do
		if [ ! -d "$src/$skill" ]; then
			printf 'goal-gate-install: PROBLEM — source skill missing: %s/%s\n' "$src" "$skill" >&2
			problems=$((problems + 1))
			continue
		fi

		placed="$dest/$skill"

		if [ -e "$placed" ] && [ ! -d "$placed" ]; then
			printf 'goal-gate-install: PROBLEM — %s exists and is not a directory; left untouched\n' "$placed" >&2
			problems=$((problems + 1))
			continue
		fi

		if [ -d "$placed" ]; then
			if ! install_skill_drifted "$src/$skill" "$placed"; then
				# Idempotent: an identical copy is already correct.
				skipped_n=$((skipped_n + 1))
				continue
			fi
			if [ "$force" -ne 1 ]; then
				printf 'goal-gate-install: PROBLEM — the placed copy has DRIFTED from source and was NOT overwritten: %s\n' "$placed" >&2
				# shellcheck disable=SC2016  # the jq filter is a literal program, not a shell expansion
				printf 'goal-gate-install: compare with `diff -r %s %s`, then re-run with --force to replace it.\n' "$src/$skill" "$placed" >&2
				problems=$((problems + 1))
				continue
			fi
			rm -rf -- "$placed" 2>/dev/null || {
				printf 'goal-gate-install: PROBLEM — cannot replace %s\n' "$placed" >&2
				problems=$((problems + 1))
				continue
			}
		fi

		if ! cp -R -- "$src/$skill" "$placed" 2>/dev/null; then
			printf 'goal-gate-install: PROBLEM — cannot place %s into %s\n' "$skill" "$dest" >&2
			problems=$((problems + 1))
			continue
		fi
		placed_n=$((placed_n + 1))
	done

	printf 'goal-gate-install: %s — %d placed, %d already current, %d problem(s) in %s\n' \
		"$agent" "$placed_n" "$skipped_n" "$problems" "$dest" >&2

	[ "$problems" -eq 0 ]
}

# --- detection and the whole-machine install (T3.3) -------------------------
#
# FAIL-CLOSED APPLIES TO INSTALLATION TOO. "Nothing to do" is not success. An
# installer that finds no agent and exits 0 tells the reader the gate is in
# place; they then run `pursue-goal`, which is refused, and the failure surfaces
# one layer away from its cause.
#
# Three states, deliberately not two. "Undetected" is NOT folded into "absent":
# an agent whose home exists but cannot be read is an unanswered question, and
# answering it "absent" is a guess that reads as a fact.

# install_binary <agent> — the command that would run that agent.
install_binary() {
	case "${1-}" in
	claude) printf 'claude' ;;
	codex) printf 'codex' ;;
	esac
}

# install_detect <agent> [home] — prints present | absent | undetected.
#
# Presence is the binary on PATH OR a usable config home; either alone is
# enough, because a user may have installed the agent without ever running it,
# or run it from a path this shell cannot see.
install_detect() {
	local agent="${1-}" dir bin target

	if ! install_known_agent "$agent"; then
		install_die 2 "unknown agent: ${agent:-<empty>} (known: claude, codex)" || return
	fi

	# The agent's own CONFIG DIRECTORY, derived from the same resolver that
	# decides where the registration goes — not the home root. Under a fixture
	# home the root is a directory shared by both agents, so testing it would
	# report every agent present the moment the fixture existed.
	# Two steps, deliberately: `dir="$(dirname "$(inner)")" || return` checks
	# DIRNAME's status, not the inner call's. On an inner failure dirname prints
	# `.`, so `dir=.`, `[ -d . ]` is true, and an agent whose config path could
	# not be resolved would be reported "present".
	local target
	target="$(install_target_path "$agent" "${2-}")" || return
	dir="$(dirname -- "$target")"
	bin="$(install_binary "$agent")"

	# An existing config directory that is not a readable directory answers
	# nothing. This is the third state, and folding it into "absent" would print
	# a guess as a fact.
	if [ -e "$dir" ] && { [ ! -d "$dir" ] || [ ! -r "$dir" ]; }; then
		printf 'undetected\n'
		return 0
	fi

	if command -v "$bin" >/dev/null 2>&1; then
		printf 'present\n'
		return 0
	fi

	if [ -d "$dir" ]; then
		printf 'present\n'
		return 0
	fi

	printf 'absent\n'
}

# install_install_all [home] — install into every agent actually present.
install_install_all() {
	local home="${1-}" agent state installed=0 absent=0 undetected=0

	for agent in claude codex; do
		state="$(install_detect "$agent" "$home")" || return

		case "$state" in
		present)
			if install_install "$agent" "$home" >/dev/null; then
				# REGISTERING IS NOT INSTALLING (review finding). This used to
				# stop here, so a user who ran the documented installer got hook
				# registrations and NO SKILLS — and under Codex `pursue-goal` was
				# not a command that existed. "Registered for 2 agents" is what
				# it printed; "installed" is what the reader took away.
				if install_place_skills "$agent" "$home" >/dev/null 2>&1; then
					printf 'goal-gate-install: %s — detected, registered, and skills placed\n' "$agent" >&2
					installed=$((installed + 1))
				else
					# shellcheck disable=SC2016  # the backticked command is literal text
					printf 'goal-gate-install: %s — registered, but placing the skills FAILED. The gate would fire with no commands to drive it; run `place-skills %s` and read the report.\n' "$agent" "$agent" >&2
				fi
			else
				printf 'goal-gate-install: %s — detected, but registration FAILED\n' "$agent" >&2
			fi
			;;
		absent)
			printf 'goal-gate-install: %s — not installed on this machine; nothing registered for it\n' "$agent" >&2
			absent=$((absent + 1))
			;;
		undetected)
			printf 'goal-gate-install: %s — could NOT be detected (its home exists but is not a readable directory). This is an unanswered question, not an absence; nothing was registered for it.\n' "$agent" >&2
			undetected=$((undetected + 1))
			;;
		esac
	done

	if [ "$installed" -eq 0 ]; then
		install_die 1 "no supported agent was registered ($absent absent, $undetected undetected). NOTHING is installed and nothing is being gated — this is a failure, not a no-op." || return
	fi

	printf 'goal-gate-install: registered for %d agent(s). NOTE — a written registration is not proof the gate FIRES; see live-evidence/README.md.\n' \
		"$installed" >&2
	return 0
}

# install_prove <agent> [home] — establish that the host ACTUALLY RUNS the hook.
#
# Codex trusts a hook by its hash and skips an untrusted one in silence, so
# `doctor` — which can only see configuration — cannot answer "does it fire".
# Nothing this script can run answers it either: only the HOST ending a turn
# does. So `prove` does not simulate a fire; it sets up the conditions and hands
# the one irreducible step back to the operator.
#
# The gate records its own fire before it does anything else, INCLUDING on a
# turn with no loop bound (goal-gate-stop.sh, proof of fire). It records after
# parsing the host payload, before resolving or evaluating a workstream. So the
# bootstrap is simply: end a turn, then ask again. No probe loop to create and
# none to clean up if the current Codex session has not loaded the hook.
install_prove() {
	local agent="${1-}" home="${2-}" proof gate codex_home rc=0

	if ! install_known_agent "$agent"; then
		install_die 2 "unknown agent: ${agent:-<empty>} (known: claude, codex)" || return
	fi

	install_doctor "$agent" "$home" >/dev/null 2>&1 || {
		printf 'goal-gate-install: the gate is not registered and runnable for %s, so there is nothing that could fire yet.\n' "$agent" >&2
		printf 'goal-gate-install: fix that first — install.sh doctor %s reports what is wrong.\n' "$agent" >&2
		return 1
	}

	proof="${GOAL_GATE_PROOF:-$GG_SELF_DIR/proof-of-fire.sh}"
	if [ ! -r "$proof" ]; then
		install_die 2 "proof-of-fire.sh not found at $proof" || return
	fi

	gate="$(install_gate_path "$agent" "$home")" || return
	if [ "$agent" = "codex" ]; then
		codex_home="$(dirname -- "$(install_target_path codex "$home")")" || return
		CODEX_HOME="$codex_home" bash "$proof" check "$agent" "$gate" || rc=$?
	else
		bash "$proof" check "$agent" "$gate" || rc=$?
	fi
	case "$rc" in
	0)
		printf 'goal-gate-install: PROVEN — the gate has fired under %s on this machine, for this registration.\n' "$agent"
		return 0
		;;
	4)
		# Non-blocking BY DESIGN. Codex keys trust on the registered definition,
		# which has not changed; only the shipped implementation has. Blocking
		# here is what made every eque2-code release demand a fresh proof.
		printf 'goal-gate-install: PROVEN — the gate has fired under %s on this machine, for this registration.\n' "$agent"
		printf 'goal-gate-install: note — the gate implementation has changed since that fire. Not a problem, and nothing to do: the next turn-end re-records it.\n' >&2
		return 0
		;;
	2)
		printf 'goal-gate-install: the gate fired under %s before, but the REGISTRATION has moved since.\n' "$agent" >&2
		printf 'goal-gate-install: Codex trusts a specific command, so the new one must be observed once before it is relied on.\n' >&2
		;;
	*)
		printf 'goal-gate-install: NOT PROVEN — the gate has never been observed to fire under %s on this machine.\n' "$agent" >&2
		;;
	esac

	printf '\n' >&2
	printf 'To prove it:\n' >&2
	printf '  1. End this turn now — just stop. The gate runs at every turn end.\n' >&2
	printf '  2. Run install.sh prove %s again.\n' "$agent" >&2
	printf '\n' >&2
	if [ "$agent" = "codex" ]; then
		printf 'If it still reports NOT PROVEN, Codex did not run this exact hook in that turn.\n' >&2
		printf 'Open /hooks and verify the enabled Stop definition and source are trusted. If\n' >&2
		printf 'it was installed or trusted after this session started, restart Codex or open\n' >&2
		printf 'a new session so hooks reload. Also check that [features].hooks is enabled and\n' >&2
		printf 'workspace policy does not allow managed hooks only; inspect startup diagnostics\n' >&2
		printf 'for a load or execution error. Registration alone cannot distinguish these cases.\n' >&2
	fi
	return 1
}

# install_migrate_signal [gate-dir] — rename a legacy bare LOOP_BLOCKED.
#
# WHY THIS LIVES IN THE INSTALLER AND NOT IN THE GATE. The blocked signal is now
# keyed to its workstream (`<workstream>.LOOP_BLOCKED`), because a bare file
# named no owner and every loop in the directory read it as its own. A file left
# by an earlier version has to be attributed to SOMETHING, and attribution is a
# guess. The gate runs on every turn and must never guess: it reports the bare
# file and declines to honour it. The installer runs once, deliberately, and can
# afford to reason about how many workstreams exist — so it renames the file in
# the ONE case where the answer is not a guess at all.
#
# EXACTLY ONE workstream state file -> the owner is unambiguous, so rename.
# Zero, or two or more -> LEAVE IT and say so. Renaming under ambiguity would
# end the wrong loop, which is the defect this whole change removes.
# An existing keyed signal for that workstream -> LEAVE IT. Never overwrite a
# signal that names its owner with one that cannot.
#
# Silent when there is no legacy file, so a second run says nothing.
install_migrate_signal() {
	local gate_dir="${1:-$PWD/.goal-gate}"
	local legacy="$gate_dir/LOOP_BLOCKED"
	local f count=0 only="" base

	[ -d "$gate_dir" ] || return 0
	[ -f "$legacy" ] || return 0

	if [ ! -w "$gate_dir" ]; then
		install_die 5 "a legacy $legacy is present but $gate_dir is not writable, so it cannot be migrated. Nothing has been changed - fix the permissions and re-run rather than leaving it half-migrated." || return
	fi

	for f in "$gate_dir"/*.state; do
		[ -f "$f" ] || continue
		count=$((count + 1))
		only="$f"
	done

	if [ "$count" -ne 1 ]; then
		printf 'goal-gate-install: NOTE - a legacy unkeyed %s is present, and this gate directory holds %s workstream state file(s). Ownership cannot be established, so the file has been LEFT IN PLACE and is not honoured for any loop. Attribute it deliberately: mv %s %s/<workstream>.LOOP_BLOCKED\n' \
			"$legacy" "$count" "$legacy" "$gate_dir"
		return 0
	fi

	base="$(basename -- "$only")"
	base="${base%.state}"

	if [ -f "$gate_dir/$base.LOOP_BLOCKED" ]; then
		printf 'goal-gate-install: NOTE - a legacy unkeyed %s is present, but %s/%s.LOOP_BLOCKED already exists. The keyed signal names its owner and the legacy one does not, so the legacy file has been LEFT IN PLACE rather than overwriting it. Read both, then delete the one you do not want.\n' \
			"$legacy" "$gate_dir" "$base"
		return 0
	fi

	if ! mv -- "$legacy" "$gate_dir/$base.LOOP_BLOCKED" 2>/dev/null; then
		install_die 5 "could not migrate $legacy to $gate_dir/$base.LOOP_BLOCKED" || return
	fi
	printf 'goal-gate-install: migrated the legacy unkeyed blocked signal to %s/%s.LOOP_BLOCKED (the only workstream in this gate directory). A running loop is not ended by this: the file said the same thing before, it simply now says whose it is.\n' \
		"$gate_dir" "$base"
}

install_main() {
	local verb="${1-}"

	case "$verb" in
	-h | --help | '')
		sed -n '2,/^#   64  usage error$/p' "$0"
		return 0
		;;
	esac
	shift

	case "$verb" in
	render) install_render "${1-}" "${2-}" ;;
	install) install_install "${1-}" "${2-}" ;;
	uninstall) install_uninstall "${1-}" "${2-}" ;;
	migrate) install_migrate "$@" ;;
	doctor) install_doctor "${1-}" "${2-}" ;;
	prove) install_prove "${1-}" "${2-}" ;;
	place-gate) install_place_gate "${1-}" ;;
	gate-path) install_gate_path "" "${1-}" ;;
	target-path) install_target_path "${1-}" "${2-}" ;;
	check-writable) install_check_writable "${1-}" "${2-}" ;;
	place-skills) install_place_skills "$@" ;;
	detect) install_detect "${1-}" "${2-}" ;;
	install-all) install_install_all "${1-}" ;;
	migrate-signal) install_migrate_signal "${1-}" ;;
	skills-path) install_skills_path "${1-}" "${2-}" ;;
	*) install_die 64 "unknown verb: $verb (known: render, install, uninstall, migrate, migrate-signal, doctor, prove, place-gate, gate-path, target-path, check-writable, place-skills, skills-path, detect, install-all)" ;;
	esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	install_main "$@"
	exit $?
fi
