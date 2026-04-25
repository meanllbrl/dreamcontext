"""Reinfluence — slim ingest tool for dreamcontext.

Usage:
    python -m reinfluence ingest <url-or-handle> --out-dir <path> [--model medium] [--max N]

Emits one JSON object per line to stdout. Each object is one of:
    {"event":"start","kind":"single"|"profile","input":"..."}
    {"event":"post","handle":"...","shortcode":"...","url":"...","caption":"...",
     "duration_seconds": float|null, "video_path":"...", "thumbnail_url":"...",
     "transcript":{"text":"...","language":"...","segments":[...],"model":"..."} | null,
     "frames":[{"timestamp":0.0,"path":"...","type":"hook"|"regular"}, ...]}

    YouTube ingest is transcript-only: the official caption track is fetched
    via ``youtube-transcript-api`` (no PO-token gate, no video download, no
    Whisper, no frames). Instagram ingest still downloads the video, extracts
    frames, and transcribes with Whisper. The transcript ``model`` field
    reflects the source: ``yt-transcript-api:<lang>`` for YouTube, ``whisper``
    for Instagram.
    {"event":"warn","message":"..."}
    {"event":"error","message":"..."}
    {"event":"done","posts":N}

Outputs (videos + frames) land under <out-dir>/<handle>/<shortcode>/. Caller is
responsible for moving / pruning binaries; this tool only writes them.

Designed to be invoked by the dreamcontext TS layer — never user-facing.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

HOOK_TIMESTAMPS = [0.0, 1.0, 2.0, 3.0]
REGULAR_INTERVAL = 5.0
DOWNLOAD_TIMEOUT = 180
AUDIO_TIMEOUT = 90
FRAME_TIMEOUT = 30

_whisper_cache: dict[str, Any] = {}


def emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def warn(msg: str) -> None:
    emit({"event": "warn", "message": msg})


def err(msg: str) -> None:
    emit({"event": "error", "message": msg})


# ─── URL classification ─────────────────────────────────────────────────────

INSTAGRAM_POST_RE = re.compile(r"instagram\.com/(?:reel|p|tv)/([\w\-]+)")
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
YOUTUBE_ID_RE = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})")


def classify(target: str) -> tuple[str, str]:
    """Return (kind, key). kind ∈ {single_yt, single_ig, profile_ig}."""
    target = target.strip()
    if not target.startswith("http"):
        return ("profile_ig", target.lstrip("@").lower())
    parsed = urlparse(target)
    host = parsed.netloc.lower()
    if host in YOUTUBE_HOSTS:
        return ("single_yt", target)
    if "instagram.com" in host:
        m = INSTAGRAM_POST_RE.search(target)
        if m:
            return ("single_ig", target)
        # /<handle>/ profile URL
        parts = [p for p in parsed.path.split("/") if p]
        if parts:
            return ("profile_ig", parts[0].lower())
    return ("single_yt", target)  # let yt-dlp try


def youtube_id_from(url: str) -> str | None:
    m = YOUTUBE_ID_RE.search(url)
    return m.group(1) if m else None


def youtube_channel_handle(url: str) -> str:
    """Best-effort channel/handle from a YouTube URL. Falls back to '_youtube'."""
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    for p in parts:
        if p.startswith("@"):
            return p[1:].lower()
    return "_youtube"


# ─── Download ────────────────────────────────────────────────────────────────

VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".m4v", ".mov"}


def download_with_ytdlp(url: str, out_dir: Path) -> Path | None:
    """Download a video file via yt-dlp. Used by Instagram path only."""
    out_dir.mkdir(parents=True, exist_ok=True)
    template = str(out_dir / "video.%(ext)s")
    cmd = [
        "yt-dlp", "--quiet", "--no-warnings", "--no-playlist",
        "-f", "mp4/best[ext=mp4]/best",
        "-o", template,
        url,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=DOWNLOAD_TIMEOUT)
    except subprocess.CalledProcessError as e:
        warn(f"yt-dlp failed: {e.stderr.strip()[:200]}")
        return None
    except subprocess.TimeoutExpired:
        warn(f"yt-dlp timed out after {DOWNLOAD_TIMEOUT}s")
        return None
    except FileNotFoundError:
        err("yt-dlp not found")
        return None
    all_files = sorted(out_dir.glob("video.*"))
    return next((f for f in all_files if f.suffix.lower() in VIDEO_EXTS), None)


def probe_duration(video: Path) -> float | None:
    """Best-effort duration probe via ffprobe."""
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(video),
    ]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=10)
        return float(out.stdout.strip())
    except Exception:
        return None


# ─── Transcription ───────────────────────────────────────────────────────────

YT_TRANSCRIPT_LANGS = ["en", "tr", "en-US", "en-GB"]


def fetch_youtube_transcript(video_id: str) -> dict[str, Any] | None:
    """Fetch caption track via youtube-transcript-api. Prefers user-uploaded
    over auto-generated; prefers English then Turkish."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        err("youtube-transcript-api not installed in venv")
        return None

    api = YouTubeTranscriptApi()
    try:
        listing = api.list(video_id)
    except Exception as e:
        warn(f"youtube-transcript-api list failed: {e}")
        return None

    tracks = list(listing)
    if not tracks:
        warn(f"no captions available for {video_id}")
        return None

    def score(t: Any) -> tuple[int, int]:
        # Lower is better. Prefer user-uploaded (0) over auto (1); prefer
        # earliest match in YT_TRANSCRIPT_LANGS.
        try:
            lang_rank = YT_TRANSCRIPT_LANGS.index(t.language_code)
        except ValueError:
            lang_rank = len(YT_TRANSCRIPT_LANGS)
        return (1 if t.is_generated else 0, lang_rank)

    chosen = sorted(tracks, key=score)[0]

    try:
        fetched = chosen.fetch()
    except Exception as e:
        warn(f"youtube-transcript-api fetch failed: {e}")
        return None

    snippets = list(fetched)
    if not snippets:
        return None

    segments = [
        {"start": float(s.start), "end": float(s.start + s.duration), "text": s.text.strip()}
        for s in snippets if s.text and s.text.strip()
    ]
    full_text = " ".join(s["text"] for s in segments).strip()
    if not full_text:
        return None

    return {
        "text": full_text,
        "language": chosen.language_code,
        "segments": segments,
        "model": f"yt-transcript-api:{chosen.language_code}{':auto' if chosen.is_generated else ''}",
    }


