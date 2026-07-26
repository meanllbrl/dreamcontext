import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import { runAutomation, killRunGroup, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { createAutomation, readRunSidecar } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';

/**
 * REAL-PROCESS proof that the timeout/kill machinery actually contains the
 * whole process tree, not just the immediate child — the exact defect
 * (`grandchild alive after kill = true` for a non-detached spawn) reproduced
 * during the plan's review. A faked `spawnImpl`/`killImpl` can assert call
 * SHAPES but cannot prove a grandchild process actually dies; only a real
 * process can.
 *
 * Mechanism: `runAutomation`'s own step-7 spawn call is exercised for real —
 * `spawnImpl` here calls the REAL `node:child_process.spawn`, passing through
 * the REAL options object `runAutomation` builds (in particular
 * `detached: true`), but substituting the command/args with a shell script
 * that forks a grandchild and sleeps, instead of `claude`. This proves the
 * REAL spawn options (not a re-derived copy of them) are what get group-killed.
 */
describe.skipIf(process.platform === 'win32')('process-group containment (real process)', () => {
  let projectRoot: string;
  let contextRoot: string;
  let home: string;
  const NOW = new Date('2026-07-26T18:00:00.000Z');

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-automations-pgroup-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(contextRoot, { recursive: true });
    home = mkdtempSync(join(tmpdir(), 'dc-automations-pgroup-home-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('killing the group via killRunGroup terminates a real grandchild, not just the direct child', async () => {
    const manifest = createAutomation(contextRoot, {
      slug: 'real-process-check',
      title: 'Real process check',
      days: 'daily',
      at: '18:00',
      timeoutMinutes: 60, // generous — this test kills the group directly, never waits for the timeout
      prompt: 'irrelevant — the fake spawnImpl below substitutes the real command',
    });
    approveAutomation(projectRoot, manifest, NOW, home);

    let grandchildPid: number | undefined;
    let runPromise: ReturnType<typeof runAutomation> | undefined;
    const grandchildFound = new Promise<void>((resolve) => {
      // spawnImpl runs the REAL spawn(), passing through runAutomation's real
      // options object (cwd/env/stdio/detached) but replacing the command —
      // this is "through the real code path" for the spawn options, while
      // letting the test control what actually executes.
      const realSpawnImpl: SpawnImpl = ((_command: string, _args: string[], options: unknown) => {
        const child = nodeSpawn(
          '/bin/sh',
          ['-c', 'sleep 25 & echo GRANDCHILD=$!; sleep 25'],
          options as Parameters<typeof nodeSpawn>[2],
        );
        child.stdout?.on('data', (chunk: Buffer) => {
          const m = /GRANDCHILD=(\d+)/.exec(chunk.toString('utf-8'));
          if (m) {
            grandchildPid = Number(m[1]);
            resolve();
          }
        });
        return child;
      }) as unknown as SpawnImpl;

      // Fire the run — captured, not awaited yet; we grab the sidecar and
      // kill the group independently below, then await the run's own promise
      // afterward (killing the group makes its 'close' event fire, letting
      // it settle instead of leaking a dangling promise).
      runPromise = runAutomation(contextRoot, manifest.slug, {
        now: () => NOW,
        home,
        spawnImpl: realSpawnImpl,
        notify: () => {},
      });
    });

    await grandchildFound;
    expect(grandchildPid).toBeGreaterThan(0);

    // Poll briefly for the sidecar — step 9 writes it synchronously right
    // after spawn, but this test's own event loop still needs a tick or two
    // to observe the file.
    let sidecar = null;
    for (let i = 0; i < 50 && !sidecar; i++) {
      sidecar = readRunSidecar(contextRoot, manifest.slug);
      if (!sidecar) await new Promise((r) => setTimeout(r, 20));
    }
    expect(sidecar).not.toBeNull();

    // Confirm the grandchild is alive BEFORE the kill (sanity check the fixture).
    expect(() => process.kill(grandchildPid as number, 0)).not.toThrow();

    // `nowMs` MUST ride the same fake clock the sidecar was written with. The
    // run above stamps `startedAt` from `now: () => NOW`, so leaving `nowMs` to
    // default to the real `Date.now()` makes the age check see a sidecar that is
    // however long it has been since NOW — and once that exceeds
    // SIDECAR_PID_REUSE_WINDOW_MS (1h) guard 4 refuses the kill and this test
    // fails for a reason that has nothing to do with process-group containment.
    const result = killRunGroup(contextRoot, manifest.slug, {
      killImpl: process.kill,
      nowMs: NOW.getTime(),
    });
    expect(result.killed).toBe(true);

    // Give the OS a brief moment to actually reap the signalled processes.
    await new Promise((r) => setTimeout(r, 200));

    expect(() => process.kill(grandchildPid as number, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );

    // Let the run's own promise settle now that its child has closed —
    // proves runAutomation itself resolves cleanly after an externally
    // triggered group kill, rather than hanging or rejecting.
    const outcome = await runPromise;
    expect(outcome?.status).toBe('failed'); // stdout was "GRANDCHILD=<pid>", not valid claude JSON
  }, 15_000);
});
