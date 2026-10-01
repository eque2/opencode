# Stage 1 — Intake

Goal: turn whatever the user handed you into a concrete bug report and a stable `{slug}` the rest of the workflow uses.

## Classify the argument

Take the `BF <arg>` argument (strip a leading `@` if present):

- **Jira key** (`^[A-Z][A-Z0-9_]*-\d+$`, e.g. `PROJ-123`):
  - Offer to chain [JF]: "This looks like a Jira ticket — want me to pull it with [JF] first so I have the full context? (recommended)". If yes, invoke `eque2-code-jira-fetch` with the key via the Skill tool, then read the resulting `ticket.md` as the bug report. If no, ask the user to paste the relevant detail.
  - `{slug}` = the lowercased ticket key (e.g. `proj-123`).
- **File path** (exists and readable): read it as the bug report. `{slug}` = a short kebab-case slug derived from the filename or the bug's one-line summary.
- **Free text**: treat it as the bug report inline. `{slug}` = a short kebab-case slug (≤ 5 words) of the symptom.
- **No arg**: ask the user to describe the bug. Then derive `{slug}` as above.

## Pin down the report

Before moving on, you need three things — ask only for what's missing:

1. **Symptom** — what actually goes wrong (error, wrong output, crash, hang)?
2. **Reproduction** — the steps, input, or conditions that trigger it. If the user can't give exact steps, say so and note it as a risk — reproduction is Stage 2's job and an un-reproducible report is a yellow flag, not a blocker.
3. **Expected vs actual** — what should happen instead.

Do **not** start theorising about the fix yet. Resist proposing a root cause until you've reproduced it in Stage 2 — premature diagnosis is how the wrong bug gets fixed.

## Move the ticket to "In Progress" (Jira flow only — ask first)

Run this **only when the arg was a Jira key** and the Atlassian MCP is available — it's the "Jira flow". Skip it entirely for file-path, free-text, or no-arg reports. Never transition a ticket silently.

1. **Resolve the target status.** Read BOND.md's "Their Jira Workflow" → *"In progress" status*. If the sanctum isn't loaded or that field is unset, you have no recorded target — go to the discovery prompt in step 3.
2. **Read the ticket's state.** Call `getTransitionsForJiraIssue` for the key to get the current status and the transitions actually available from it.
3. **Ask before moving:**
   - Recorded target found **and** offered as a transition: _"`PROJ-123` is in **{current}**. Want me to move it to **{in-progress}** while I work the fix? (y/n)"_
   - No recorded target, or it isn't an available transition from the current status: _"`PROJ-123` is in **{current}**. Available moves: {list}. Move it on (which?), or leave it?"_ — and if they pick one, offer to remember it in BOND.md's "In progress" status for next time.
   - **No transitions available at all** (e.g. the ticket is closed/terminal): say so in one line — _"`PROJ-123` is **{current}** with no available transitions — leaving it as is."_ — and skip. Never render an empty "Available moves:" list.
   - Already sitting in the in-progress status: skip silently.
4. **On confirmation**, apply it with `transitionJiraIssue`. On decline or skip, proceed unchanged.
5. **Never let this block the fix.** If the MCP is unavailable or the transition is rejected, surface a one-line note and carry on — the bug fix is the job; the status flip is a courtesy.

## Output of this stage

- A captured bug report (symptom / repro / expected-vs-actual).
- A `{slug}`.
- Test-setup knowledge either loaded from BOND.md or flagged as "discover from repo" (per the activation gate).
- In the Jira flow: the ticket either moved to the in-progress status (with the user's OK) or left untouched.

Proceed to `02-reproduce.md`.
