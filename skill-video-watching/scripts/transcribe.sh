#!/usr/bin/env bash
# Video -> time-mapped transcript + significant frames (with per-frame timestamps).
# whisper.cpp (large-v3-turbo by default) for the transcript, ffmpeg for frames.
#
# This is the MECHANICAL step. It produces artifacts; it does NOT understand the
# video. Claude reads the outputs (transcript + frames.json), decides which frames
# matter, views them, and writes the curated <video>.transcript.md (see SKILL.md).
#
# Usage: ./transcribe.sh "/abs/path/to/video.mov" [lang] [flags]
#   lang: whisper language code. DEFAULT 'auto' — whisper detects it, no need to pass.
#         Force only if auto mislabels a short/ambiguous clip (e.g. 'tr', 'en').
#
# Flags (also settable as env vars):
#   --frames-only          skip whisper entirely; extract frames only. For pure
#                          UI/UX teardowns where no transcript is needed.   (FRAMES_ONLY=1)
#   --mode ui|lecture      sampling preset. 'ui' = MAX_GAP 2.5s (app screens linger
#                          3-5s and change by text only, below scene-detect). 'lecture'
#                          (default) = MAX_GAP 10s for talking-head video.    (MODE=ui)
#   --max-gap N            guarantee a frame at least every N seconds. Overrides the
#                          mode preset.                                       (MAX_GAP=N)
#   --scene-threshold N    ffmpeg scene-change sensitivity, lower = more frames. (SCENE_THRESHOLD=N)
#   --contact-sheet        also emit frames/contact_sheet.jpg — a tiled montage of every
#                          frame, so coverage is verifiable in one glance.   (CONTACT_SHEET=1)
#   --lang CODE            same as the positional lang arg.
#
# Env overrides:
#   WHISPER_MODEL=/abs/path/ggml-*.bin   force a specific model
#   OUT_DIR=/abs/path                    where artifacts go (default: <video_dir>/<slug>.media)
#                                        NOTE: avoid ':' in OUT_DIR — it is special inside the
#                                        ffmpeg filter graph and would truncate the metadata path.
#   DEDUPE_SEC=0.4                       collapse non-anchor frames closer than this
#
# Outputs (in OUT_DIR):
#   transcript.srt       timestamped segments (human-friendly)   [skipped with --frames-only]
#   transcript.json/.txt/.vtt                                    [skipped with --frames-only]
#   frames/frame_*.jpg   selected frames (scene change OR every MAX_GAP, whichever first)
#   frames/anchor_first.jpg / anchor_last.jpg  always-captured first + last frame
#   frames/contact_sheet.jpg  tiled montage of all frames        [--contact-sheet only]
#   frames.json          [{file, t, at, type}] — each frame's pts_time, sorted (Claude reads this)
#   source-meta.txt      ffprobe dump  (audio.wav is created then deleted after transcription)
set -euo pipefail

# --- arg + flag parsing ---------------------------------------------------------
# Positional: first non-flag = VIDEO, second non-flag = LANG_CODE (back-compatible).
VIDEO=""
LANG_CODE=""
FRAMES_ONLY="${FRAMES_ONLY:-0}"
MODE="${MODE:-lecture}"
CONTACT_SHEET="${CONTACT_SHEET:-0}"
# MAX_GAP / SCENE_THRESHOLD: track whether explicitly set so a CLI/env value beats the
# mode preset. Empty here means "fall back to the mode preset" computed below.
MAX_GAP="${MAX_GAP:-}"
SCENE_THRESHOLD="${SCENE_THRESHOLD:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --frames-only)     FRAMES_ONLY=1 ;;
    --contact-sheet)   CONTACT_SHEET=1 ;;
    --mode)            MODE="${2:?--mode needs a value}"; shift ;;
    --mode=*)          MODE="${1#*=}" ;;
    --max-gap)         MAX_GAP="${2:?--max-gap needs a value}"; shift ;;
    --max-gap=*)       MAX_GAP="${1#*=}" ;;
    --scene-threshold) SCENE_THRESHOLD="${2:?--scene-threshold needs a value}"; shift ;;
    --scene-threshold=*) SCENE_THRESHOLD="${1#*=}" ;;
    --lang)            LANG_CODE="${2:?--lang needs a value}"; shift ;;
    --lang=*)          LANG_CODE="${1#*=}" ;;
    --*)               echo "unknown flag: $1" >&2; exit 2 ;;
    *)                 if [ -z "$VIDEO" ]; then VIDEO="$1"
                       elif [ -z "$LANG_CODE" ]; then LANG_CODE="$1"
                       else echo "unexpected arg: $1" >&2; exit 2; fi ;;
  esac
  shift
