# Live registration evidence — T3.4

Recorded **2026-07-19**. This is what settles assumption **A1**: not that the
registration was *written*, but that the gate actually **fired** under each
agent and that its decision was **honoured**.

Writing configuration is half of installing. These runs are the other half.

Reproduce with `GOAL_GATE_LIVE=1 bash tests/test-live-registration.sh`.

---

## Claude Code — the full loop, end to end

A real `claude -p` session in a scratch project at `/tmp/gg-live/claude-live`,
with the gate registered **project-scoped** (`.claude/settings.json`) via a
wrapper that bounded the run at three iterations. One outstanding criterion:
create `DONE.txt` containing `ping`.

Recorded in `claude-loop-state.txt`:

| Observation | Field | Meaning |
|---|---|---|
| the gate fired | `claimed_at`, `claim_event=existing` | the claim handshake ran on a real turn end |
| **a refusal continued the conversation** | `iteration=3` | the session was blocked twice and kept working — this is the property under test |
| the work was really done | `DONE.txt` contained `ping` | the agent satisfied the criterion rather than declaring it satisfied |
| evidence was enforced | `acs_ticked_without_evidence=0` | the tick carried a substantive `- evidence:` line |
| the permit was earned | `acs_verdict=done`, `decision=permitted` | both evaluators agreed, and only then did the session end |
| the permit was recorded | `completion-record.md` | see `claude-completion-record.md` |

The session then ended normally (exit 0). So the gate blocked while work was
outstanding, permitted when it was not, and the host honoured both decisions.

## Codex — fires, but ONLY once trusted

Two real `codex exec` runs against `codex-cli 0.144.5`, same registration
shape, in a fixture `CODEX_HOME`.

| Run | Result |
|---|---|
| default | **The hook did not fire.** Session completed normally, **exit 0**, no error, no warning, nothing on stderr. Silent skip. |
| `--dangerously-bypass-hook-trust` | Fires. Codex prints `hook: Stop` / `hook: Stop Completed`; the hook ran and received a payload. |

**This is the operational fact the whole feature turns on.** An installer that
only wrote the registration would have reported success over a completely inert
gate, under an agent where nothing is blocking and nothing says so. It is why
"prove it fires" is a separate task from "install it".

Trust is persisted in `~/.codex/config.toml` as
`[hooks.state."<id>"] trusted_hash = "sha256:…"`. The one such entry on this
machine was written by a **plugin**-installed hook
(`warp@codex-warp:hooks/hooks.json:permission_request:0:0`) — which is the
concrete reason the packaging section prefers the plugin route: it is the
sanctioned path to trust, rather than shipping users a dangerous override flag.

### The payload shape — Codex carries BOTH identities

`codex-stop-payload.json` is a verbatim Codex `Stop` payload. It carries
`session_id` **and** `turn_id`, plus `cwd`, `transcript_path`,
`hook_event_name` and `stop_hook_active`.

This is the shape the charter amendment (owner decision 4) was written
against, and it holds. Two consequences worth naming:

1. **Binding is safe.** `session_id` is stable across turns under both agents,
   so a workstream bound to it stays bound. `turn_id` changes every turn and is
   not an identity to bind to.
2. **A mislabelling this run exposed — since FIXED.** The gate's agent detection
   tried `session_id` first, so a Codex payload was *labelled* `claude` in the
   loop file's `agent` field and in the run log. Nothing behavioural depended on
   the label, but a run log that misnames the agent misleads whoever reads it
   next. `turn_id` is the discriminating field — Claude payloads carry no
   `turn_id` — and `goal-gate-stop.sh` now tests it first. Recorded here because
   this payload is what found it.

---

## P5 — the packaged plugin, installed and fired under Codex

**2026-07-20.** The plugin was installed through the real route —
`codex plugin marketplace add` then `codex plugin add` — into a fixture
`CODEX_HOME`, and driven with a real `codex exec` session.

### It fires, and it blocks

`codex-plugin-loop-state.txt` is the loop file from that run:

| Observation | Field |
|---|---|
| the gate fired and claimed the workstream | `claimed_at`, `iteration=2` |
| **a refusal continued the session** | Codex printed `hook: Stop Blocked` |
| the work was really done | `DONE.txt` contained `pong` |
| evidence was enforced | `acs_ticked_without_evidence=0` |
| the permit was earned, then recorded | `acs_verdict=done`, `decision=permitted`, `status=complete` |

So the whole mechanism works under Codex, from a plugin, end to end.

### Two things this run CORRECTED

**1. Installing the plugin does NOT confer hook trust.** The packaging plan
assumed the plugin was "the legitimate route to Codex trust". It is not. The
first run — plugin installed and enabled, project trusted — ended with
`iteration=0`, no claim, exit 0, and no warning. No `[hooks.state]` entry was
written by `plugin add`. The gate fired only with
`--dangerously-bypass-hook-trust`.

The §6 finding therefore stands unchanged and unmitigated by packaging: **a
Codex user must grant hook trust separately, and until they do the gate is
silently inert.** Anything that ships this must say so rather than assume the
plugin route solved it.

**2. Symlinked skills do not survive installation.** The plugin tree originally
made `skills/` symlinks into the checkout, so drift was structurally impossible.
`codex plugin add` copies the tree; the links did not survive; the installed
plugin's `skills/` was **empty**; and its hook entry point exited 127 with
nothing on stdout — which **fails open**. A perfect-looking install, completely
inert, in the one place this feature must never be.

The tree now ships real files, `verify` refuses a symlink and reports drift
against the checkout, and — the check that would actually have caught this —
`verify` now EXECUTES the hook entry point rather than checking that files sit
next to it.

This is exactly what the packaging plan predicted of P5: *"the only one that
proves anything. The rest is file layout. A perfect install can be completely
inert."*

### And one thing it SETTLED

`hooks/hooks.json` — carrying **`${CLAUDE_PLUGIN_ROOT}`** — is the manifest
Codex read, and the hook launched from it. So **one manifest serves both hosts**
and the `${PLUGIN_ROOT}` divergence recorded as an open question is not required
in this Codex version. `hooks.codex.json` is still built, as a cheap hedge
against other versions, but it is not what fired here.

## What these runs do NOT prove

- Nothing here exercises a **user-global** registration. Both used a scoped
  configuration deliberately, so no shared machine config was modified.
- **Codex trust is still bypassed, not persisted.** P5 settled that packaging
  does not solve this: making the gate fire under Codex with no override flag
  remains open, and is now known to need a trust step of its own rather than a
  better install route.
- Nothing here proves Codex DISCOVERS the shipped skills. The plugin run's agent
  went looking for `pursue-goal.sh` at a workspace path and reported it missing,
  so skill discovery from a plugin under Codex is unverified.
