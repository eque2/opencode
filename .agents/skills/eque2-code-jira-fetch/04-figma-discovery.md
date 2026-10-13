Language: {communication_language}
Output Location: {feature_artifacts}/{TICKET-KEY}/

# Stage 4: Figma Discovery

**Progress: Stage 4 of 6** — Next: Figma Fetch (conditional)

Scan ticket data for Figma URLs. Present results. Wait for the user's explicit decision.

## Critical Rule

Never auto-skip this stage. The user must explicitly choose to continue or skip.

## Sequence

### 1-4. Discover, validate, dedupe — delegate to script

```
uv run scripts/jf-discover-figma.py {feature_artifacts}/{TICKET_KEY}/jira/
```

The script loads patterns from `data/figma-url-patterns.md`, scans `ticket.json` (and `ticket.md` when present), extracts file IDs / node IDs / source attribution, validates IDs against `^[a-zA-Z0-9]{15,22}$`, deduplicates by `(file_id, node_id)` with a "richer metadata wins" tie-breaker, and returns structured JSON:

```json
{
  "status": "ok",
  "urls": [{"url": "...", "node_id": "...", "source": "description"|"comment_N"|"custom_field"}],
  "duplicates_removed": N,
  "count": M
}
```

The script is the source of truth — its output drives the menu in step 5. Do not re-run jq or regex passes in the prompt; the script captures the determinism cleanly.

### 5. Present Results (mandatory)

**No links found:**
```
[M] Manual - Provide Figma URL(s)
[S] Skip - Skip Figma fetch entirely
[A] Abort
```

**Links found:**
```
[C] Continue - Fetch all discovered designs
[M] Add more - Additional Figma URLs
[S] Skip - Skip Figma fetch entirely
```

**Halt. Wait for selection.**

### 6. Pre-Validate Links (optional)

HEAD requests to confirm accessibility. Report the rate-limit impact before proceeding.

### 7. Update Progress State

Set `checkpoints.figma_discovery = "complete"`. Store discovered links and skip flag.

## Progression Condition

- `figma_skip = false` AND links exist — proceed to `05-figma-fetch.md`.
- `figma_skip = true` OR no links — skip to `06-output.md`.
