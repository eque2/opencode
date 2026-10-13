#!/bin/bash

# Figma Design Fetcher
# Usage: ./fetch-figma-design.sh <file-key> <node-id> [output-dir]
#
# Example: ./fetch-figma-design.sh FNTk4CfbgdHSsvJiDWS15J 4591:46431 ./figma-output

set -e

# Check arguments
if [ $# -lt 2 ]; then
    echo "Usage: $0 <file-key> <node-id> [output-dir]"
    echo ""
    echo "Example: $0 FNTk4CfbgdHSsvJiDWS15J 4591:46431 ./figma-output"
    echo ""
    echo "File key: from URL https://www.figma.com/design/FILE_KEY/..."
    echo "Node ID: from URL ...?node-id=NODE_ID (replace - with :)"
    exit 1
fi

FILE_KEY="$1"
NODE_ID="$2"
OUTPUT_DIR="${3:-./figma-output}"

# Check for Figma token
if [ -z "$FIGMA_TOKEN" ]; then
    echo "Error: FIGMA_TOKEN environment variable not set"
    echo ""
    echo "Get your token from: https://www.figma.com/settings"
    echo "Then run: export FIGMA_TOKEN='your-token-here'"
    exit 1
fi

# Create output directory with parent directories
echo "Creating output directory: $OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR" 2>/dev/null || {
    echo "Error: Failed to create output directory: $OUTPUT_DIR"
    echo "Please check permissions and path validity"
    exit 1
}

# Verify directory was created
if [ ! -d "$OUTPUT_DIR" ]; then
    echo "Error: Output directory does not exist after creation attempt: $OUTPUT_DIR"
    exit 1
fi

echo "Output directory ready: $OUTPUT_DIR"
echo ""
echo "Fetching Figma design data..."
echo "File Key: $FILE_KEY"
echo "Node ID: $NODE_ID"
echo ""

# Convert node ID format (colon to URL encoding)
NODE_ID_ENCODED=$(echo "$NODE_ID" | sed 's/:/%3A/g')

# Fetch file metadata
echo "1. Fetching file metadata..."
curl -s -H "X-Figma-Token: $FIGMA_TOKEN" \
    "https://api.figma.com/v1/files/$FILE_KEY" \
    > "$OUTPUT_DIR/file-metadata.json"

if [ $? -eq 0 ]; then
    echo "   Saved to $OUTPUT_DIR/file-metadata.json"
else
    echo "   Failed to fetch file metadata"
    exit 1
fi

# Fetch specific node data
echo "2. Fetching node data..."
curl -s -H "X-Figma-Token: $FIGMA_TOKEN" \
    "https://api.figma.com/v1/files/$FILE_KEY/nodes?ids=$NODE_ID_ENCODED" \
    > "$OUTPUT_DIR/node-data.json"

if [ $? -eq 0 ]; then
    echo "   Saved to $OUTPUT_DIR/node-data.json"
else
    echo "   Failed to fetch node data"
fi

# Fetch styles
echo "3. Fetching file styles..."
curl -s -H "X-Figma-Token: $FIGMA_TOKEN" \
    "https://api.figma.com/v1/files/$FILE_KEY/styles" \
    > "$OUTPUT_DIR/styles.json"

if [ $? -eq 0 ]; then
    echo "   Saved to $OUTPUT_DIR/styles.json"
else
    echo "   Failed to fetch styles"
fi

# Fetch components
echo "4. Fetching components..."
curl -s -H "X-Figma-Token: $FIGMA_TOKEN" \
    "https://api.figma.com/v1/files/$FILE_KEY/components" \
    > "$OUTPUT_DIR/components.json"

if [ $? -eq 0 ]; then
    echo "   Saved to $OUTPUT_DIR/components.json"
else
    echo "   Failed to fetch components"
fi

# Fetch image URLs for the node
echo "5. Fetching image URLs..."
curl -s -H "X-Figma-Token: $FIGMA_TOKEN" \
    "https://api.figma.com/v1/images/$FILE_KEY?ids=$NODE_ID_ENCODED&format=png&scale=2" \
    > "$OUTPUT_DIR/image-urls.json"

if [ $? -eq 0 ]; then
    echo "   Saved to $OUTPUT_DIR/image-urls.json"

    # Download the actual image
    IMAGE_URL=$(cat "$OUTPUT_DIR/image-urls.json" | grep -o 'https://[^"]*' | head -1)
    if [ ! -z "$IMAGE_URL" ]; then
        echo "6. Downloading screenshot..."
        curl -s "$IMAGE_URL" > "$OUTPUT_DIR/screenshot.png"
        echo "   Saved to $OUTPUT_DIR/screenshot.png"
    fi
else
    echo "   Failed to fetch image URLs"
fi

# Create a summary file
echo "7. Creating summary..."
cat > "$OUTPUT_DIR/README.md" << EOF
# Figma Design Export

**File Key**: $FILE_KEY
**Node ID**: $NODE_ID
**Export Date**: $(date)

## Files

- \`file-metadata.json\` - Complete file metadata including all pages and frames
- \`node-data.json\` - Specific node data with all properties, styles, and children
- \`styles.json\` - All color styles, text styles, and effect styles
- \`components.json\` - All components defined in the file
- \`image-urls.json\` - Image export URLs for the node
- \`screenshot.png\` - Rendered screenshot of the node

## API Documentation

- **Figma REST API**: https://www.figma.com/developers/api
- **Files Endpoint**: https://www.figma.com/developers/api#get-files-endpoint
- **Nodes Endpoint**: https://www.figma.com/developers/api#get-file-nodes-endpoint

## Node URL

https://www.figma.com/design/$FILE_KEY?node-id=${NODE_ID//:/-}

EOF

echo "   Saved to $OUTPUT_DIR/README.md"
echo ""
echo "Complete! All data saved to $OUTPUT_DIR/"
