/**
 * `readUsageLimits` — the reader behind the composer's 5-hour + weekly usage bars
 * (src/lib/claude-usage.ts).
 *
 * ── The rule this file exists to enforce ──────────────────────────────────────────────
 * The file being read, `~/.claude.json`, holds the user's `oauthAccount`, `machineID`,
 * `accountUuid` and spend history. So EVERY case below passes an explicit `FIXTURE_HOME`
 * under the OS temp dir, and one test reads the route handler's own source to prove it
 * calls `readUsageLimits()` with ZERO arguments — i.e. that no request-derived value can
 * ever select the file. No test here ever touches the real `~/.claude.json`.
 *
 * The wire shape is asserted at RUNTIME (`Object.keys`), not only by type: a type says
 * what we intended, and the risk being guarded is a field we did NOT intend riding out of
 * the parsed blob into the response.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsageLimits, EMPTY_USAGE_LIMITS } from '../../src/lib/claude-usage.js';

const FIXTURE_HOME = mkdtempSync(join(tmpdir(), 'dc-claude-usage-'));
const CLAUDE_JSON = join(FIXTURE_HOME, '.claude.json');

afterAll(() => { rmSync(FIXTURE_HOME, { recursive: true, force: true }); });

/** Write `~/.claude.json` INTO THE FIXTURE HOME. Never the real one. */
function writeHome(blob: unknown): void {
  mkdirSync(FIXTURE_HOME, { recursive: true });
  writeFileSync(CLAUDE_JSON, typeof blob === 'string' ? blob : JSON.stringify(blob), 'utf-8');
}

const FETCHED = 1787493899524;
const SESSION_RESET = '2026-08-23T17:20:00+00:00';
const WEEKLY_RESET = '2026-08-25T03:59:59+00:00';

/**
 * The live 2026-08-23 sample, verbatim in shape — including the account fields that sit
 * beside the cache in the real file, so the leak assertion below is testing something real.
 */
function liveSample(over: { scopedPercent?: number } = {}): Record<string, unknown> {
  return {
    oauthAccount: { accountUuid: 'acct-secret-uuid', emailAddress: 'someone@example.com' },
    machineID: 'machine-secret-id',
    spend: { total: 1234.56 },
    cachedUsageUtilization: {
      fetchedAtMs: FETCHED,
      utilization: {
        // NOTE: the summary keys carry their number under `utilization`, NOT `percent`.
        five_hour: { utilization: 20, resets_at: SESSION_RESET },
        seven_day: { utilization: 47, resets_at: WEEKLY_RESET },
        limits: [
          { kind: 'session', group: 'session', percent: 20, severity: 'normal', resets_at: SESSION_RESET, is_active: false },
          { kind: 'weekly_all', group: 'weekly', percent: 47, severity: 'normal', resets_at: WEEKLY_RESET, is_active: true },
          {
            kind: 'weekly_scoped', group: 'weekly', percent: over.scopedPercent ?? 44, severity: 'normal',
            resets_at: WEEKLY_RESET, scope: { model: { display_name: 'Fable' } }, is_active: false,
          },
        ],
      },
    },
  };
}

const bar = (res: { limits: Array<{ key: string }> }, key: string) => res.limits.find((l) => l.key === key);

describe('readUsageLimits — the live sample', () => {
  beforeEach(() => { writeHome(liveSample()); });

  it('reads the 5-hour session cap from the summary key, not from `percent`', () => {
    const res = readUsageLimits(FIXTURE_HOME);
    expect(bar(res, 'session')).toEqual({ key: 'session', percent: 20, resetsAt: Date.parse(SESSION_RESET) });
  });

  it('reads the weekly cap and reports when the cache was refreshed', () => {
    const res = readUsageLimits(FIXTURE_HOME);
    expect(bar(res, 'weekly')).toEqual({ key: 'weekly', percent: 47, resetsAt: Date.parse(WEEKLY_RESET) });
    expect(res.fetchedAtMs).toBe(FETCHED);
  });

  it('folds `weekly_scoped` away when it is NOT the binding cap (44 < 47)', () => {
    const res = readUsageLimits(FIXTURE_HOME);
    expect(res.limits).toHaveLength(2);
    expect(bar(res, 'weekly')).not.toHaveProperty('scope');
  });

  it('promotes `weekly_scoped` and names its model when it IS the binding cap (55 > 47)', () => {
    writeHome(liveSample({ scopedPercent: 55 }));
    const res = readUsageLimits(FIXTURE_HOME);
    expect(bar(res, 'weekly')).toEqual({
      key: 'weekly', percent: 55, resetsAt: Date.parse(WEEKLY_RESET), scope: 'Fable',
    });
    // Still ONE weekly bar — the binding rule replaces, it never appends.
    expect(res.limits.filter((l) => l.key === 'weekly')).toHaveLength(1);
  });

  it('keeps the all-models cap when the scoped one merely TIES it (47 == 47)', () => {
    writeHome(liveSample({ scopedPercent: 47 }));
    expect(bar(readUsageLimits(FIXTURE_HOME), 'weekly')).not.toHaveProperty('scope');
  });
});

