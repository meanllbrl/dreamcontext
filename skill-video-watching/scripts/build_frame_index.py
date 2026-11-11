#!/usr/bin/env python3
"""Build frames.json: map each extracted frame to its pts_time on the video timeline.

transcribe.sh selects frames in ONE time-based pass (scene change OR every MAX_GAP),
dumping each kept frame's pts_time to frame_times.txt. This pairs every timestamp with
its zero-padded frame file in selection order, adds the first/last anchor frames, drops
near-duplicate timestamps, labels each frame (scene vs gap vs anchor), and emits
frames.json sorted by time. It also prints a COVERAGE check — the largest unsampled
stretch — so a human can catch under-sampling before an expensive deep-analysis pass.

Type labels are reconstructed from inter-frame spacing (no second decode): a frame that
landed sooner than MAX_GAP after the previous one was triggered by a scene change
('scene'); one that landed at the MAX_GAP cadence is a periodic fill ('gap'). They are
hints for which frames to prioritize, not a hard contract.

Stdlib only — no venv needed.
Usage: build_frame_index.py <OUT_DIR> [DURATION_SEC]
Env:   DEDUPE_SEC=0.4  collapse non-anchor frames closer than this to the kept one.
       MAX_GAP=10      the gap target the engine sampled at (drives type + coverage warn).
"""
import json
import os
import re
import sys
from pathlib import Path

# metadata=print header line, e.g.: "frame:0    pts:321024  pts_time:12.852500"
FRAME_RE = re.compile(r"frame:(\d+)\b.*?pts_time:([\d.]+)", re.DOTALL)
DEDUPE_SEC = float(os.environ.get("DEDUPE_SEC", "0.4"))
MAX_GAP = float(os.environ.get("MAX_GAP", "10"))


def parse_times(meta_file: Path) -> dict[int, float]:
    """frame index (0-based, as ffmpeg numbers kept frames) -> pts_time seconds."""
    if not meta_file.exists():
        return {}
    text = meta_file.read_text(errors="replace")
    return {int(n): round(float(t), 2) for n, t in FRAME_RE.findall(text)}


def collect(out_dir: Path, prefix: str, meta_name: str) -> list[dict]:
    times = parse_times(out_dir / "frames" / meta_name)
    frames = sorted((out_dir / "frames").glob(f"{prefix}_*.jpg"))
    # transcribe.sh names files 1-based (%04d starts at 0001); metadata frame: is 0-based.
    return [{"file": f"frames/{f.name}", "t": times.get(i), "type": "key"}
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


def label_types(rows: list[dict]) -> None:
    """Reconstruct scene/gap from spacing. Frames spaced >= ~MAX_GAP are periodic
    fills ('gap'); closer ones were pulled in early by a scene change ('scene')."""
    near = MAX_GAP * 0.9
    prev_t = 0.0
    for r in rows:
        if r["type"] == "anchor":
            if r["t"] is not None:
                prev_t = r["t"]
            continue
        if r["t"] is None:
            r["type"] = "scene"
            continue
        r["type"] = "gap" if (r["t"] - prev_t) >= near else "scene"
        prev_t = r["t"]


def coverage(rows: list[dict], duration: float) -> tuple[float, float]:
    """Largest unsampled stretch (s) and where it starts, over [0, duration]."""
    ts = sorted(r["t"] for r in rows if r["t"] is not None)
    if not ts:
        return (duration, 0.0)
    # Bound the right edge with the real duration; if ffprobe couldn't read it (0), fall
    # back to the last sampled time so the tail gap (last frame -> end) still surfaces
    # rather than being silently dropped.
    right = round(duration, 2) if duration > 0 else ts[-1]
    bounds = [0.0] + ts + [right]
    worst, at = 0.0, 0.0
    for a, b in zip(bounds, bounds[1:]):
        if b - a > worst:
            worst, at = b - a, a
    return (worst, at)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: build_frame_index.py <OUT_DIR> [DURATION_SEC]", file=sys.stderr)
        return 2
    out_dir = Path(sys.argv[1])
    duration = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0

    rows = collect(out_dir, "frame", "frame_times.txt")
    rows += anchors(out_dir, duration)
    # Sort by time (unknown timestamps sink to the end); on a tie, anchors sort FIRST so
    # the eq(n,0) seed frame at t=0 (and any selected frame coincident with anchor_last)
    # dedupes away against the identical anchor instead of producing a duplicate entry.
    rows.sort(key=lambda r: (r["t"] is None, r["t"] or 0.0, r["type"] != "anchor"))
    rows = dedupe(rows)
    label_types(rows)
    for r in rows:
        r["at"] = fmt(r["t"])

    (out_dir / "frames.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))

    n_anchor = sum(r["type"] == "anchor" for r in rows)
    worst, at = coverage(rows, duration)
    print(f"   frames.json: {len(rows)} frames indexed ({n_anchor} anchors, dedupe<{DEDUPE_SEC}s)")
    print(f"   coverage: longest unsampled gap = {worst:.1f}s at {fmt(at)} (target MAX_GAP={MAX_GAP:g}s)")
    if duration > 0 and worst > MAX_GAP * 2:
        print(f"   ⚠ coverage gap is >2x MAX_GAP — frames may be missing around {fmt(at)}. "
              f"Re-run denser: --max-gap {MAX_GAP / 2:g} (or --mode ui for app recordings).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
