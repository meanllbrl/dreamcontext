/** The picker's Antigravity fixes: the install runs on its own long clock, before a sign-in's short one. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/t3-bridge/node-floor.js', async (real) => ({ ...(await real<object>()), bridgeNode: () => '/node22' }));

const { ANTIGRAVITY_INSTALL_TIMEOUT_MS, defaultFixDeps, runFix } = await import('../../src/lib/onboarding/fixes.js');

const sink = (lines: string[]) => ({ output: (c: string) => lines.push(c), progress: () => undefined, awaiting: () => undefined, deviceCode: () => undefined, onCancel: () => undefined }) as never;
const ctx = { home: '/tmp/dc-agy-fix', execPath: '/node22', platform: 'darwin', arch: 'arm64' } as never;
const call = (ok: (action: string) => boolean, say?: (action: string) => string) => vi.fn(async (_f: string, a: string[], _o: { timeoutMs: number }, s: { output: (c: string) => void }) => {
  if (say) s.output(say(a[2]!));
  return { ok: ok(a[2]!), stdout: '', stderr: '', code: 0 };
});

describe('antigravity fixes', () => {
  it('a sign-in installs first, each on its own clock, and shows only the Google page', async () => {
    const run = call(() => true, (action) => (action === 'signin' ? '{"signInUrl":"https://accounts.google.com/o/oauth2/v2/auth?x=1"}\n{"ok":true}\n' : '{"ok":true}\n'));
    const lines: string[] = [];
    const r = await runFix('antigravity-signin', ctx, sink(lines), new AbortController().signal, {}, { ...defaultFixDeps, env: { DREAMCONTEXT_CLI: '/cli' }, run } as never);
    expect(r).toEqual({ ok: true });
    expect(run.mock.calls.map((c) => c[1].slice(1, 3))).toEqual([['t3-account', 'install'], ['t3-account', 'signin']]);
    expect(run.mock.calls[0]![2].timeoutMs).toBe(ANTIGRAVITY_INSTALL_TIMEOUT_MS);
    expect(run.mock.calls[1]![2].timeoutMs).toBeLessThan(ANTIGRAVITY_INSTALL_TIMEOUT_MS);
    expect(lines.join('')).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1\n');
  });

  it('a failed install never opens a sign-in', async () => {
    const run = call((action) => action !== 'install');
    const r = await runFix('antigravity-signin', ctx, sink([]), new AbortController().signal, {}, { ...defaultFixDeps, env: { DREAMCONTEXT_CLI: '/cli' }, run } as never);
    expect(r).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('the install fix runs the install alone', async () => {
    const run = call(() => true);
    await runFix('antigravity-install', ctx, sink([]), new AbortController().signal, {}, { ...defaultFixDeps, env: { DREAMCONTEXT_CLI: '/cli' }, run } as never);
    expect(run.mock.calls.map((c) => c[1][2])).toEqual(['install']);
  });
});
