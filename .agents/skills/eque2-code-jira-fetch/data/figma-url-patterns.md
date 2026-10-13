# Figma URL Patterns

Regex patterns for discovering Figma links in Jira ticket content.

## Supported URL Formats

### Standard Figma URLs

```regex
https?://(?:www\.)?figma\.com/(?:file|design)/([a-zA-Z0-9]+)(?:/[^?\s]*)?(?:\?[^\s]*)?
```

**Matches:**
- `https://figma.com/file/ABC123DEF456/Project-Name`
- `https://www.figma.com/design/ABC123DEF456/Design-File`
- `https://figma.com/file/ABC123DEF456/Name?node-id=1%3A2`

**Capture Group 1:** File ID (e.g., `ABC123DEF456`)

### Figma Short Links

```regex
https?://fig\.ma/([a-zA-Z0-9]+)
```

**Matches:**
- `https://fig.ma/ABC123`
- `http://fig.ma/XYZ789`

**Capture Group 1:** Short link ID

### Embedded in Markdown Links

```regex
\[([^\]]+)\]\(https?://(?:www\.)?figma\.com/(?:file|design)/([a-zA-Z0-9]+)(?:/[^?\)]*)?(?:\?[^\)]*)?)\)
```

**Matches:**
- `[Design Mockups](https://figma.com/file/ABC123/Design)`
- `[See wireframes](https://www.figma.com/design/XYZ789/Wireframes?node-id=1:2)`

**Capture Group 1:** Link text
**Capture Group 2:** File ID

## Comprehensive Pattern (All Formats)

For broad matching across all text fields:

```regex
(?:https?://)?(?:www\.)?(?:figma\.com/(?:file|design)/([a-zA-Z0-9]+)|fig\.ma/([a-zA-Z0-9]+))
```

This pattern captures both standard Figma URLs and short links in a single regex.

## Usage Guidelines

1. **Search ALL text fields:** description, custom fields, comments, subtasks
2. **Extract file IDs** from capture groups
3. **Deduplicate** by file ID (same file may be linked multiple times)
4. **Validate** extracted IDs match pattern: `^[a-zA-Z0-9]{15,22}$`

## Edge Cases to Handle

- URLs in code blocks: `figma.com/file/ABC123` (no protocol)
- Multiple links in one field
- Truncated URLs (missing protocol or domain)
- Invalid/malformed links (filter out before fetching)
