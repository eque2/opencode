Language: {communication_language}

# Stage 1: Load Context

## Rules

- Expected values come from Figma node data — never derive from implementation code.
- Load the full node tree; do NOT skim.
- No user interaction.

## Sequence

### 1. Parse inputs

Extract `spec_folder`, `task_id`, `task_description`, `files_changed`, `slug` from the calling workflow.

### 2. Load Figma standards

Read `{project-root}/_bmad/eque2-code/data/figma-standards.md` completely. Extract all five sections:
- Section 1: Token System — file locations, dedup rules, placement
- Section 2: CSS Architecture — Figma-to-CSS mappings (Auto Layout to Flexbox, etc.)
- Section 3: Measurement Tolerances — exact thresholds per property type
- Section 4: Structural Verification Standards — bounding box tolerances, containment, sibling order, child count
- Section 5: Screenshot Comparison Standards — viewport matching, format, scale

### 3. Resolve Figma file paths from spec

Read `{spec_folder}/spec.md`. Parse "Files to Reference" and "Reference Data" for Figma data paths.

If no Figma references found: output `FIGMA_REVIEW_FAILED: No Figma references in spec` and EXIT.

### 4. Load Figma data files

For each design path: read `tokens-mcp.json`, `effects.json`, `SUMMARY.md`. Note `screenshot.png` path.

If any required file is missing: output `FIGMA_REVIEW_FAILED: Figma data incomplete` and EXIT.

### 5. Parse node-data.json into full tree

Read `node-data.json` completely. Parse into tree preserving:
- Node hierarchy, metadata (id, name, type), bounding boxes
- Layout properties, visual properties, text properties, sibling order

**Normalise bounding boxes** relative to root frame origin:
```
node.relativeX = node.absoluteBoundingBox.x - rootFrame.absoluteBoundingBox.x
node.relativeY = node.absoluteBoundingBox.y - rootFrame.absoluteBoundingBox.y
```

Store root frame dimensions as canonical viewport.

### 6. Extract expected CSS properties from each Figma node

| Figma Attribute | CSS Property | Conversion |
|---|---|---|
| `fills[].color` (non-TEXT) | `background-color` | RGBA 0–1 to hex |
| `fills[].color` (TEXT) | `color` | RGBA 0–1 to hex |
| `style.fontFamily` | `font-family` | Direct |
| `style.fontWeight` | `font-weight` | Direct numeric |
| `style.fontSize` | `font-size` | `{n}px` |
| `style.lineHeightPx` | `line-height` | `{n}px` |
| `style.letterSpacing` | `letter-spacing` | `{n}px` (0 = `normal`) |
| `paddingTop/Right/Bottom/Left` | `padding-*` | `{n}px` |
| `itemSpacing` | `gap` | `{n}px` |
| `layoutMode: VERTICAL` | `flex-direction` | `column` |
| `layoutMode: HORIZONTAL` | `flex-direction` | `row` |
| `layoutMode` (any) | `display` | `flex` |
| `effects[] DROP_SHADOW` | `box-shadow` | offset/radius/spread/color |
| `strokes[] + strokeWeight` | `border` | `{weight}px solid {color}` |
| `cornerRadius` | `border-radius` | `{n}px` |
| `opacity` | `opacity` | Direct 0–1 |

Only extract properties the Figma node actually defines.

### 7. Build Figma-to-DOM element mapping

Build a tree-structured mapping connecting Figma nodes to DOM selectors. Priority order:
1. Explicit mapping in spec
2. Component boundaries
3. Text content matching
4. Class name heuristics
5. Positional heuristics

### 8. Read implementation code

Read `files_changed` to understand component structure, selectors, and existing token usage. Use to **refine** mapping only — not to define expected values.

## Progression

→ `02-measure.md`
