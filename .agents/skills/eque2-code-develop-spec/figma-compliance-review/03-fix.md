Language: {communication_language}

# Stage 3: Fix and Verify

## Rules

- **Figma is source of truth** — fixes must match Figma exactly.
- **Structural fixes first** — fix Layer 2 before Layer 3. Fixing structure often resolves property issues.
- **Token discipline** — search existing tokens before creating new ones. Never use inline literal values.
- **Bounded retry** — maximum 2 fix-measure cycles.
- **Preserve functionality** — fixes must not break behaviour or tests.

## Sequence

### 1. Fix Cycle 1

**Structural discrepancies (Layer 2) first:**

| Discrepancy | Fix |
|-------------|-----|
| `CONTAINMENT_VIOLATION` | Move element to correct parent in template |
| `SIBLING_ORDER_VIOLATION` | Reorder elements to match Figma `children[]` order |
| `CHILD_COUNT_MISMATCH` | Add missing or remove unexpected elements |
| `BOUNDING_BOX_MISMATCH` | Adjust stylesheet (width/height/flex properties) or fix parent layout for position issues |
| `ELEMENT_EXTRA` | Restructure HTML so extras don't affect flex/grid layout |
| `FLEX_LINE_WRAP` | Fix total widths, remove unexpected `flex-wrap: wrap` |
| `ELEMENT_NOT_FOUND` | Add to template or fix mapping; mark unfixable if beyond scope |

**Property discrepancies (Layer 3) after structural:**

- **Colours:** search existing tokens first. If found, use it. If not, create per figma-standards Section 1 naming conventions.
- **Fonts:** use typography mixins/tokens if available. Create if needed.
- **Spacing:** fix padding, margin, gap using spacing tokens or exact pixel tokens.
- **Shadows/effects:** check `effects.json`, create or reuse shadow token.
- **Opacity, border-radius, border:** fix directly using tokens where applicable.

### 2. Re-measure after Cycle 1

Re-run all three verification layers. Categorise: Fixed / Still failing / New discrepancy.

### 3. Fix Cycle 2 (only if needed)

Apply same logic. Watch for cascade effects — prefer specific selectors over `!important`.

### 4. Final measurement

Run all three layers. Capture final screenshot. Build definitive list: Resolved vs Remaining. Document why remaining items couldn't be fixed.

### 5. Prepare fix summary

Compile:
- Total discrepancies by layer, fixed count, remaining count
- Any remaining structural discrepancies (flagged prominently)
- Tokens created and reused
- Fix cycles completed
- Files modified
- Screenshot paths

## Progression

→ `04-report.md`
