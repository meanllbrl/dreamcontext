#!/usr/bin/env bash
# Video -> time-mapped transcript + significant frames (with per-frame timestamps).
# whisper.cpp (large-v3-turbo by default) for the transcript, ffmpeg for frames.
#
# This is the MECHANICAL step. It produces artifacts; it does NOT understand the
# video. Claude reads the outputs (transcript + frames.json), decides which frames
# matter, views them, and writes the curated <video>.transcript.md (see SKILL.md).
#
# Usage: ./transcribe.sh "/abs/path/to/video.mov" [lang]
#   lang: whisper language code. DEFAULT 'auto' — whisper detects it, no need to pass.
#         Force only if auto mislabels a short/ambiguous clip (e.g. 'tr', 'en').
#
# Env overrides:
#   WHISPER_MODEL=/abs/path/ggml-*.bin   force a specific model
#   OUT_DIR=/abs/path                    where artifacts go (default: <video_dir>/<slug>.media)
#   SCENE_THRESHOLD=0.15                 ffmpeg scene-change sensitivity (lower = more frames)
#   MAX_GAP=10                           guarantee a frame at least every N seconds (fills static sections)
#
# Outputs (in OUT_DIR):
#   transcript.srt       timestamped segments (human-friendly)
#   transcript.json/.txt/.vtt
#   frames/scene_*.jpg   frames at scene-change > SCENE_THRESHOLD
#   frames/gap_*.jpg     fill frames where scene-detect left a stretch > MAX_GAP unsampled
#   frames/anchor_first.jpg / anchor_last.jpg  always-captured first + last frame
#   frames.json          [{file, t, at, type}] — each frame's pts_time, sorted (Claude reads this)
#   source-meta.txt      ffprobe dump  (audio.wav is created then deleted after transcription)
set -euo pipefail

