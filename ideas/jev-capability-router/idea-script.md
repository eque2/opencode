# Jev capability router — demo script (draft for review)

Companion to `idea.md`. This is the script for the clickable HTML demo. Review it
before the demo is built.

## The idea in one paragraph

Before each turn, opencode sends the user's prompt to Jev (TypeSafe's System One
model) with **one Score question per capability**: every built-in tool and every
skill. Each capability gets an independent relevance score on a 0–2 scale. Code
keeps the capabilities above a threshold. Only those tool definitions and skill
entries reach the main model. Score, not Choice, because one prompt often needs
several capabilities at once.

## What it replaces (measured in this repo)

| Context block | Source | Size |
|---|---|---|
| `<available_skills>` index | 85 project skills (`.claude/skills/`, `.opencode/skills/`) + built-in `customize-opencode` | ≈ 27k chars ≈ 6.8k tokens |
| Built-in tool definitions | `packages/opencode/src/tool/*.txt` + `shell/shell.txt` + JSON schemas | ≈ 16k chars of text ≈ 5k tokens with schemas |
| MCP tools | none configured in `.opencode/opencode.jsonc` | 0 |

Baseline: about **12k tokens** of capability text in every request, before the
user says a word. Token figures are chars ÷ 4 estimates.

## The roster (real descriptions, as Jev sees them)

Jev gets the first paragraph of each tool description and the full `description`
frontmatter of each skill. The demo shows these 18; the other 78 skills are
scored too and shown as one collapsed row.

### Tools

| ID | Description (verbatim, first paragraph) | Source |
|---|---|---|
| `bash` | Executes a given bash command with optional timeout, ensuring proper handling and security measures. … This tool is for terminal operations like git, npm, docker, etc. | `tool/shell/prompt.ts:237`, `shell/shell.txt` |
| `read` | Read a file or directory from the local filesystem. If the path does not exist, an error is returned. | `tool/read.txt` |
| `glob` | Fast file pattern matching tool that works with any codebase size. Supports glob patterns like "**/*.js" or "src/**/*.ts". | `tool/glob.txt` |
| `grep` | Fast content search tool that works with any codebase size. Searches file contents using regular expressions. | `tool/grep.txt` |
| `edit` | Performs exact string replacements in files. | `tool/edit.txt` |
| `write` | Writes a file to the local filesystem. | `tool/write.txt` |
| `task` | Launch a new agent to handle complex, multistep tasks autonomously. | `tool/task.txt` |
| `webfetch` | Fetches content from a specified URL. Takes a URL and optional format as input. | `tool/webfetch.txt` |
| `todowrite` | Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user. | `tool/todowrite.txt` |
| `question` | Use this tool when you need to ask the user questions during execution. | `tool/question.txt` |

Not scored: `skill` (kept when any skill is kept) and `invalid` (always kept; the
tool-call repair falls back to it, `session/llm.ts:296-303`).

### Skills

| Name | Description (verbatim) |
|---|---|
| `effect` | Work with Effect v4 / effect-smol TypeScript code in this repo |
| `rtl-aware-development` | OpenCode Desktop should be RTL-aware. Use when implementing or reviewing RTL/LTR behavior in the web app, desktop app, CSS, menus, scrolling, resizing, icons, mixed-direction text, or Electron title bars. |
| `customize-opencode` | Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. … |
| `eque2-code-bug-fix` | Fix a bug the disciplined way — reproduce it, write a test that fails for the right reason, fix it, and confirm the full suite stays green. Use when the user selects [BF], says 'fix this bug', 'BF <ticket>', or hands over a bug report. |
| `eque2-code-jira-fetch` | Fetches comprehensive Jira ticket data with related tickets and Figma discovery. Invoked by Linus when the user selects [JF] or requests a Jira fetch. |
| `eque2-code-review` | Reviews local changes against the repo's styleguide review rules. Use when the user selects [RV], says 'review my changes', 'run the code review locally', or 'review against the styleguides'. |
| `bmad-code-review` | Review code changes with several independent reviewers in parallel, then triage and present the findings. Use when the user says "run code review" or "review this code" |
| `eque2-code-create-pr` | Open a pull request — enforce the repo's review-rules on the diff, confirm the suite is green, sync with the base branch, commit, push, and open the PR. Stops at an open PR (no auto-merge). Use when the user selects [PR], says 'open a PR', … |