done

[ -n "$VIDEO" ] || { echo "Usage: transcribe.sh <video> [lang] [--frames-only] [--mode ui] [--max-gap N]" >&2; exit 1; }
LANG_CODE="${LANG_CODE:-auto}"   # whisper auto-detects the spoken language unless overridden

# Mode presets fill in only what the caller left unset (explicit CLI/env always wins).
case "$MODE" in
  ui)      MODE_MAX_GAP=2.5 ;;
  lecture) MODE_MAX_GAP=10 ;;
  *)       echo "unknown --mode '$MODE' (use ui|lecture)" >&2; exit 2 ;;
esac
MAX_GAP="${MAX_GAP:-$MODE_MAX_GAP}"
SCENE_THRESHOLD="${SCENE_THRESHOLD:-0.15}"

# Guard the two numeric knobs before they reach the ffmpeg filter / Python: a non-number
# would crash build_frame_index (float()), and MAX_GAP=0 makes gte(t-prev,0) select EVERY
# frame (disk-fill footgun). Fail loudly instead.
is_num='^[0-9]+([.][0-9]+)?$'
[[ "$MAX_GAP" =~ $is_num ]] || { echo "--max-gap must be a number (got '$MAX_GAP')" >&2; exit 2; }
awk "BEGIN{exit !($MAX_GAP > 0)}" || { echo "--max-gap must be > 0 (got '$MAX_GAP')" >&2; exit 2; }
[[ "$SCENE_THRESHOLD" =~ $is_num ]] || { echo "--scene-threshold must be a number (got '$SCENE_THRESHOLD')" >&2; exit 2; }

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

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)" >&2; exit 1; }

# --- model: prefer turbo, then large-v3, then medium (override with WHISPER_MODEL)
# Only needed for transcription — skip the whole resolution when --frames-only.
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
if [ "$FRAMES_ONLY" != "1" ]; then
  MODEL="$(pick_model)"
  [ -n "$MODEL" ] && [ -f "$MODEL" ] || {
    echo "no whisper model found. Install one, e.g.:" >&2
    echo "  curl -L -o ~/.cache/whisper.cpp/models/ggml-large-v3-turbo.bin \\" >&2
    echo "    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" >&2
    echo "  or set WHISPER_MODEL=/abs/path/ggml-*.bin" >&2
    echo "  (or pass --frames-only to skip transcription entirely)" >&2
    exit 1
  }
  WHISPER_BIN="$(command -v whisper-cli || command -v whisper-cpp || command -v main || true)"
  [ -n "$WHISPER_BIN" ] || { echo "whisper.cpp binary not found (brew install whisper-cpp). Or pass --frames-only." >&2; exit 1; }
fi

# --- where artifacts go: next to the video by default ---------------------------
SRC_DIR="$(cd "$(dirname "$VIDEO")" && pwd)"
SLUG="$(basename "$VIDEO")"; SLUG="${SLUG%.*}"
SLUG="$(echo "$SLUG" | tr ' ' '-' | tr -cd '[:alnum:]._-' | sed 's/--*/-/g; s/^-//; s/-$//')"
OUT="${OUT_DIR:-$SRC_DIR/$SLUG.media}"
mkdir -p "$OUT/frames"
# even-dim scaling keeps the mjpeg encoder happy on odd-width sources
SCALE="scale=trunc(iw/2)*2:trunc(ih/2)*2"

echo "==> [$SLUG] probing (mode=$MODE, max_gap=${MAX_GAP}s, scene>$SCENE_THRESHOLD, frames_only=$FRAMES_ONLY)"
ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,width,height \
  -of default=noprint_wrappers=1 "$VIDEO" | tee "$OUT/source-meta.txt"
DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO" 2>/dev/null | head -1)"
DURATION="${DURATION:-0}"

if [ "$FRAMES_ONLY" = "1" ]; then
  echo "==> [$SLUG] --frames-only: skipping audio + transcription"
else
  echo "==> [$SLUG] extracting 16kHz mono audio"
  ffmpeg -y -loglevel error -i "$VIDEO" -ar 16000 -ac 1 -c:a pcm_s16le "$OUT/audio.wav"

  echo "==> [$SLUG] transcribing with $(basename "$MODEL") (lang=$LANG_CODE)"
  "$WHISPER_BIN" -m "$MODEL" -f "$OUT/audio.wav" -l "$LANG_CODE" \
    --output-txt --output-srt --output-vtt --output-json -of "$OUT/transcript" -pp
  # audio.wav is a pure whisper intermediate (~1.9MB/min) — drop it once the transcript exists.
  rm -f "$OUT/audio.wav"
fi