def extract_audio(video: Path, audio_out: Path) -> bool:
    cmd = [
        "ffmpeg", "-y", "-i", str(video),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        str(audio_out),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=AUDIO_TIMEOUT)
        return True
    except Exception as e:
        warn(f"ffmpeg audio extract failed: {e}")
        return False


def transcribe(video: Path, model_name: str) -> dict[str, Any] | None:
    try:
        import whisper
    except ImportError:
        err("whisper not installed in venv")
        return None

    audio = video.with_suffix(".wav")
    if not extract_audio(video, audio):
        return None

    try:
        if model_name not in _whisper_cache:
            _whisper_cache[model_name] = whisper.load_model(model_name)
        model = _whisper_cache[model_name]
        result = model.transcribe(str(audio), verbose=False)
        segments = [
            {"start": s["start"], "end": s["end"], "text": s["text"]}
            for s in result.get("segments", [])
        ]
        return {
            "text": result.get("text", "").strip(),
            "language": result.get("language"),
            "segments": segments,
            "model": model_name,
        }
    except Exception as e:
        warn(f"whisper failed: {e}")
        return None
    finally:
        if audio.exists():
            audio.unlink()


# ─── Frame extraction ────────────────────────────────────────────────────────

def extract_frames(video: Path, out_dir: Path, duration: float | None) -> list[dict[str, Any]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamps: list[tuple[float, str]] = [(t, "hook") for t in HOOK_TIMESTAMPS]
    if duration and duration > HOOK_TIMESTAMPS[-1]:
        t = HOOK_TIMESTAMPS[-1] + REGULAR_INTERVAL
        while t < duration:
            timestamps.append((t, "regular"))
            t += REGULAR_INTERVAL

    frames: list[dict[str, Any]] = []
    for ts, kind in timestamps:
        if duration and ts >= duration:
            break
        path = out_dir / f"frame_{ts:.1f}s.png"
        cmd = [
            "ffmpeg", "-y", "-ss", f"{ts:.2f}", "-i", str(video),
            "-vframes", "1", "-q:v", "2", str(path),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=FRAME_TIMEOUT)
            if path.exists():
                frames.append({"timestamp": ts, "path": str(path), "type": kind})
        except Exception:
            continue
    return frames


# ─── Single ingest ───────────────────────────────────────────────────────────

def ingest_single(url: str, out_dir: Path, handle: str, shortcode: str,
                  caption: str | None, model: str, skip_transcripts: bool,
                  skip_frames: bool, thumbnail_url: str | None = None) -> None:
    post_dir = out_dir / handle / shortcode
    post_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=f"reinf_{shortcode}_") as tmp:
        tmp_path = Path(tmp)
        video = download_with_ytdlp(url, tmp_path)
        if not video:
            warn(f"download failed for {shortcode}")
            return

        # Move video into post_dir as canonical name
        canonical = post_dir / f"video{video.suffix}"
        shutil.move(str(video), canonical)

        duration = probe_duration(canonical)

        transcript = None
        if not skip_transcripts:
            transcript = transcribe(canonical, model)

        frames: list[dict[str, Any]] = []
        if not skip_frames:
            frames = extract_frames(canonical, post_dir / "frames", duration)

    emit({
        "event": "post",
        "handle": handle,
        "shortcode": shortcode,
        "url": url,
        "caption": caption,
        "duration_seconds": duration,
        "video_path": str(canonical),
        "thumbnail_url": thumbnail_url,
        "transcript": transcript,
        "frames": frames,
    })