VIDEO="${1:?Usage: transcribe.sh <video> [lang]}"
LANG_CODE="${2:-auto}"   # whisper auto-detects the spoken language unless overridden
SCENE_THRESHOLD="${SCENE_THRESHOLD:-0.15}"
MAX_GAP="${MAX_GAP:-10}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- remote link? download with yt-dlp (local files skip this) ------------------
if [[ "$VIDEO" =~ ^https?:// ]]; then
  command -v yt-dlp >/dev/null || { echo "remote link needs yt-dlp: brew install yt-dlp" >&2; exit 1; }
  DL_DIR="${OUT_DIR:-$PWD}/_download"; mkdir -p "$DL_DIR"
  echo "==> downloading remote video with yt-dlp"
  yt-dlp -o "$DL_DIR/%(title)s.%(ext)s" "$VIDEO"
  VIDEO="$(ls -t "$DL_DIR"/* | head -1)"
  echo "==> downloaded: $VIDEO"
fi
[ -f "$VIDEO" ] || { echo "video not found: $VIDEO" >&2; exit 1; }

# --- model: prefer turbo, then large-v3, then medium (override with WHISPER_MODEL)
pick_model() {
  if [ -n "${WHISPER_MODEL:-}" ]; then printf '%s' "$WHISPER_MODEL"; return; fi
  local p
  for p in \
    "$HOME/.cache/whisper.cpp/models/ggml-large-v3-turbo.bin" \
    "$HOME/.cache/openwhispr/whisper-models/ggml-large-v3-turbo.bin" \
    "$HOME/.cache/whisper.cpp/models/ggml-large-v3.bin" \
    "$HOME/.cache/whisper.cpp/models/ggml-medium.bin" \
    "$HOME/.cache/openwhispr/whisper-models/ggml-medium.bin"; do
    [ -f "$p" ] && { printf '%s' "$p"; return; }
  done
  printf ''
}
MODEL="$(pick_model)"
[ -n "$MODEL" ] && [ -f "$MODEL" ] || {
  echo "no whisper model found. Install one, e.g.:" >&2
  echo "  curl -L -o ~/.cache/whisper.cpp/models/ggml-large-v3-turbo.bin \\" >&2
  echo "    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" >&2
  echo "  or set WHISPER_MODEL=/abs/path/ggml-*.bin" >&2
  exit 1
}

WHISPER_BIN="$(command -v whisper-cli || command -v whisper-cpp || command -v main || true)"
[ -n "$WHISPER_BIN" ] || { echo "whisper.cpp binary not found (brew install whisper-cpp)" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)" >&2; exit 1; }

# --- where artifacts go: next to the video by default ---------------------------
SRC_DIR="$(cd "$(dirname "$VIDEO")" && pwd)"
SLUG="$(basename "$VIDEO")"; SLUG="${SLUG%.*}"
SLUG="$(echo "$SLUG" | tr ' ' '-' | tr -cd '[:alnum:]._-' | sed 's/--*/-/g; s/^-//; s/-$//')"
OUT="${OUT_DIR:-$SRC_DIR/$SLUG.media}"
mkdir -p "$OUT/frames"
# even-dim scaling keeps the mjpeg encoder happy on odd-width sources
SCALE="scale=trunc(iw/2)*2:trunc(ih/2)*2"

echo "==> [$SLUG] probing"
ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,width,height \
  -of default=noprint_wrappers=1 "$VIDEO" | tee "$OUT/source-meta.txt"
DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO" 2>/dev/null | head -1)"
DURATION="${DURATION:-0}"

echo "==> [$SLUG] extracting 16kHz mono audio"
ffmpeg -y -loglevel error -i "$VIDEO" -ar 16000 -ac 1 -c:a pcm_s16le "$OUT/audio.wav"

echo "==> [$SLUG] transcribing with $(basename "$MODEL") (lang=$LANG_CODE)"
"$WHISPER_BIN" -m "$MODEL" -f "$OUT/audio.wav" -l "$LANG_CODE" \
  --output-txt --output-srt --output-vtt --output-json -of "$OUT/transcript" -pp
# audio.wav is a pure whisper intermediate (~1.9MB/min) — drop it once the transcript exists.
rm -f "$OUT/audio.wav"

echo "==> [$SLUG] extracting scene-change frames (scene > $SCENE_THRESHOLD)"
# pix_fmt yuvj420p avoids mjpeg "non full-range YUV" failures on screen recordings;
# even-dim scaling keeps the encoder happy on odd-width sources.
# metadata=print dumps each kept frame's pts_time so frames map back to the timeline.
ffmpeg -y -loglevel error -i "$VIDEO" \
  -vf "select='gt(scene,$SCENE_THRESHOLD)',metadata=print:file=$OUT/frames/scene_times.txt,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -fps_mode vfr -pix_fmt yuvj420p -q:v 3 "$OUT/frames/scene_%04d.jpg" || true

echo "==> [$SLUG] capturing first + last anchor frames"
# Short, cut-heavy creatives carry the most information in the opening hook and the
# closing CTA — but scene-detect rarely fires at t=0 or t=end. Always grab both.
ffmpeg -y -loglevel error -i "$VIDEO" -vf "$SCALE" -frames:v 1 -q:v 3 \
  "$OUT/frames/anchor_first.jpg" || true
ffmpeg -y -loglevel error -sseof -0.5 -i "$VIDEO" -vf "$SCALE" -update 1 -frames:v 1 -q:v 3 \
  "$OUT/frames/anchor_last.jpg" || true

echo "==> [$SLUG] filling gaps > ${MAX_GAP}s (static sections scene-detect misses)"
# scene-detect fires on motion, not meaning; a static-but-information-rich stretch
# (app demo, slide, talking head) gets no frame. gap_fill.py returns timestamps that
# keep every unsampled stretch <= MAX_GAP; we grab each and log its known pts_time.
: > "$OUT/frames/gap_times.txt"
gi=0
while IFS= read -r t; do
  [ -z "$t" ] && continue
  printf -v fn "gap_%04d.jpg" "$((gi + 1))"
  if ffmpeg -y -loglevel error -ss "$t" -i "$VIDEO" -vf "$SCALE" -frames:v 1 -q:v 3 "$OUT/frames/$fn"; then
    echo "frame:$gi pts_time:$t" >> "$OUT/frames/gap_times.txt"
    gi=$((gi + 1))
  fi
done < <(python3 "$SCRIPT_DIR/gap_fill.py" "$OUT" "$DURATION" "$MAX_GAP")
echo "    gap frames added: $gi"

echo "==> [$SLUG] building frames.json (timestamp index, dedup near-dups)"
python3 "$SCRIPT_DIR/build_frame_index.py" "$OUT" "$DURATION"

NFRAMES="$(ls -1 "$OUT/frames"/*.jpg 2>/dev/null | wc -l | tr -d ' ')"
echo "==> [$SLUG] DONE"
echo "    transcript: $OUT/transcript.srt"
echo "    frames:     $NFRAMES  (index: $OUT/frames.json)"
echo "    next: Claude reads transcript + frames.json, views key frames, writes the curated transcript.md"
