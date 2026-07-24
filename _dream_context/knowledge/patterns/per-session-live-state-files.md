---
id: per-session-live-state-files
name: "Per-session live-state files for concurrent-session dashboard features"
description: "Dashboard features tracking live agent run/progress state MUST use per-session files scoped by CLAUDE_CODE_SESSION_ID to prevent last-write-wins clobber when multiple sessions run the same feature simultaneously. Established pattern for goal-skill and council-live."
tags: ["kind:architecture", "kind:decisions", "layer:frontend", "layer:backend", "topic:dashboard", "topic:agents"]
pinned: false
date: "2026-07-24"
---

## Why This Exists

A dashboard feature that tracks live run/progress state in a single project-scoped file causes last-write-wins clobber when two agent sessions run the same feature simultaneously. The second session's write overwrites the first's state, making the first session's progress invisible in the dashboard.

**Observed twice** (goal-skill clobber fixed, then council-live followed the pattern) → established as the standing pattern for any future live-tracking dashboard feature.

## The Pattern

Any dashboard feature tracking live agent state MUST use **per-session files scoped by `CLAUDE_CODE_SESSION_ID`**, not a single project-scoped file.

### File path convention

```
_dream_context/tmp/.<feature>-live.${SESSION_ID}.json
```

Examples:
- `_dream_context/tmp/.goal-live.abc123.json` (goal-skill session abc123)
- `_dream_context/tmp/.council-live.def456.json` (council session def456)

### Backend pattern

The orchestrator (skill/agent) writes **only its own session file**:

```typescript
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
const livePath = path.join(tmpDir, `.${featureName}-live.${sessionId}.json`);

// Write state
fs.writeFileSync(livePath, JSON.stringify(state));

// Optional: sweep abandoned runs at start (>3h stale)
const allLiveFiles = glob.sync(`${tmpDir}/.${featureName}-live.*.json`);
const now = Date.now();
for (const file of allLiveFiles) {
  const age = now - fs.statSync(file).mtimeMs;
  if (age > 3 * 60 * 60 * 1000) {  // 3 hours
    fs.unlinkSync(file);
  }
}
```

### Dashboard route pattern

The route scans the glob and matches by session stamp:

```typescript
app.get('/api/<feature>/live', (req, res) => {
  const sessionId = req.query.session || process.env.CLAUDE_CODE_SESSION_ID;
  
  // Try session-specific file first
  const sessionPath = path.join(tmpDir, `.${featureName}-live.${sessionId}.json`);
  if (fs.existsSync(sessionPath)) {
    return res.json(JSON.parse(fs.readFileSync(sessionPath, 'utf8')));
  }
  
  // Fall back to unstamped legacy file (back-compat)
  const legacyPath = path.join(tmpDir, `.${featureName}-live.json`);
  if (fs.existsSync(legacyPath)) {
    return res.json(JSON.parse(fs.readFileSync(legacyPath, 'utf8')));
  }
  
  res.json(null);  // No live state
});
```

### Key rules

1. **Orchestrators write only their own session file** — scoped by `CLAUDE_CODE_SESSION_ID`
2. **Routes read-only scan** — never delete, never write (only orchestrators write)
3. **Unstamped legacy files serve as visible-to-all fallback** for back-compat with pre-session-scoped code
4. **Sweep abandoned runs opportunistically at orchestrator start** (>3h stale) to prevent unbounded accumulation

## When to use

Apply this pattern to **any future dashboard feature that needs to track live run/progress state for concurrent agent sessions**:
- Goal-skill live panel (first occurrence — fixed concurrent-run clobber)
- Council live chamber panel (second occurrence — followed the pattern immediately)
- Any future multi-agent orchestrator with dashboard visibility (e.g., marketing campaigns, task-backend sync progress)

## What NOT to use this for

- **Persistent state** (tasks, knowledge, features) — use the canonical storage, not tmp files
- **Cross-session aggregates** (changelog, metrics) — these deliberately merge all sessions
- **Single-session-only features** — if concurrent runs are impossible by design, a single file is fine

## Why session-scoped, not session-deduplicated writes

A shared file with session-stamped writes (e.g., `{"sessions": {"abc": {...}, "def": {...}}}`) would work but requires orchestrators to read-modify-write — reintroducing the race condition this pattern avoids. Per-session files are simpler: each orchestrator writes only its own state, zero coordination needed.

## Related

- First occurrence: [[goal-skill]] live state (fixed concurrent-run clobber, 2026-07-23)
- Second occurrence: [[council-live]] (followed the pattern immediately, 2026-07-23)
- Recorded in [[2.memory]] 2026-07-23 as ★★ 2nd occurrence class → STANDING PATTERN

## Sources

- `file:skill-packs/goal-skill/SKILL.md`
- `file:skill-packs/goal-skill/assets/goal-skill-viewer.cjs`
- `file:src/lib/council.ts`
- `file:dashboard/src/lib/goalLive.ts`
- `file:dashboard/src/lib/councilLive.ts`
- `changelog:2026-07-23|goal-skill`