# ─── YouTube ingest (transcript-only, no video / frames / Whisper) ──────────

def ingest_youtube(url: str, out_dir: Path, handle: str, shortcode: str,
                   skip_transcripts: bool) -> None:
    post_dir = out_dir / handle / shortcode
    post_dir.mkdir(parents=True, exist_ok=True)

    transcript = None
    if not skip_transcripts:
        vid_id = youtube_id_from(url) or shortcode
        transcript = fetch_youtube_transcript(vid_id)
        if not transcript:
            warn(f"no transcript for youtube video {vid_id}")

    duration = None
    if transcript and transcript.get("segments"):
        last = transcript["segments"][-1]
        duration = last["end"]

    emit({
        "event": "post",
        "handle": handle,
        "shortcode": shortcode,
        "url": url,
        "caption": None,
        "duration_seconds": duration,
        "video_path": None,
        "thumbnail_url": None,
        "transcript": transcript,
        "frames": [],
    })


# ─── IG profile ingest (instaloader) ─────────────────────────────────────────

def ingest_profile(handle: str, out_dir: Path, model: str, max_reels: int,
                   skip_transcripts: bool, skip_frames: bool) -> int:
    try:
        import instaloader
    except ImportError:
        err("instaloader not installed in venv")
        return 0

    loader = instaloader.Instaloader(
        download_pictures=False, download_videos=False,
        download_video_thumbnails=False, download_geotags=False,
        download_comments=False, save_metadata=False,
        compress_json=False, quiet=True,
    )

    try:
        profile = instaloader.Profile.from_username(loader.context, handle)
    except instaloader.exceptions.ProfileNotExistsException:
        err(f"profile @{handle} not found")
        return 0
    except Exception as e:
        err(f"instaloader connect failed: {e}")
        return 0

    if profile.is_private:
        err(f"profile @{handle} is private")
        return 0

    posts_done = 0
    try:
        for post in profile.get_posts():
            if not post.is_video:
                continue
            if max_reels and posts_done >= max_reels:
                break
            video_url = post.video_url
            if not video_url:
                continue
            ingest_single(
                url=video_url, out_dir=out_dir, handle=handle, shortcode=post.shortcode,
                caption=post.caption or "", model=model,
                skip_transcripts=skip_transcripts, skip_frames=skip_frames,
                thumbnail_url=post.url,
            )
            posts_done += 1
            time.sleep(0.3)
    except Exception as e:
        warn(f"profile iteration interrupted: {e}")

    return posts_done


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(prog="reinfluence", description="Slim ingest for dreamcontext.")
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("ingest", help="Ingest a URL or IG handle.")
    g.add_argument("target", help="URL (YouTube/IG post) or IG handle.")
    g.add_argument("--out-dir", required=True, help="Output base directory.")
    g.add_argument("--model", default="medium", help="Whisper model size.")
    g.add_argument("--max", type=int, default=0, help="Max reels for handle ingest (0=all).")
    g.add_argument("--skip-transcripts", action="store_true")
    g.add_argument("--skip-frames", action="store_true")

    sub.add_parser("version", help="Print version and exit.")

    args = p.parse_args()

    if args.cmd == "version":
        print("reinfluence-slim 0.1.0")
        return 0

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    kind, key = classify(args.target)
    emit({"event": "start", "kind": kind, "input": args.target})

    posts = 0
    if kind == "profile_ig":
        posts = ingest_profile(
            handle=key, out_dir=out_dir, model=args.model, max_reels=args.max,
            skip_transcripts=args.skip_transcripts, skip_frames=args.skip_frames,
        )
    elif kind == "single_ig":
        m = INSTAGRAM_POST_RE.search(args.target)
        shortcode = m.group(1) if m else "unknown"
        ingest_single(
            url=args.target, out_dir=out_dir, handle="_url", shortcode=shortcode,
            caption=None, model=args.model,
            skip_transcripts=args.skip_transcripts, skip_frames=args.skip_frames,
        )
        posts = 1
    else:  # single_yt or fallback
        vid_id = youtube_id_from(args.target)
        shortcode = vid_id or (
            re.sub(r"[^A-Za-z0-9]", "_", urlparse(args.target).path)[-32:] or "video"
        )
        handle = youtube_channel_handle(args.target)
        ingest_youtube(
            url=args.target, out_dir=out_dir, handle=handle, shortcode=shortcode,
            skip_transcripts=args.skip_transcripts,
        )
        posts = 1

    emit({"event": "done", "posts": posts})
    return 0


if __name__ == "__main__":
    sys.exit(main())
