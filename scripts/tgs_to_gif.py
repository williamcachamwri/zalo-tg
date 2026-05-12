#!/usr/bin/env python3
"""
Convert a Telegram animated sticker (.tgs) to GIF.
Usage: tgs_to_gif.py <input.tgs> <output.gif>
Exit 0 on success, non-zero on failure.
"""
import sys
import os

if len(sys.argv) != 3:
    print(f"Usage: {sys.argv[0]} <input.tgs> <output.gif>", file=sys.stderr)
    sys.exit(1)

input_path  = sys.argv[1]
output_path = sys.argv[2]

try:
    import lottie
    from lottie.parsers.tgs import parse_tgs
    # Import gif exporter — requires cairosvg + cairo dylib to be available
    from lottie.exporters.gif import export_gif

    anim = parse_tgs(input_path)
    # skip_frames=2: render every 2nd frame → faster, smaller file, still smooth
    with open(output_path, 'wb') as f:
        export_gif(anim, f, dpi=72, skip_frames=2)

    print(f"OK: {output_path}", flush=True)
    sys.exit(0)

except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr, flush=True)
    sys.exit(1)
