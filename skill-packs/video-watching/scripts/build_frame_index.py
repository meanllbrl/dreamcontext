#!/usr/bin/env python3
"""Build frames.json: map each extracted frame to its pts_time on the video timeline.

Reads the per-frame pts_time dumps (scene_times.txt from ffmpeg metadata, gap_times.txt
written by transcribe.sh) alongside the frames, pairs each timestamp with its
zero-padded frame file in selection order, adds the first/last anchor frames, drops
near-duplicate timestamps, and emits frames.json sorted by time.

Stdlib only — no venv needed.
Usage: build_frame_index.py <OUT_DIR> [DURATION_SEC]
Env:   DEDUPE_SEC=0.4  collapse non-anchor frames closer than this to the kept one.
"""
import json
import os
import re
import sys
from pathlib import Path

# metadata=print header line, e.g.: "frame:0    pts:321024  pts_time:12.852500"
FRAME_RE = re.compile(r"frame:(\d+)\b.*?pts_time:([\d.]+)", re.DOTALL)
DEDUPE_SEC = float(os.environ.get("DEDUPE_SEC", "0.4"))


def parse_times(meta_file: Path) -> dict[int, float]:
    """frame index (0-based, as ffmpeg numbers kept frames) -> pts_time seconds."""
    if not meta_file.exists():
        return {}
    text = meta_file.read_text(errors="replace")
    return {int(n): round(float(t), 2) for n, t in FRAME_RE.findall(text)}


def collect(out_dir: Path, prefix: str, meta_name: str, kind: str) -> list[dict]:
    times = parse_times(out_dir / "frames" / meta_name)
    frames = sorted((out_dir / "frames").glob(f"{prefix}_*.jpg"))
    # transcribe.sh names files 1-based (%04d starts at 0001); metadata frame: is 0-based.
    return [{"file": f"frames/{f.name}", "t": times.get(i), "type": kind}
            for i, f in enumerate(frames)]


def anchors(out_dir: Path, duration: float) -> list[dict]:
    rows = []
    if (out_dir / "frames" / "anchor_first.jpg").exists():
        rows.append({"file": "frames/anchor_first.jpg", "t": 0.0, "type": "anchor"})
    if (out_dir / "frames" / "anchor_last.jpg").exists():
        t = round(duration, 2) if duration > 0 else None
        rows.append({"file": "frames/anchor_last.jpg", "t": t, "type": "anchor"})
    return rows


def fmt(t):
    if t is None:
        return "??:??"
    m, s = divmod(int(t), 60)
    return f"{m:02d}:{s:02d}"


def dedupe(rows: list[dict]) -> list[dict]:
    """Keep all anchors; drop a non-anchor frame within DEDUPE_SEC of the last kept."""
    kept: list[dict] = []
    last_t = None
    for r in rows:
        is_anchor = r["type"] == "anchor"
        if (not is_anchor and last_t is not None and r["t"] is not None
                and abs(r["t"] - last_t) < DEDUPE_SEC):
            continue
        kept.append(r)
        if r["t"] is not None:
            last_t = r["t"]
    return kept


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: build_frame_index.py <OUT_DIR> [DURATION_SEC]", file=sys.stderr)
        return 2
    out_dir = Path(sys.argv[1])
    duration = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0

    rows = collect(out_dir, "scene", "scene_times.txt", "scene")
    rows += collect(out_dir, "gap", "gap_times.txt", "gap")
    rows += anchors(out_dir, duration)
    # Sort by time; unknown timestamps sink to the end.
    rows.sort(key=lambda r: (r["t"] is None, r["t"] or 0.0))
    rows = dedupe(rows)
    for r in rows:
        r["at"] = fmt(r["t"])

    (out_dir / "frames.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    n_anchor = sum(r["type"] == "anchor" for r in rows)
    print(f"   frames.json: {len(rows)} frames indexed ({n_anchor} anchors, dedupe<{DEDUPE_SEC}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
