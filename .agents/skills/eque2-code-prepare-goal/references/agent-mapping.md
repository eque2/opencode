# Agent mapping — running this skill (and its charter) under any agent

This skill is **agent-agnostic**. The whole procedure — the approval
gate, the worktree move, the evidence-gated spec, the charter and
acceptance-contract emit, the adversarial contract review — is a set of
OUTCOMES, not slash-commands. Only the *invocation sugar* differs
between agents.

**The one idea that makes it portable:** the contract is neutral. The
SPEC, the eque2-code state machine, the signed evidence log, the
`STATE.md`, the journal, and the `/goal`-style Done-when checklist are
plain files and CLI scripts that any agent can produce and read. What
changes per agent is only *how you invoke* the workflow that produces
them. When a Claude Code skill named below is not installed (e.g. you
are Codex), you do not abandon the outcome — you **drive the underlying
CLI scripts directly, following the same procedure**. The evidence gate
is enforced by the scripts, not by the agent, so the safety travels.

## The CLI substrate is already agent-neutral

eque2-code's state, tests, and Xray gates are plain Node scripts invoked
directly — no MCP server, no Docker, no Claude-only wiring:

- `.claude/skills/eque2-code-setup/scripts/state.mjs` — state machine
  (`init` / `update` / `verify` / `done`, `query`), signed plaintext
  event log, HMAC verify-at-read.
- `.claude/skills/eque2-code-setup/scripts/tests-cli.mjs` — test
  lifecycle gate (`building → awaiting_verification → verified_passing`).
- `.claude/skills/eque2-code-setup/scripts/xray-cli.mjs` — Xray
  conformance.

Run them with Node (per repo convention, the bundled `state.mjs` run with
`node`, not `npx tsx`). Any agent — Claude, Codex, a CI runner — drives
these the same way. **This is the floor the agnosticism stands on:** even
with zero Claude skills installed, an agent that can run Node and read
files can execute the evidence-gated build.

## Mechanism map

For each capability the phases call for, here is the Claude Code
invocation and the Codex (or any-other-agent) equivalent. When you are
not Claude Code and no equivalent prompt is installed, use the
**"follow the procedure via"** column — it is always available.

| Capability | Claude Code | Codex / other agent |
|---|---|---|
| **Workflow discovery** (what's installed today) | `/bmad-help` | Read `_bmad/_config/bmad-help.csv` directly (same file `/bmad-help` reads) + scan installed prompts/skills. |
| **Run journal** (read at start, write per phase) | `journal` skill: `/journal read <slug>`, `/journal write <slug>`, `/journal state <slug>` | Installed `journal` Codex prompt if present; else read/append the journal files under `<goal-folder>/journal/` and refresh `<goal-folder>/STATE.md` by hand, keeping the same entry shape. |
| **Evidence-gated spec** (create-spec / `[CS]`) | `eque2-code-create-spec` (`[CS]`), or headless `/eque2-code-agent-linus --headless:create-spec-from-prose <file>` | Follow the create-spec procedure driving `state.mjs init` + `tests-cli.mjs` directly (or an installed Codex create-spec prompt). Produces the same SPEC + `definitions.json` + state folder. |
| **Evidence-gated build** (develop-spec / `[DS]`) | `eque2-code-develop-spec` (`[DS]`), or `/eque2-code-agent-linus --headless:develop-spec <slug>` | Drive the state+tests CLI build-verify loop directly — or an installed Codex develop-spec prompt. **This is downstream, not this skill's job.** |
| **Drive-to-done autonomous loop** | `pursue-goal <folder>` — ONE mechanism, TWO registrations | The same `pursue-goal <folder>`. The goal-gate stop hook is registered per agent (`$HOME/.claude/settings.json` vs `$CODEX_HOME/hooks.json`); the hook object and its payload fields are identical. **Under Codex, `pursue-goal` skips every hook check** (run it with `GOAL_GATE_AGENT=codex`). Do not register, trust, or prove the Codex hook; the agent drives the criteria to done itself. |
| **Research** | `bmad-deep-recon` (technical / domain / market types) | Same-named Codex prompt if installed; else `WebSearch` + `context7` (both MCP, available to Codex too) and write the report to `<goal-folder>/research/`. |
| **Adversarial contract review** (Phase R) | `bmad-code-review` + `bmad-review` (adversarial and edge-case-hunter lenses) | Run the three review lenses (Blind Hunter / Edge Case Hunter / Acceptance Auditor) as an adversarial pass over the SPEC + story/task list by hand or via installed equivalents; the lenses are a method, not a tool. |
| **Doc refresh** (when the plan binds it) | `bmad-project-context` | Installed equivalent, or refresh the project's AI-context docs in place following the same brownfield-refresh procedure. |
| **Sub-skill / workflow invocation** generally | `Skill` tool / `/skill-name` | `~/.codex/prompts/<name>.md` if installed; else follow the named skill's own procedure. |

## The emitted charter is agent-neutral too

The charter this skill writes is consumed by *some* downstream agent —
possibly a different one from the agent that prepared it. So the charter
never assumes Claude Code:

- **Done-when checklist** — already portable. Markdown checkboxes in
  `X.goal/ACs.md`, each tick carrying its evidence; the same gate reads
  them under either agent, and a human can read them unaided.
- **The distilled one-line condition** — natural language, not a command.
  It states what done means; `pursue-goal` is what drives it.
- **Build-via directive** — names the evidence-gated mechanism and carries
  a one-line agent note: *"Claude Code: run `[DS]` develop-spec. Other
  agents: drive the state + tests CLI build-verify loop directly per
  `references/agent-mapping.md`."* The enforcement / switch-off clause is
  about the *pipeline*, not the agent, so it stays verbatim regardless of
  who runs it.

When you stamp the charter (see `references/emitted-charter.md`), include
that one-line agent note beside each Claude-Code command so a downstream
Codex run does not stall looking for a slash-command it doesn't have.