echo "==> [$SLUG] extracting frames (scene change OR every ${MAX_GAP}s, whichever fires first)"
# ONE decode pass, time-based and frame-rate-independent:
#   eq(n,0)                       always seed the first frame (also primes prev_selected_t)
#   gt(scene,$SCENE_THRESHOLD)    a scene change (slide/UI transition) fired
#   gte(t-prev_selected_t,MAX_GAP) MAX_GAP elapsed since the last KEPT frame — guarantees
#                                 coverage of static stretches scene-detect misses (app
#                                 screens that change by text only). prev_selected_t is
#                                 wall-clock seconds, so this is robust on variable-frame-rate
#                                 screen recordings where frame-number sampling (mod(n,N)) breaks.
# pix_fmt yuvj420p avoids mjpeg "non full-range YUV" failures on screen recordings;
# metadata=print dumps each kept frame's pts_time so frames map back to the timeline.
ffmpeg -y -loglevel error -i "$VIDEO" \
  -vf "select='eq(n,0)+gt(scene,$SCENE_THRESHOLD)+gte(t-prev_selected_t,$MAX_GAP)',metadata=print:file=$OUT/frames/frame_times.txt,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -fps_mode vfr -pix_fmt yuvj420p -q:v 3 "$OUT/frames/frame_%04d.jpg" || true

# The || true above keeps a partial result usable, but zero frames means the decode
# produced nothing (no decodable video stream, unsupported codec, write failure). That
# must fail loudly — silently leaving an empty frames.json is the exact under-sampling
# trap issue #15 is about. Count safely (|| true so a no-match never trips set -e).
NSEL="$(find "$OUT/frames" -name 'frame_*.jpg' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$NSEL" -eq 0 ]; then
  echo "ERROR: ffmpeg extracted 0 frames from '$VIDEO'." >&2
  echo "  The file may have no decodable video stream (audio-only?), an unsupported codec," >&2
  echo "  or the output dir isn't writable. No frames.json written." >&2
  exit 1
fi

echo "==> [$SLUG] capturing first + last anchor frames"
# Short, cut-heavy creatives carry the most information in the opening hook and the
# closing CTA — but scene-detect rarely fires at t=0 or t=end. Always grab both.
ffmpeg -y -loglevel error -i "$VIDEO" -vf "$SCALE" -frames:v 1 -q:v 3 \
  "$OUT/frames/anchor_first.jpg" || true
ffmpeg -y -loglevel error -sseof -0.5 -i "$VIDEO" -vf "$SCALE" -update 1 -frames:v 1 -q:v 3 \
  "$OUT/frames/anchor_last.jpg" || true

echo "==> [$SLUG] building frames.json (timestamp index, dedup near-dups, coverage check)"
MAX_GAP="$MAX_GAP" python3 "$SCRIPT_DIR/build_frame_index.py" "$OUT" "$DURATION"

# --- optional contact sheet: one glance to verify coverage before deep analysis --
if [ "$CONTACT_SHEET" = "1" ]; then
  echo "==> [$SLUG] building contact sheet (coverage montage)"
  NF="$(ls -1 "$OUT/frames"/frame_*.jpg 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$NF" -gt 0 ]; then
    COLS="$(awk -v n="$NF" 'BEGIN{c=int(sqrt(n)); if(c*c<n)c++; print c}')"
    ROWS="$(awk -v n="$NF" -v c="$COLS" 'BEGIN{r=int(n/c); if(r*c<n)r++; print r}')"
    ffmpeg -y -loglevel error -pattern_type glob -i "$OUT/frames/frame_*.jpg" \
      -vf "scale=240:-1,tile=${COLS}x${ROWS}:padding=4:margin=4" -frames:v 1 -q:v 4 \
      "$OUT/frames/contact_sheet.jpg" \
      && echo "    contact sheet: $OUT/frames/contact_sheet.jpg (${COLS}x${ROWS})" \
      || echo "    contact sheet skipped (montage failed)"
  fi
fi

# find -not -name keeps the count set -e-safe (grep -v exits 1 on no-match, tripping pipefail).
NFRAMES="$(find "$OUT/frames" -name '*.jpg' ! -name 'contact_sheet.jpg' 2>/dev/null | wc -l | tr -d ' ')"
echo "==> [$SLUG] DONE"
[ "$FRAMES_ONLY" = "1" ] || echo "    transcript: $OUT/transcript.srt"
echo "    frames:     $NFRAMES  (index: $OUT/frames.json)"
if [ "$FRAMES_ONLY" = "1" ]; then
  echo "    next: Claude reads frames.json, views key frames, writes the curated screen list / transcript.md"
else
  echo "    next: Claude reads transcript + frames.json, views key frames, writes the curated transcript.md"
fi
