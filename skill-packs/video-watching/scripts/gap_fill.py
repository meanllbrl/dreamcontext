#!/usr/bin/env python3
"""Print timestamps that keep every unsampled stretch of the video <= MAX_GAP.

Scene-detect fires on motion, not on meaning — so static-but-information-rich
sections (app demos, slides, talking heads) get no frame. This reads the scene
timestamps, bounds them with 0 and the video duration, and for any gap larger than
MAX_GAP emits evenly-spaced fill timestamps so no stretch goes unsampled.

Stdlib only. Usage: gap_fill.py <OUT_DIR> <DURATION_SEC> [MAX_GAP_SEC]
Prints one timestamp (seconds, 2dp) per line — transcribe.sh grabs each frame.
"""
import re
import sys
from pathlib import Path

FRAME_RE = re.compile(r"frame:(\d+)\b.*?pts_time:([\d.]+)", re.DOTALL)


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: gap_fill.py <OUT_DIR> <DURATION_SEC> [MAX_GAP_SEC]", file=sys.stderr)
        return 2
    out_dir = Path(sys.argv[1])
    duration = float(sys.argv[2])
    max_gap = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0
    if duration <= 0 or max_gap <= 0:
        return 0

    meta = out_dir / "frames" / "scene_times.txt"
    scene_times = []
    if meta.exists():
        scene_times = [round(float(t), 2)
                       for _, t in FRAME_RE.findall(meta.read_text(errors="replace"))]

    bounds = sorted(set([0.0] + scene_times + [round(duration, 2)]))
    for a, b in zip(bounds, bounds[1:]):
        gap = b - a
        n = int(gap // max_gap)            # inserts that split the gap into <= max_gap pieces
        for k in range(1, n + 1):
            print(f"{a + gap * k / (n + 1):.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
