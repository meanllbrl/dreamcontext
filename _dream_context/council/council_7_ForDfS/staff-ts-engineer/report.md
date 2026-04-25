---
persona: staff-ts-engineer
rounds_completed: 1
---

## Round 1 — 2026-04-25

# staff-ts-engineer — round 1

### Executive Summary
Plan is structurally sound but not shippable as written. The meta-client port inherits a Tilki script with zero retry, no idempotency, no rate-limit handling, no resumable upload, fragile env loader. Five concurrent sub-agents will produce duplicate campaigns, half-applied launches, silent >50MB upload failures. Do not commit until error-handling, JSON concurrency, and dry-run gating are implemented.

### Position
Adopt the plan's shape (folder layout, CLI surface, sub-agent split, JSON+MD hybrid). Reject the implementation order. v0 ships hardened meta-client + store + config foundation BEFORE any sub-agent file is written. Creative-generator, dashboard charts, council preset all wait.

### Reasoning

**1. Meta-client error-handling contract (mandatory before any real call)**
- Retry: wrap in metaFetch(). Retry on 429, 500, 502, 503, 504, and Meta error.code 1, 2, 4, 17, 32, 613. Max 5 attempts.
- Backoff: exponential w/ jitter, base 1000ms, cap 30s. Honor X-Business-Use-Case-Usage and X-App-Usage headers on 429.
- Idempotency: every create* accepts caller-supplied idempotency_key (UUIDv4). Pre-POST check marketing/runs/by-idem/<key>.json; cache successful response atomically.
- Token expiry: OAuthException code 190 → do NOT retry. Throw TokenExpiredError with regen URL.
- Rate limits: in-process queue per ad-account. Reads unthrottled. Sub-agent fan-out funnels through it.

**2. JSON store concurrency**
Single-writer per file, atomic rename (write to <path>.tmp.<pid>.<rand>, fs.renameSync). Multi-file mutations use write-ahead log: append planned ops to runs/<ts>__<verb>.json first, then execute. Crash recovery = replay last incomplete run. PID lockfile in marketing/.lock enforces single-process.

**3. Env loader spec**
Strip BOM, support \r\n + \n. # is comment (only outside quotes). Quoted values: double-quote allows escapes; single-quote literal. Multiline only inside double quotes. = inside quoted value is literal. process.env wins over file. Reject keys not matching [A-Z_][A-Z0-9_]*. No env-of-env.

**4. Reinfluence subprocess robustness**
health() probe before every ingest: binary resolves, --version exits 0 within 5s, Whisper model present, yt-dlp ok, free disk >2GB. Cache 60s. Stream stdout/stderr line-by-line into run log. Kill at 600s wall-clock. Cap concurrent ingests at 1.

**5. Insights polling**
Sync /insights safe for ≤7d single-campaign. Wider → async: POST async=true → poll /<report_run_id> every 5s up to 5min, then exponential. Default pull=24h sync; --since >7d auto-switches async. Hard timeout 600s.

**6. Asset upload >50MB**
Tilki simple multipart silently fails near 100MB. Required: uploadVideo detects fileSize > 50_000_000 → chunked upload (upload_phase=start/transfer/finish) against graph-video.facebook.com. Chunk 4MB. Throw on chunk failure.

**7. Dry-run enforcement**
Move dry-run out of argv check, into per-call gate inside metaFetch():
  if (ctx.dryRun) { logDry(url, init); return synthesizeFakeResponse(url); }
ctx is required first arg threaded from CLI through every library function. Default ctx.dryRun=true. Only CLI commands flip it on --no-dry-run. Library code cannot construct ctx, only accept one. Bypass-by-refactor impossible.

**8. Launch idempotency**
marketing launch <cohort> records pre-flip state in runs/<ts>__launch.json BEFORE mutating, flips one at a time. Crash → marketing launch resume <run_id>.

### Reactions to peers
No peer reports yet visible — round 1 first dispatch. Will engage in round 2.

### Open questions
- Multi-account: explicit v0 constraint or oversight in plan? Clarify.
- Idempotency cache pruning policy: sleep consolidation, time-based, or never?
- Dry-run default flip after stability period or stay default-on forever?
- Token rotation: config rotate-token CLI in v0, or manual .env edit acceptable?

### v0 vs v1 split (engineering)
**v0 (blocks merge)**: metaFetch + retry + idempotency cache + token-expiry error; env loader (8 rules); store.ts atomic write + PID lock; ctx-threaded dry-run default-true; chunked upload >50MB; Reinfluence health-probe + 600s timeout; runs/ audit log; sync insights only with 24h cap.
**v1 (defer)**: async insights >7d; resumable upload; multi-account; cross-process BUC queue; launch resume; competitor vision pass; council --preset marketing; recharts/perf charts.
