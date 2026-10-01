#!/usr/bin/env bash
# goal-folder-path.sh — normative resolver for the X.goal/ folder-layout contract.
#
# Contract: {skills-root}/eque2-code-prepare-goal/references/goal-folder.md
#
# Usage:
#   goal-folder-path.sh [--ensure] <idea-document-path>
#
# Prints the absolute path of the goal folder for the given idea document and
# exits 0. On ANY problem it prints a `goal-folder:` diagnostic to stderr and
# exits non-zero — an unknown never resolves to a usable path.
#
# Exit codes:
#   0  resolved (and, with --ensure, the directory exists and is writable)
#   2  invalid input (empty, missing extension, not .md, reserved .goal stem)
#   3  input does not exist, or is not a regular file
#   4  collision: the target X.goal exists but is not a directory
#   5  filesystem failure (unresolvable parent, mkdir refused, not writable)
#   64 usage error

goal_folder_die() {
	local code="$1"
	shift
	printf 'goal-folder: %s\n' "$*" >&2
	return "$code"
}

# goal_folder_path <idea-document-path>
#
# Pure resolution: no filesystem mutation. Echoes the absolute goal-folder path.
goal_folder_path() {
	local doc="${1-}"
	local parent stem base real_parent

	# --- Empty/Null -------------------------------------------------------
	if [ -z "$doc" ]; then
		goal_folder_die 2 "empty idea-document path" || return
	fi

	# --- Must be an existing regular file (a directory is not an idea doc) --
	if [ -d "$doc" ]; then
		goal_folder_die 3 "is a directory, not an idea document: $doc" || return
	fi
	if [ ! -e "$doc" ]; then
		goal_folder_die 3 "no such idea document: $doc" || return
	fi
	if [ ! -f "$doc" ]; then
		goal_folder_die 3 "not a regular file: $doc" || return
	fi

	base="$(basename -- "$doc")"

	# --- Invalid input: no extension / wrong extension --------------------
	case "$base" in
	*.*) : ;;
	*) goal_folder_die 2 "idea document has no extension: $base" || return ;;
	esac
	case "$base" in
	*.md) : ;;
	*) goal_folder_die 2 "idea document is not a .md file: $base" || return ;;
	esac

	# Strip ONLY the final extension: a.b.md -> a.b
	stem="${base%.md}"

	if [ -z "$stem" ]; then
		goal_folder_die 2 "idea document has an empty stem: $base" || return
	fi

	# Degenerate stems ('.' from '..md', '..' from '...md') would name a folder
	# that reads as a traversal segment. Rejected outright.
	case "$stem" in
	. | ..) goal_folder_die 2 "degenerate idea-document stem: $base" || return ;;
	esac

	# --- Boundary: a document already named X.goal.md ---------------------
	# Deriving X.goal.goal/ would be ambiguous with an existing goal folder,
	# so the .goal stem suffix is reserved and rejected outright.
	case "$stem" in
	*.goal) goal_folder_die 2 "reserved '.goal' stem, refusing to derive a nested goal folder: $base" || return ;;
	esac

	# --- Security boundary: resolve the parent physically -----------------
	# `..` segments are collapsed against the document's REAL directory, so the
	# result is always a sibling of the document and can never escape it.
	parent="$(dirname -- "$doc")"
	if ! real_parent="$(cd -- "$parent" 2>/dev/null && pwd -P)"; then
		goal_folder_die 5 "cannot resolve parent directory: $parent" || return
	fi
	if [ -z "$real_parent" ]; then
		goal_folder_die 5 "cannot resolve parent directory: $parent" || return
	fi

	printf '%s/%s.goal\n' "${real_parent%/}" "$stem"
}

# goal_folder_ensure <idea-document-path>
#
# Resolves, then guarantees the goal folder exists as a writable directory.
goal_folder_ensure() {
	local target
	target="$(goal_folder_path "${1-}")" || return

	if [ -e "$target" ] && [ ! -d "$target" ]; then
		goal_folder_die 4 "collision: exists but is not a directory: $target" || return
	fi

	if [ ! -d "$target" ]; then
		if ! mkdir -- "$target" 2>/dev/null; then
			goal_folder_die 5 "cannot create goal folder (parent unwritable?): $target" || return
		fi
	fi

	if [ ! -w "$target" ]; then
		goal_folder_die 5 "goal folder is not writable: $target" || return
	fi

	printf '%s\n' "$target"
}

goal_folder_main() {
	local ensure=0

	while [ "$#" -gt 0 ]; do
		case "$1" in
		--ensure)
			ensure=1
			shift
			;;
		-h | --help)
			sed -n '2,20p' "$0"
			return 0
			;;
		--)
			shift
			break
			;;
		-*)
			goal_folder_die 64 "unknown option: $1" || return
			;;
		*) break ;;
		esac
	done

	if [ "$#" -ne 1 ]; then
		goal_folder_die 64 "usage: goal-folder-path.sh [--ensure] <idea-document-path>" || return
	fi

	if [ "$ensure" -eq 1 ]; then
		goal_folder_ensure "$1"
	else
		goal_folder_path "$1"
	fi
}

# Only run when executed, not when sourced by the test suite. `set -e` is scoped
# to execution so that sourcing this file never changes the caller's shell mode.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -euo pipefail
	goal_folder_main "$@"
fi
