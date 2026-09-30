#!/usr/bin/env python3
"""
Extract all visual effects (shadows, blurs) from Figma node-data.json

This script recursively traverses the Figma node tree and extracts all effects
including shadows on nested elements and instances. This ensures validation
doesn't miss effects on deeply nested components.

Usage:
    python3 extract-figma-effects.py <node-data.json> [output.json]

Output Format:
{
  "elements": [
    {
      "id": "I4591:46277;2828:27558",
      "name": "Frame 57780",
      "type": "FRAME",
      "effects": [
        {
          "type": "DROP_SHADOW",
          "visible": true,
          "radius": 2.0,
          "offset": {"x": 0, "y": 0},
          "color": {"r": 0, "g": 0, "b": 0, "a": 0.24},
          "cssValue": "0px 0px 2px 0px rgba(0,0,0,0.24)"
        },
        {
          "type": "DROP_SHADOW",
          "visible": true,
          "radius": 16.0,
          "offset": {"x": 0, "y": 6},
          "color": {"r": 0, "g": 0, "b": 0, "a": 0.28},
          "cssValue": "0px 6px 16px 0px rgba(0,0,0,0.28)"
        }
      ]
    }
  ]
}
"""

import json
import sys
from typing import Any, Dict, List


def rgba_to_css(color: Dict[str, float], alpha: float = None) -> str:
    """Convert Figma RGBA color to CSS rgba() string"""
    r = int(color.get('r', 0) * 255)
    g = int(color.get('g', 0) * 255)
    b = int(color.get('b', 0) * 255)
    a = alpha if alpha is not None else color.get('a', 1.0)
    return f'rgba({r},{g},{b},{a:.2f})'


def effect_to_css(effect: Dict[str, Any]) -> str:
    """Convert Figma effect to CSS box-shadow value"""
    if effect.get('type') != 'DROP_SHADOW':
        return None

    if not effect.get('visible', True):
        return None

    offset_x = effect.get('offset', {}).get('x', 0)
    offset_y = effect.get('offset', {}).get('y', 0)
    radius = effect.get('radius', 0)
    spread = effect.get('spread', 0)
    color = effect.get('color', {})

    # Format: offset-x offset-y blur-radius spread-radius color
    css_color = rgba_to_css(color)
    return f'{offset_x}px {offset_y}px {radius}px {spread}px {css_color}'


def extract_effects_recursive(obj: Any, results: List[Dict], depth: int = 0, max_depth: int = 50):
    """Recursively traverse Figma node tree and extract all effects"""
    if depth > max_depth:
        return

    if isinstance(obj, dict):
        node_id = obj.get('id')
        node_name = obj.get('name', '')
        node_type = obj.get('type', '')
        effects = obj.get('effects', [])

        # If this node has visible effects, add it to results
        if effects and any(e.get('visible', True) for e in effects):
            visible_effects = [e for e in effects if e.get('visible', True)]

            # Convert effects to CSS values
            css_effects = []
            for effect in visible_effects:
                css_value = effect_to_css(effect)
                if css_value:
                    css_effects.append({
                        'type': effect.get('type'),
                        'visible': effect.get('visible', True),
                        'radius': effect.get('radius', 0),
                        'offset': effect.get('offset', {}),
                        'color': effect.get('color', {}),
                        'spread': effect.get('spread', 0),
                        'cssValue': css_value
                    })

            if css_effects:
                # Combine all shadows into a single box-shadow value
                combined_css = ', '.join(e['cssValue'] for e in css_effects)

                results.append({
                    'id': node_id,
                    'name': node_name,
                    'type': node_type,
                    'depth': depth,
                    'effects': css_effects,
                    'boxShadow': combined_css
                })

        # Recurse into children
        if 'children' in obj:
            for child in obj['children']:
                extract_effects_recursive(child, results, depth + 1, max_depth)

        # Recurse into other nested structures
        for key, value in obj.items():
            if key not in ['children', 'effects'] and isinstance(value, (dict, list)):
                extract_effects_recursive(value, results, depth, max_depth)

    elif isinstance(obj, list):
        for item in obj:
            extract_effects_recursive(item, results, depth, max_depth)


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 extract-figma-effects.py <node-data.json> [output.json]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else None

    # Read Figma data
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f'Error reading {input_file}: {e}', file=sys.stderr)
        sys.exit(1)

    # Extract effects
    results = []
    extract_effects_recursive(data, results)

    # Build output
    output = {
        'totalElements': len(results),
        'elements': results
    }

    # Write output
    if output_file:
        try:
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(output, f, indent=2)
            print(f'Extracted {len(results)} elements with effects to {output_file}')
        except Exception as e:
            print(f'Error writing {output_file}: {e}', file=sys.stderr)
            sys.exit(1)
    else:
        # Print to stdout
        print(json.dumps(output, indent=2))

    # Print summary to stderr
    print(f'\nSummary:', file=sys.stderr)
    print(f'  Total elements with effects: {len(results)}', file=sys.stderr)

    # Group by element name for easier reading
    name_counts = {}
    for elem in results:
        name = elem['name']
        name_counts[name] = name_counts.get(name, 0) + 1

    print(f'\nElements by name:', file=sys.stderr)
    for name, count in sorted(name_counts.items()):
        print(f'  {name}: {count} instances', file=sys.stderr)


if __name__ == '__main__':
    main()
