# reinfluence (slim) — bundled with dreamcontext

Bundled Python tool used by `dreamcontext marketing competitor ingest`. Does **only** download → transcribe → frame extraction. Emits NDJSON events on stdout. The dreamcontext TS layer parses events, stores normalized data as JSON+`.md` bridges under `_dream_context/marketing/competitors/<handle>/posts/`.

## Why bundled, not pipx-installed
dreamcontext containment rule: every project's marketing tooling lives under `_dream_context/marketing/`. On `mk init` (or first ingest) this folder is copied to `_dream_context/marketing/.tools/reinfluence/` and a per-project venv is created at `_dream_context/marketing/.venv/`.

## System prerequisites (NOT bundled)
- `python3` (≥ 3.10)
- `ffmpeg` + `ffprobe`

`mk doctor` and the `health()` probe in `competitors.ts` enforce these.

## Direct invocation (rare; usually called by TS)
```
.venv/bin/python -m reinfluence ingest <url-or-handle> --out-dir <path> [--model medium] [--max N] [--skip-transcripts] [--skip-frames]
.venv/bin/python -m reinfluence version
```