## The Jev request (one per user prompt)

```ts
import { score, TypeSafeClient } from "@typesafe-ai/sdk"

const LEVELS = [
  "Not needed: the agent can reply without it",
  "Might help: useful for a likely next step, not the first one",
  "Needed: the agent cannot do what was asked without it",
]

const response = await jev.systemOne({
  model: "jev-1.13.0", // pinned: thresholds are tuned per version
  state: {
    latest_message: "session titles come out blank when …",
    recent_turns: "User asked how Effect.gen differs from pipe; agent explained.",
    used_last_turn: ["read", "glob"],
  },
  questions: Object.fromEntries(
    roster.map((cap) => [
      cap.id, // ids are not sent to the model
      score(
        {
          capability: { name: cap.id, kind: cap.kind, description: cap.description },
          question: "How much does the agent need `capability` to act on `latest_message`?",
        },
        LEVELS,
      ),
    ]),
  ),
})
```

- 96 questions in one request. Jev evaluates them in parallel.
- Budget: about 12k input tokens per call ≈ $0.0005, about 100–200 ms.
- Keep rule: `score >= 0.8` → keep. Tools used in the last 2 turns stay kept
  ("sticky"). Every confidence below 0.4 → keep the full roster (fail open).

---

## The conversation (8 turns)

Scores are scripted for the demo. They are not real Jev output.

### Turn 1 — orientation

> **User:** what does this repo do, in two sentences?

| Capability | Score | Kept |
|---|---|---|
| `read` | 1.82 | ✅ |
| `glob` | 1.21 | ✅ |
| `grep` | 0.41 | — |
| all others | < 0.2 | — |

**Context:** 2 tools, 0 skills → ≈ 0.6k tokens (was ≈ 12k).
**opencode:** reads `README.md` and `AGENTS.md`, answers in two sentences.
**Callout:** a simple question pays only for the tools it uses.

### Turn 2 — a skill and no tools

> **User:** remind me how `Effect.gen` differs from `pipe` with `flatMap`.

| Capability | Score | Kept |
|---|---|---|
| skill `effect` | 1.64 | ✅ (+ `skill` tool) |
| `read` | 0.52 | sticky ✅ |
| `glob` | 0.18 | sticky ✅ |
| all others | < 0.2 | — |

**opencode:** calls `skill({ name: "effect" })`, answers with a short example.
**Callout:** Jev picks a skill with no new tool. The `skill` tool rides along
because a skill was kept.

### Turn 3 — a bug report, many hits at once

> **User:** session titles come out blank when the first message is only an
> image. Find where titles get generated and fix it.

| Capability | Score | Kept |
|---|---|---|
| `grep` | 1.91 | ✅ |
| `read` | 1.88 | ✅ |
| skill `eque2-code-bug-fix` | 1.81 | ✅ |
| `edit` | 1.74 | ✅ |
| `bash` | 1.12 | ✅ |
| skill `effect` | 0.97 | ✅ |
| `todowrite` | 0.84 | ✅ |
| `task` | 0.52 | — |
| all others | < 0.3 | — |

**opencode:** loads `eque2-code-bug-fix`, greps to `title()` in
`packages/opencode/src/session/prompt.ts:240`, writes a failing test, then fixes
the image-only case.
**Callout:** this is why Score beats Choice. Seven capabilities pass at once. A
Choice would pick one.

### Turn 4 — a follow-up that needs history

> **User:** run the tests for that package.

| Capability | Score | Kept |
|---|---|---|
| `bash` | 1.96 | ✅ |
| `read` | 0.88 | ✅ |
| `edit`, `grep`, skill `eque2-code-bug-fix` | < 0.5 | sticky ✅ |
| all others | < 0.2 | — |

**opencode:** runs `bun test` in `packages/opencode`, reports the new test green.
**Callout:** "that package" resolves because `recent_turns` carries a one-line
summary.

### Turn 5 — a workflow skill in place of an MCP server

> **User:** pull CMC-4410 from Jira. What does it say about right-to-left layouts?

