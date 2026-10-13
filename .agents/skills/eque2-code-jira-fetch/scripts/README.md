# Jira Ticket Fetch - Figma Scripts

This directory contains scripts for comprehensive Figma design data fetching during the jira-ticket-fetch workflow.

## Scripts

### fetch-figma-design.sh

**Purpose:** Fetches comprehensive Figma design data via Figma REST API.

**Usage:**
```bash
./fetch-figma-design.sh <file-key> <node-id> [output-dir]

# Example:
./fetch-figma-design.sh FNTk4CfbgdHSsvJiDWS15J 4591:46431 ./figma-output
```

**Prerequisites:**
- `FIGMA_TOKEN` environment variable must be set
- Get token from: https://www.figma.com/settings

**Output Files:**
- `README.md` - Export summary with metadata
- `screenshot.png` - High-quality rendered design (2x scale)
- `node-data.json` - Complete node tree structure with ALL properties
- `file-metadata.json` - File-level metadata, pages, frames
- `styles.json` - All design system styles (colors, text, effects)
- `components.json` - All component definitions
- `image-urls.json` - Asset export URLs

**What it fetches:**
1. **File metadata** - Complete file structure, all pages/frames
2. **Node data** - Specific node with full hierarchy, properties, styles, children
3. **Styles** - All color styles, text styles, effect styles
4. **Components** - All component definitions in the file
5. **Images** - Rendered screenshot at 2x scale
6. **Asset URLs** - Export URLs for all assets

---

### extract-figma-effects.py

**Purpose:** Recursively extracts ALL visual effects (shadows, blurs) from Figma node data, converting them to CSS-ready values.

**Usage:**
```bash
python3 extract-figma-effects.py <node-data.json> [output.json]

# Example:
python3 extract-figma-effects.py ./figma-output/node-data.json ./figma-output/effects.json
```

**What it does:**
1. Reads the complete Figma `node-data.json` file
2. Recursively traverses ALL nodes including deeply nested children (up to 50 levels)
3. Identifies elements with visible effects (shadows, blurs)
4. Converts Figma effect format to CSS `box-shadow` values
5. Outputs JSON file with all elements that have effects

**Why this is important:**
- Figma MCP screenshot inspection can miss subtle effects on nested components
- Elements deep in the hierarchy (depth 6+) may have shadows that aren't visible in screenshots
- Component instances with complex IDs need special handling
- This ensures NO visual effects are missed during implementation

**Output Format:**
```json
{
  "totalElements": 4,
  "elements": [
    {
      "id": "I4591:46277;2828:27558",
      "name": "Frame 57780",
      "type": "FRAME",
      "depth": 6,
      "effects": [
        {
          "type": "DROP_SHADOW",
          "visible": true,
          "radius": 2.0,
          "offset": {"x": 0.0, "y": 0.0},
          "color": {"r": 0, "g": 0, "b": 0, "a": 0.12},
          "spread": 0,
          "cssValue": "0.0px 0.0px 2.0px 0px rgba(0,0,0,0.12)"
        }
      ],
      "boxShadow": "0.0px 0.0px 2.0px 0px rgba(0,0,0,0.12), 0.0px 8.0px 16.0px 0px rgba(0,0,0,0.14)"
    }
  ]
}
```

---

## Integration with Workflow

These scripts are used in **Step 05: Figma Fetch** of the jira-ticket-fetch workflow:

1. **First:** Run `fetch-figma-design.sh` to get all REST API data
2. **Second:** Run `extract-figma-effects.py` to extract CSS-ready effects
3. **Third:** (Optional) Use Figma MCP tools for additional enhancements
4. **Result:** Comprehensive Figma data ready for create-spec workflow

---

## Troubleshooting

### fetch-figma-design.sh

**403 Forbidden:**
- Token is invalid or expired
- Generate new token at https://www.figma.com/settings
- Update `FIGMA_TOKEN` in `.env` file

**404 Not Found:**
- File key or node ID is incorrect
- Verify the Figma URL and extracted parameters
- Ensure you have access to the file

**Network errors:**
- Check internet connection
- Check Figma status: https://status.figma.com/
- Retry after a few minutes

### extract-figma-effects.py

**File not found:**
- Ensure `node-data.json` exists (run fetch-figma-design.sh first)
- Check the file path is correct

**Invalid JSON:**
- `node-data.json` may be corrupted
- Re-fetch the design data
- Check file permissions
