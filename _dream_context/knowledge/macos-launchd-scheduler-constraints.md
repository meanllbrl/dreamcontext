---
name: macos-launchd-scheduler-constraints
description: macOS launchd scheduler constraints discovered during automations build—no runtime watchdog, misses fires while asleep, minimal PATH, shell resolution differences—and how the design accommodates them
type: knowledge
tags:
  - topic:macos
  - domain:infrastructure
  - kind:decisions
  - topic:automations
created: "2026-07-26"
updated: "2026-07-26"
pinned: false
---

# macOS launchd Scheduler Constraints

Constraints and quirks of macOS launchd discovered empirically during the automations feature build (2026-07-25), verified against `man launchd.plist` and live testing on macOS 26.3.

## Key Constraints

### 1. No runtime watchdog

**Constraint:** `TimeOut` key is documented as "never did anything interesting and is no longer implemented." `ExitTimeOut` only covers the SIGTERM→SIGKILL delay when a job is being STOPPED (by launchctl unload), not the runtime.

**Consequence:** A hung job runs forever. No automatic kill after N minutes.

**Implication for automations:** The runner's timeout (`timeoutMinutes`, default 15, cap 60) is implemented IN the runner process itself via `setTimeout` + `SIGTERM → SIGKILL`. But if the runner is killed (e.g., Force Quit, `kill -9`), the timeout timer dies with it, and the detached child can run unbounded. **No automatic reaper** — an orphaned child blocks further runs of that automation until an operator runs `automations kill <slug>`.