| Capability | Score | Kept |
|---|---|---|
| skill `eque2-code-jira-fetch` | 1.90 | ✅ |
| skill `rtl-aware-development` | 1.37 | ✅ |
| `webfetch` | 0.41 | — |
| all others | < 0.2 | — |

**opencode:** loads `eque2-code-jira-fetch`, fetches CMC-4410, summarises the RTL
acceptance criteria against `rtl-aware-development`.
**Callout:** two skills from different domains pass together.

### Turn 6 — two skills that overlap

> **User:** review my changes before I ship them.

| Capability | Score | Kept |
|---|---|---|
| skill `eque2-code-review` | 1.78 | ✅ |
| skill `bmad-code-review` | 1.69 | ✅ |
| `bash` | 1.05 | ✅ |
| `read` | 0.92 | ✅ |
| all others | < 0.3 | — |

**opencode:** sees two review skills, picks `eque2-code-review` ("review my
changes" is its trigger phrase), runs it.
**Callout:** Score shows that two real skills compete. The main model breaks the
tie with the full descriptions in front of it, not with an 86-skill index.

### Turn 7 — an ambiguous prompt, the safety net

> **User:** make it nicer.

| Capability | Score | Confidence |
|---|---|---|
| `edit` | 0.94 | 0.31 |
| `question` | 0.90 | 0.28 |
| skill `rtl-aware-development` | 0.71 | 0.25 |
| every capability | — | < 0.4 |

**Router:** every confidence is below 0.4 → keep the full roster.
**opencode:** asks one question: "The RTL layout, or the title fix?"
**Callout:** when Jev is unsure, the router fails open. A miss costs one turn at
the old context size, not a missing tool.

### Turn 8 — ship it

> **User:** looks good, open a PR.

| Capability | Score | Kept |
|---|---|---|
| skill `eque2-code-create-pr` | 1.89 | ✅ |
| `bash` | 1.71 | ✅ |
| skill `eque2-code-review` | 0.62 | sticky ✅ |
| all others | < 0.3 | — |

**opencode:** loads `eque2-code-create-pr`, commits, pushes, opens the PR.
**Summary panel:** 8 turns. Mean capability context ≈ 1.9k tokens (was ≈ 12k).
8 Jev calls, ≈ 140 ms each, total ≈ $0.004.

---

## Where it plugs into opencode

Paths are under `packages/opencode/src/`.

| Option | Where | How |
|---|---|---|
| **A. Plugin, tools** (no fork) | `chat.message` hook, fired in `session/prompt.ts:1037-1047` | Score the prompt, then set `output.message.tools = { grep: false, … }`. The hook runs before the user message is saved, so the filter holds for every step of the turn. |
| **A. Plugin, skills** (no fork) | `experimental.chat.system.transform`, `session/llm/request.ts:68` | Strip `<skill>` blocks that Jev did not keep from the system string. Brittle: string surgery on XML. |
| **B. Fork, tools** | `session/llm/request.ts:210-216` `resolveTools` | The single choke point that every provider path uses. Add a router allow-set next to the `user.tools` check. |
| **B. Fork, skills** | `session/system.ts:110-122` `SystemPrompt.skills` | Pass the kept set into `skill.available(agent)`. The only place skill descriptions reach the model. |
| Secondary-model pattern to copy | `session/prompt.ts:240-300` `title()` | Already calls a small model beside the main call. The router follows the same shape, but blocks. |

Recommendation for the demo code: show option A (a ~60-line plugin). Name option B
as the production path.

## Open questions for review

1. **Prompt cache.** Anthropic caches the prefix in the order tools → system →
   messages. A tool set that changes per turn invalidates that cache. The sticky
   rule reduces churn but does not remove it. TypeSafe's own skill-suggestion
   cookbook keeps the full roster and adds a one-line hint for this reason.
   Filter, hint, or show both modes in the demo?
2. **Mid-turn gaps.** The filter holds for the whole turn. If the model needs a
   dropped tool in step 4, it cannot get it. Add a `capability_request` escape
   tool, like deferred-tool search in Claude Code?
3. **Old tool calls.** Earlier messages can hold calls to a tool that is now
   dropped. Some providers reject that (see the Copilot `_noop` workaround at
   `session/llm/request.ts:158-174`).
4. **Threshold.** `0.8` on a 0–2 scale is a guess. A real value needs a labelled
   prompt set.