describe('readUsageLimits — the wire shape is an allowlist, not a spread', () => {
  it('an unscoped bar carries exactly key/percent/resetsAt', () => {
    writeHome(liveSample());
    const session = bar(readUsageLimits(FIXTURE_HOME), 'session')!;
    expect(Object.keys(session).sort()).toEqual(['key', 'percent', 'resetsAt']);
  });

  it('a scoped bar adds exactly `scope`, as a string', () => {
    writeHome(liveSample({ scopedPercent: 55 }));
    const weekly = bar(readUsageLimits(FIXTURE_HOME), 'weekly')! as { scope?: unknown };
    expect(Object.keys(weekly).sort()).toEqual(['key', 'percent', 'resetsAt', 'scope']);
    expect(typeof weekly.scope).toBe('string');
  });

  it('the serialized response leaks no account field from the source blob', () => {
    writeHome(liveSample());
    const body = JSON.stringify(readUsageLimits(FIXTURE_HOME));
    // The fixture really does carry these beside the cache — see liveSample().
    for (const secret of ['accountUuid', 'spend', 'oauthAccount', 'machineID', 'emailAddress']) {
      expect(body, `"${secret}" reached the wire`).not.toContain(secret);
    }
  });
});

describe('readUsageLimits — malformed input yields an ABSENT bar, never a zeroed one', () => {
  it('1. no file at all', () => {
    rmSync(CLAUDE_JSON, { force: true });
    expect(readUsageLimits(FIXTURE_HOME)).toEqual(EMPTY_USAGE_LIMITS);
  });

  it('2. a file with no `cachedUsageUtilization` key', () => {
    writeHome({ oauthAccount: { accountUuid: 'x' }, numStartups: 42 });
    expect(readUsageLimits(FIXTURE_HOME)).toEqual(EMPTY_USAGE_LIMITS);
  });

  it('3. malformed JSON', () => {
    writeHome('{');
    expect(readUsageLimits(FIXTURE_HOME)).toEqual(EMPTY_USAGE_LIMITS);
  });

  it('4. a percent that is a string, not a number', () => {
    const blob = liveSample();
    const util = (blob.cachedUsageUtilization as Record<string, Record<string, Record<string, unknown>>>).utilization;
    util.five_hour = { utilization: '20', resets_at: SESSION_RESET };
    (util.limits as unknown as unknown[]).length = 0; // no fallback entry to rescue it
    const res = readUsageLimits(blobHome(blob));
    expect(bar(res, 'session')).toBeUndefined();
    expect(res.fetchedAtMs).toBe(FETCHED);
  });

  it('5. a percent outside [0,100] — dropped, never clamped to 100', () => {
    const blob = liveSample();
    const util = (blob.cachedUsageUtilization as Record<string, Record<string, Record<string, unknown>>>).utilization;
    util.five_hour = { utilization: 140, resets_at: SESSION_RESET };
    (util.limits as unknown as unknown[]).length = 0;
    const res = readUsageLimits(blobHome(blob));
    expect(bar(res, 'session')).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('100');
  });

  it('6. an unparseable `resets_at` — a window with no known reset cannot be labelled', () => {
    const blob = liveSample();
    const util = (blob.cachedUsageUtilization as Record<string, Record<string, Record<string, unknown>>>).utilization;
    util.five_hour = { utilization: 20, resets_at: 'soon' };
    (util.limits as unknown as unknown[]).length = 0;
    expect(bar(readUsageLimits(blobHome(blob)), 'session')).toBeUndefined();
  });

  it('a null `resets_at` is treated the same way', () => {
    const blob = liveSample();
    const util = (blob.cachedUsageUtilization as Record<string, Record<string, Record<string, unknown>>>).utilization;
    util.seven_day = { utilization: 47, resets_at: null };
    (util.limits as unknown as unknown[]).length = 0;
    expect(bar(readUsageLimits(blobHome(blob)), 'weekly')).toBeUndefined();
  });

  it('never throws on a hostile shape (arrays and nulls where objects are expected)', () => {
    writeHome({ cachedUsageUtilization: { fetchedAtMs: 'nope', utilization: [1, 2, 3] } });
    expect(() => readUsageLimits(FIXTURE_HOME)).not.toThrow();
    expect(readUsageLimits(FIXTURE_HOME)).toEqual(EMPTY_USAGE_LIMITS);
    writeHome({ cachedUsageUtilization: null });
    expect(readUsageLimits(FIXTURE_HOME)).toEqual(EMPTY_USAGE_LIMITS);
  });
});

