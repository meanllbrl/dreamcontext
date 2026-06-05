---
name: video-watching
description: >-
  Watch a video the way a human would — turn it into a time-mapped transcript
  with the on-screen visuals (slides, UI, diagrams, text) described inline, then
  reason about it. Triggers: "watch this video", "şu videoyu izle", "videoyu
  analiz et", "transkript çıkar", "video transcript", "bu videoda ne var", or any
  time the user hands over a video file/link. Produces a curated
  <video>.transcript.md NEXT TO the source video, then continues per use-case
  (marketing teardown, FTE analysis, knowledge capture, …).
alwaysApply: false
ruleType: "Tool Workflow"
version: "1.0"
---

# Video Watching

Turn a video into something an AI can fully reason about: a **time-mapped
transcript** with **what's on screen described inline at the same timestamps**.
The output is one self-contained file dropped **next to the source video**, so any
model (our cloud, this session, anything) can read the whole video without the
binary.

The clever part: **transcript first, then YOU decide which frames to look at.**
You don't blindly OCR every frame. You read the transcript, see where the speaker
references something visual ("as you can see here", "this screen", "the chart"),
look up that moment in `frames.json`, and open only those frames.

## The loop (do these in order)

### 0. Get the video
Ask for the path or link if not given. Local files work today. Remote links
(YouTube etc.) need `yt-dlp` (`brew install yt-dlp`) — the engine auto-downloads
if it's installed.

### 1. Run the engine (mechanical — one command)
```bash
.claude/skills/video-watching/scripts/transcribe.sh "/abs/path/to/video.mov"
#   language auto-detects — no need to pass it. Override only if auto mislabels a
#   short/ambiguous clip: ./transcribe.sh "/abs/path/clip.mp4" tr
```
This writes everything into `<video_dir>/<slug>.media/`:
- `transcript.srt` / `.json` / `.txt` — timestamped transcript (large-v3-turbo)
- `frames/anchor_first.jpg` / `anchor_last.jpg` — first + last frame, always captured
  (short cut-heavy creatives carry the hook and CTA here; scene-detect misses both)
- `frames/scene_*.jpg` — frames at each scene change (slides/UI transitions)
- `frames/gap_*.jpg` — fill frames so no stretch > 10s goes unsampled (catches
  static-but-important sections scene-detect misses: app demos, slides, CTAs)
- `frames.json` — **the index you read**: `[{file, t, at, type}]`, sorted by time,
  near-duplicate timestamps collapsed (anchors always kept)

`audio.wav` is auto-deleted after transcription (it's a ~1.9MB/min whisper-only
intermediate). The whole `*.media/` dir is gitignored — it stays next to the video
as scratch but never enters the repo. Only `<slug>.transcript.md` is the keeper;
delete a `.media/` folder anytime to reclaim disk (re-running regenerates it).

### 2. Read the transcript
Read `transcript.srt`. It carries the spoken content with `[mm:ss]` timing. Form a
first-pass understanding of structure and topic.

### 3. Decide which frames you NEED — then view them
Read `frames.json`. For each moment where understanding depends on the visual —
the speaker points at something, a slide/UI/diagram/number is on screen, or the
transcript is ambiguous without the picture — pick the frame whose `at` is closest
to that moment and **open it with the Read tool** (it renders images). Don't open
all of them; open the ones that carry information. Talking-head stretches with
nothing on screen need no frame.

> Heuristic: the two `anchor` frames (first/last) almost always matter — the hook
> and the CTA. Every `scene` frame is a candidate (the picture changed for a
> reason). `gap` frames cover static stretches scene-detect skipped — often the
> most informative part (an app demo or slide that doesn't "move"), so check them.

**Need a frame the index doesn't have? Grab it on demand.** Scene-detect fires on
motion, not on meaning — on fast-cut video the most informative moment often sits
between the indexed frames. When the VO points at something ("look at this
screen", a number, a result) and no indexed frame lands there, fetch that exact
second yourself:
```bash
ffmpeg -y -loglevel error -ss <seconds> -i "<video>" -frames:v 1 -q:v 3 \
  "<slug>.media/frames/grab_<mmss>.jpg"
```
This is the whole point of transcript-first: the frame set is yours to extend, not
a fixed dump you're stuck with.

### 4. Write the curated transcript NEXT TO the video
Write `<video_dir>/<slug>.transcript.md` — the deliverable. One timeline, voice and
visuals interleaved, every line timestamped:

```markdown
# <Video Title>
source: <path or URL> · duration: <mm:ss> · transcribed: large-v3-turbo

## Summary
2–4 sentences: what this video is and what it's for.

## Timeline
- **[00:00]** <what's said>
- **[00:06]** 🖼 <what's on screen — slide title, UI state, chart, on-screen text>
- **[00:12]** <what's said> … 🖼 <visual if relevant>
...

## Visual notes
- **[00:06]** Slide: "Funnel → Billing → Gateway → PSP" (4 layers)
- ...
```
Rules: never invent content not in transcript or frames; mark anything uncertain;
keep the source path in the header so the file stands alone.

### 5. Hand off to the use-case
Once the `.transcript.md` exists you know the video cold. Tell the user it's ready
and ask what they want from it — the answer is domain-specific. Triage to the
relevant dreamcontext skill (per the skill-triage rule) and load it:
- **Marketing video** → teardown, hook/CTA analysis, "we could do X" (→ `growth` / `meta-marketing` skills)
- **First-time-experience / app demo** → reconstruct the FTE flow, friction points (→ `design` / `onboarding-design`)
- **Knowledge / training** → if it should persist for the project, hand the transcript to `dreamcontext knowledge` so it becomes durable context
Don't guess the use-case — let the user direct it.

## What this skill is NOT
- Not a knowledge-base writer or ingestion pipeline. This skill produces the
  transcript artifact; persisting it (chunking, embedding, ingest into a project's
  long-term memory) is a separate, downstream concern — keep that boundary clean.
- Not an auto-summarizer that skips the frames. The visual pass is the point —
  that's what separates "watched the video" from "read the subtitles".

## Setup (once per machine)
```bash
brew install whisper-cpp ffmpeg          # yt-dlp too, only for remote links
# model: the engine prefers large-v3-turbo, falls back to large-v3 then medium.
# pull turbo if missing:
#   curl -L -o ~/.cache/whisper.cpp/models/ggml-large-v3-turbo.bin \
#     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```
`build_frame_index.py` is stdlib-only — no venv needed. Language **auto-detects**
(whisper); only pass a code (`tr`, `en`) to force it on a short/ambiguous clip.

## Files
```
.claude/skills/video-watching/
├── SKILL.md                    ← you are here
└── scripts/
    ├── transcribe.sh           ← video → transcript + frames + frames.json (the engine)
    ├── gap_fill.py             ← timestamps to fill scene-detect gaps (> MAX_GAP)
    └── build_frame_index.py    ← frames/*.jpg → frames.json (pts_time index)
```

## Tuning
- Too few frames on a slide-heavy video? `SCENE_THRESHOLD=0.1 ./transcribe.sh …`
- Long static lecture over-sampled? Raise `MAX_GAP=20 ./transcribe.sh …` (default 10s).
- Capturing too many near-identical frames? `DEDUPE_SEC=1.0 ./transcribe.sh …`
- Force a model: `WHISPER_MODEL=/abs/ggml-large-v3.bin ./transcribe.sh …`
