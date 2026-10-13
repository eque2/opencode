Language: {communication_language}

# Stage 2: Measure (Three-Layer Verification)

## Rules

- Three layers in order — Layer 1 (screenshot), Layer 2 (structural), Layer 3 (properties). No skipping.
- Structural before properties — wrong layout is fundamentally broken regardless of correct colours.
- Expected values from Figma node tree only.
- STRUCTURAL discrepancies are always HIGH severity.
- If Playwright cannot connect: output `FIGMA_REVIEW_FAILED: App not reachable` and EXIT.

## Sequence

### 1. Set Playwright viewport

Set viewport to artboard dimensions from Stage 1.

### 2. Navigate to component route

Determine route from spec and implementation context. Navigate with `waitForLoadState('networkidle')`.

## Layer 1: Screenshot comparison

### 3. Capture implementation screenshot

Take full-page screenshot at the Figma artboard viewport size. Store:
- `figmaScreenshotPath` — Figma rendering
- `implementationScreenshotPath` — Playwright capture

Note visual similarity. Flag obvious structural differences.

## Layer 2: Structural/positional verification

### 4. Resolve all mapped DOM elements

For each node in the mapping: locate DOM element. If not found, try fallbacks. Record `ELEMENT_NOT_FOUND` as STRUCTURAL HIGH.

### 5. Bounding box comparison

For each resolved element, compare all four dimensions against Figma:
- Width/Height: tolerance per figma-standards Section 4 (default ±2px)
- X/Y position (MANDATORY): tolerance default ±5px, computed relative to parent

Record `BOUNDING_BOX_MISMATCH` as STRUCTURAL HIGH for any exceeding tolerance.

### 6. Parent-child containment

Verify DOM child is descendant of DOM parent. Record `CONTAINMENT_VIOLATION` as STRUCTURAL HIGH.

### 7. Sibling order

Verify DOM sibling order matches Figma `children[]` array order. Record `SIBLING_ORDER_VIOLATION` as STRUCTURAL HIGH.

### 8. Child count

Compare DOM container child count to Figma node child count. Record `CHILD_COUNT_MISMATCH` as STRUCTURAL HIGH.

Check for DOM children with no Figma equivalent. Acceptable if wrapper divs only. Record `ELEMENT_EXTRA` as STRUCTURAL HIGH for visual-impact extras.

For horizontal flex containers: verify all children share the same `top` position. Record `FLEX_LINE_WRAP` as STRUCTURAL HIGH.

## Layer 3: Property-level verification

### 9. Measure CSS properties

For each mapped element, measure ONLY properties Figma specifies using `getComputedStyle()`. For backgrounds, walk up ancestors to check visual rendering.

### 10. Compare against Figma values

Use tolerances from figma-standards Section 3:
- Colours: exact hex match
- Dimensions: ±1px
- Font family: exact (case-insensitive)
- Font size/line-height: ±0.5px
- Box-shadow: exact colour, ±1px dimensions
- Display/flex-direction: exact match

### 11. Build discrepancy list

Combine all layers. STRUCTURAL = always HIGH. Property severity: HIGH for colour/font/missing, MEDIUM for small dimension variance.

### 12. Check for zero discrepancies

If empty: log "All three verification layers pass" → skip to `04-report.md`.

## Progression

- Zero discrepancies → `04-report.md`
- Otherwise → `03-fix.md`
