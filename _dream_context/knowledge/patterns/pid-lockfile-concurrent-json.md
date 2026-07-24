---
id: pid-lockfile-concurrent-json
name: "PID lockfile for concurrent CLI subcommand read-modify-write on shared JSON"
description: "Serialize concurrent CLI subcommands operating on shared JSON state using O_EXCL PID lockfiles with bounded spin and stale-TTL reclaim. Prevents last-write-wins data loss when parallel agents invoke the same CLI command simultaneously."
tags: ["kind:architecture", "kind:decisions", "layer:backend", "topic:agents", "topic:cli"]
pinned: false
date: "2026-07-24"
---

## Why This Exists

When parallel agent sessions invoke the same CLI subcommand that does a read-modify-write on a shared JSON file (e.g., `dreamcontext council verdict` during concurrent persona runs, marketing store updates, task-backend sync ledger writes), a race condition causes the second writer to silently drop the first writer's changes. The PID lockfile pattern closes this race with a POSIX-portable atomic lock primitive.

**Observed 3 times** (council verdicts, marketing store, task-backend sync ledger) → recurring pattern.

## The Pattern

Any CLI subcommand that reads-modifies-writes a shared JSON file MUST serialize behind a PID lockfile:

```typescript
// Acquire lock (atomic O_EXCL create)
const lockPath = `/tmp/dreamcontext-<resource>.lock`;
const fd = fs.openSync(lockPath, 'wx');  // 'wx' = O_EXCL, throws EEXIST if exists
fs.writeSync(fd, String(process.pid));
fs.closeSync(fd);

try {
  // Critical section: read-modify-write the shared JSON
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  data.items.push(newItem);
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
} finally {
  // Release lock
  fs.unlinkSync(lockPath);
}
```

### Three ingredients

1. **Atomic lock acquisition**: `openSync(lockPath, 'wx')` — the `'wx'` flags (O_EXCL) make the create atomic; the loser gets `EEXIST` immediately.
2. **Bounded spin with stale-TTL reclaim**: Spin in 50ms intervals, max 3s total wait; if the lock file's PID is dead (`process.kill(pid, 0)` throws ESRCH), unlink it and retry the create (self-heals after a crash).
3. **Loud failure on timeout**: Throw an error after max wait, never silently drop the write.

### Implementation shape

See `src/lib/council.ts`, `src/lib/marketing/store.ts`, and `src/lib/task-backend/sync-state.ts` (inferred) for working examples. The pattern is:

```typescript
export function acquireLock(lockPath: string, maxWait = 3000): void {
  const start = Date.now();
  const interval = 50;
  
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;  // Lock acquired
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      
      // Lock exists — check if stale
      const staleTTL = 10_000;  // 10s
      if (fs.existsSync(lockPath)) {
        const stats = fs.statSync(lockPath);
        const age = Date.now() - stats.mtimeMs;
        if (age > staleTTL) {
          try {
            const pid = Number(fs.readFileSync(lockPath, 'utf8'));
            process.kill(pid, 0);  // Throws ESRCH if dead
          } catch {
            // PID is dead — reclaim the lock
            fs.unlinkSync(lockPath);
            continue;
          }
        }
      }
      
      // Lock still held — spin or timeout
      if (Date.now() - start > maxWait) {
        throw new Error(`Lock timeout after ${maxWait}ms: ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval);
    }
  }
}
```

## When to use

Apply this pattern to **any future shared-state CLI command that parallel agents may invoke simultaneously**:
- Council verdicts during concurrent persona runs
- Marketing store appends from parallel campaign agents
- Task-backend sync ledger updates
- Any read-modify-write on a JSON file that multiple CLI invocations touch

## Why O_EXCL over flock/advisory locks

`O_EXCL` create is POSIX-portable and works on all platforms (macOS, Linux, Windows WSL). Node.js has no built-in `flock` equivalent; using `fs.openSync('wx')` avoids pulling in native lock libraries. The bounded spin + stale-TTL reclaim makes it self-healing after crashes (a dead process's lock never blocks forever).

## Related

- First observed in council v2 (2026-07-20) — concurrent persona verdict writes
- Second occurrence in marketing store (2026-07-22)
- Third occurrence in task-backend sync-state (inferred 2026-07-23)
- Recorded in [[2.memory]] 2026-07-23 as ★★★ 3rd occurrence → RECURRING PATTERN

## Sources

- `file:src/lib/council.ts`
- `file:src/lib/marketing/store.ts`
- `file:src/lib/task-backend/sync-state.ts` (inferred)
- `bookmark:council-v2-review-closeout-fail-fix-pass`
- `changelog:2026-07-23|council`