**Alternative considered and declined for v1:** A POSIX background+watchdog idiom wrapping the `--version` preflight. Rejected because: (a) the exposure is NOT new (exec'ing a hung binary hangs identically with no preflight at all), (b) there is no `timeout(1)` command on macOS (only Perl), (c) macOS launchd has no runtime watchdog anyway, so adding one layer deeper doesn't fundamentally change the failure mode.

### 2. Misses scheduled fires while system is asleep or job is running

**Constraint (documented verbatim):** "If the system is asleep during the time of the next scheduled interval firing, that interval will be missed due to shortcomings in `kqueue(3)`. If the job is running during an interval firing, that interval firing will likewise be missed."

**Consequence:** `StartCalendarInterval` (e.g., "run at 18:00 daily") silently skips the fire if the laptop was asleep at 18:00, or if the previous run is still in progress.

**Implication for automations:** The feature uses a **watermark + catch-up model**, not calendar fires:
- Dispatcher ticks every 5 minutes (`StartInterval 300`) regardless of calendar.
- Each automation has a `lastFireAt` watermark (the last fire it successfully started a run for).
- `isDue` returns true iff: `now ≥ mostRecentFire(schedule, now)` AND `lastFireAt < mostRecentFire` AND `now − mostRecentFire ≤ catchupHours`.
- A laptop asleep at 18:00 wakes at 18:04 → tick at 18:05 sees "fire was 18:00, last fire was yesterday 18:00, we're within catchup window" → runs it with `firedAt: '18:00'` (not 18:05), advances watermark to 18:00.
- If the laptop wakes at 02:00 (8 hours later, outside the default 6h catchup window), the 18:00 fire is skipped and `mostRecentFire` advances to today 18:00.

**Why this works better than calendar fires:** Catch-up policy is EXPLICIT and under user control (`catchupHours`), not a launchd implementation detail that silently varies by wake timing.

### 3. Minimal PATH — `/usr/bin:/bin:/usr/sbin:/sbin` only

**Constraint:** A launchd job's default environment `PATH` is only `/usr/bin:/bin:/usr/sbin:/sbin`. Verified empirically via `launchctl print gui/501/com.dreamcontext.automations` showing `PATH = /usr/bin:/bin:/usr/sbin:/sbin`.

**Consequence:** `dreamcontext` is NOT findable at all under this PATH. nvm installs live at `~/.nvm/versions/node/<ver>/bin/`. npm global installs (including those via nvm) live there too. `~/.local/bin` (where `claude` CLI installer puts binaries) is also absent.

**Implication for automations:** The dispatcher wrapper MUST either:
1. Bake the absolute resolved path to the CLI at install time, OR
2. Use an interactive login shell (`zsh -ilc`) to source `~/.zshrc` (which sets PATH for nvm + `~/.local/bin`)

The feature does **both** (belt and braces): generated wrapper script has a baked fast-path that invokes the absolute bin directly, PLUS an `-ilc` fallback if the baked path is gone/unrunnable (e.g., after `nvm use` switches node versions and the old install dir is deleted).

### 4. Shell resolution differences: `-lc` vs `-ilc`

**Constraint (measured empirically 2026-07-25):**
- `zsh -lc 'command -v dreamcontext'` → `/opt/homebrew/bin/dreamcontext` (a DIFFERENT install, or nothing on machines without homebrew)
- `zsh -ilc 'command -v dreamcontext'` → `~/.nvm/versions/node/v20.19.0/bin/dreamcontext` (the npm-linked one)

**Root cause:** On this machine (and many others), `~/.zprofile` and `~/.zshenv` are EMPTY. nvm's PATH manipulation and `~/.local/bin` addition live in `~/.zshrc`, which zsh sources ONLY for interactive shells (`-i`). Login shells (`-l`) do NOT source `~/.zshrc`.

**Consequence:** A `-lc` dispatcher invokes a different (or on some machines, NO) `dreamcontext` than the user's actual install → the scheduler installs cleanly and then silently never runs the right binary, or fails with "command not found."

**Implication for automations:** The dispatcher wrapper uses `zsh -ilc` (interactive login) for its fallback branch, NOT `zsh -lc`. The runner itself (inside an automation job) also uses `-ilc` when spawning `claude`, matching the existing agent-terminal.ts pattern.

**Related fix:** `src/lib/ensure-cli.ts` probe script was updated from `-lc` alone to `-lc` with an `|| -ic` fallback, for the same reason (it would misreport install readiness if the CLI is only reachable via `~/.zshrc`).

### 5. No `timeout(1)` command on macOS

**Constraint:** GNU coreutils `timeout` does not ship with macOS. `/usr/bin/timeout` does not exist. Only Perl is available (`/usr/bin/perl`).

**Consequence:** Cannot use `timeout 15m dreamcontext automations tick` as a hard outer bound.

**Implication for automations:** Timeout enforcement is implemented IN the runner's Node.js process via `setTimeout` + group SIGKILL, not as an outer shell wrapper. This is why the runner spawns the child `detached: true` and signals the whole process group (`-pid`) — otherwise grandchildren would survive the timeout kill.

## Design Reconciliations

### Wrapper indirection (§1.1 of the validated plan)

The plist never bakes the CLI path directly. Instead, it runs `/bin/sh <wrapper>`, where `~/.dreamcontext/bin/automations-dispatch.sh` is a generated script written at install time:

```sh
#!/bin/sh
# Generated by `dreamcontext automations install` at <ISO>.
DC_BIN=<shq(resolved abs path)>
DC_SHELL=<shq($SHELL at install, else /bin/zsh)>
export PATH=<shq(PATH captured at install via $SHELL -ilc)>

# Preflight with REAL invocation, never `[ -x ]` alone.
if [ -x "$DC_BIN" ] && "$DC_BIN" --version >/dev/null 2>&1; then
  exec "$DC_BIN" automations tick --all < /dev/null
fi

# Baked path gone or unrunnable — re-resolve through interactive login shell.
exec "$DC_SHELL" -ilc 'exec dreamcontext automations tick --all' < /dev/null
```

**Why this works:**
- Fast path (baked absolute bin + `--version` preflight) covers the normal case (0.04s on this machine).
- Fallback (`-ilc`) covers: nvm node bump deleted the baked dir; npm upgrade changed the binary; the baked bin exists but is unrunnable (broken shebang, sandbox refusal).
- **Survives npm upgrades with no plist change** — the stated constraint from the task. The plist points at the wrapper (which is stable), and the wrapper re-resolves if needed.

**Install-time verification:**
- `resolveDispatcherTarget()` uses `$SHELL -ilc 'command -v dreamcontext; printf "%s" "$PATH"'` to resolve the binary and capture PATH.
- `installDispatcher()` refuses if nothing resolves.
- Warns and requires `--force` if the resolved path differs from the currently-running CLI (likely: user is npm-linking a worktree for testing and forgot to point the global install back).
- `install --check` is read-only, writes nothing, renders the resolved path + heartbeat timestamps.

### No staleness warning (declined for v1)

The automations tick writes two heartbeat timestamps to `~/.dreamcontext/automations-tick.json`:
- `lastTickStartedAt` — when the tick began
- `lastTickCompletedAt` — when it finished (after all due automations ran sequentially)

But there is **no staleness warning** if these timestamps are old. Why?

1. **Healthy ticks can legitimately run for hours.** `recordTickCompleted` fires once after ALL due automations across ALL projects have run sequentially. With `MAX_TIMEOUT_MINUTES = 60` and multiple same-fire-time automations, a tick can run 2–4 hours and still be healthy.
2. **Laptop asleep is an expected miss, not a dead dispatcher.** A laptop asleep at fire time misses that fire (launchd constraint #2 above), but the dispatcher is fine — it'll fire again 5 minutes after wake.
3. **Any flat threshold would false-alarm during the busiest correct operation.**

The raw timestamps are shown by `install --check` (for human inspection), but no automated staleness verdict is computed.

**Accepted cost:** A permanently wedged dispatcher (e.g., hung on an unresponsive NFS mount during a glob) freezes both heartbeat timestamps, but is NOT auto-detected. The human discovers it when expected output is missing. A watchdog around the `--version` preflight was considered and declined (see constraint #1 above).

## Validation Results

All five constraints above were verified empirically, not assumed:

1. **No watchdog:** `man launchd.plist` quoted verbatim. No `timeout(1)` confirmed via `which timeout` (exit 1).
2. **Misses fires while asleep:** `man launchd.plist` quoted verbatim. Watermark model tested with simulated catch-up windows.
3. **Minimal PATH:** `launchctl print gui/501/com.dreamcontext.automations` output showed `PATH = /usr/bin:/bin:/usr/sbin:/sbin`. Wrapper's baked PATH verified to include `~/.nvm/.../bin` and `~/.local/bin`.
4. **Shell resolution:** Measured directly on 2026-07-25 under `env -i` (no tty, stdin closed) to simulate launchd environment. `-lc` resolved wrong binary; `-ilc` resolved correct one.
5. **Real launchd lifecycle validated:** two observed scheduled fires in `~/.dreamcontext/logs/automations.log`, fix propagated with no plist change (wrapper picked up rebuilt binary on next tick), clean uninstall (plist removed, booted out).

## Related

- Feature: `knowledge/features/automations-scheduled-headless-claude-jobs.md` — the full automations PRD
- Task: `state/automations-scheduled-headless-claude-jobs.md` — §1.1 dispatcher wrapper design, §1.4 timeout + orphan handling
- Code: `src/lib/automations/launchd.ts` — `resolveDispatcherTarget`, `renderDispatcherWrapper`, `installDispatcher`
- Pattern: `knowledge/patterns/test-isolation-injectable-home.md` — related lesson from same build (test pollution via real HOME)
