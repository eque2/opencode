Language: {communication_language}
Output Location: {feature_artifacts}/{TICKET-KEY}/figma/

# Stage 5: Figma Fetch (Conditional)

**Progress: Stage 5 of 6** — Next: Output Generation

Runs only when Stage 4 found links and the user did not skip.

## Three-Phase Fetch Per Design

### Phase 1: REST API (Bash Script)

Run `scripts/fetch-figma-design.sh {fileKey} {nodeId} {designFolder}` with `FIGMA_TOKEN`.

Expected artifacts: `README.md`, `screenshot.png`, `node-data.json`, `file-metadata.json`, `styles.json`, `components.json`, `image-urls.json`. Verify by listing the folder.

- 403 — **Blocker** (token invalid). Abort.
- 404 — **Surface** (file not found). Skip this design, continue with the rest.

### Phase 2: Effects Extraction (Python)

Run `python3 scripts/extract-figma-effects.py {nodeDataPath} {effectsPath}`.

Non-critical. On failure — **surface** the warning, write an empty `effects.json` with an error marker, continue.

### Phase 3: MCP Design Markup (Optional)

- Call `mcp__figma__get_design_context` for JSX/HTML markup. Save as `design.jsx`.
- Call `mcp__figma__get_variable_defs` for design tokens. Save as `tokens-mcp.json`.
- Save metadata to `design-context-mcp.json`.

MCP is optional. If unavailable, the REST API output and effects are sufficient — record the gap and move on.

### Per-Design Output

Write `SUMMARY.md` in each design folder with file inventory and usage notes.

### Summary

Verdict-first per design: REST API files written, effects count, MCP success/skip. Update `.progress.json`.

## Progression Condition

Auto-proceed to `06-output.md`.