describe('readUsageLimits — the `limits[]` fallback', () => {
  it('fills a missing summary key from the matching `limits[]` entry', () => {
    const blob = liveSample();
    const util = (blob.cachedUsageUtilization as Record<string, Record<string, unknown>>).utilization;
    delete util.five_hour;
    delete util.seven_day;
    const res = readUsageLimits(blobHome(blob));
    expect(bar(res, 'session')).toEqual({ key: 'session', percent: 20, resetsAt: Date.parse(SESSION_RESET) });
    expect(bar(res, 'weekly')).toEqual({ key: 'weekly', percent: 47, resetsAt: Date.parse(WEEKLY_RESET) });
  });

  it('uses the scoped entry as the weekly bar when it is the ONLY weekly reading', () => {
    const blob = liveSample();
    const util = (blob.cachedUsageUtilization as Record<string, Record<string, unknown>>).utilization;
    delete util.seven_day;
    util.limits = (util.limits as unknown[]).filter((e) => (e as { kind: string }).kind !== 'weekly_all');
    expect(bar(readUsageLimits(blobHome(blob)), 'weekly')).toEqual({
      key: 'weekly', percent: 44, resetsAt: Date.parse(WEEKLY_RESET), scope: 'Fable',
    });
  });
});

/**
 * The `home` parameter is a TEST SEAM. This proves the production caller does not use it —
 * if someone ever threads a request value in, this fails and says why.
 */
describe('the route never lets a request choose which file is read', () => {
  const repoRoot = new URL('../../', import.meta.url).pathname;
  const source = readFileSync(join(repoRoot, 'src/server/routes/agent-usage.ts'), 'utf-8');

  it('calls readUsageLimits() with ZERO arguments', () => {
    expect(source).toContain('readUsageLimits()');
    // Any argument at all — `req`, a vault, a contextRoot — is the failure this guards.
    expect(/readUsageLimits\(\s*[^)\s]/.test(source), 'readUsageLimits was called with an argument').toBe(false);
  });

  it('never reaches homedir()/userInfo() itself — the lib owns that decision', () => {
    expect(source).not.toContain('homedir');
    expect(source).not.toContain('userInfo');
  });

  it('the lib honours $HOME (homedir), never os.userInfo().homedir which ignores it', () => {
    const lib = readFileSync(join(repoRoot, 'src/lib/claude-usage.ts'), 'utf-8');
    expect(lib).toContain('homedir()');
    // Asserted on the IMPORT, not on a substring of the whole file: the doc comment names
    // `os.userInfo().homedir` in order to explain why it is rejected, and a bare
    // `not.toContain('userInfo(')` would fail on that explanation. You cannot call it
    // without importing it, so the import line is the real gate.
    const osImport = /import\s*\{([^}]*)\}\s*from\s*'node:os'/.exec(lib)?.[1] ?? '';
    expect(osImport).toContain('homedir');
    expect(osImport).not.toContain('userInfo');
  });
});

/** Written to the fixture home and returns it — keeps every case's path in one place. */
function blobHome(blob: unknown): string {
  writeHome(blob);
  return FIXTURE_HOME;
}
