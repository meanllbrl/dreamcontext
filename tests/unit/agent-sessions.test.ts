/**
 * Unit tests for the agent-sessions route's PUT validation (`sanitizeRoster`):
 *   - rejects a non-object body / non-array `sessions` (→ null, the handler's 400)
 *   - caps the roster length to MAX_SESSIONS (drops extras)
 *   - clamps title length (200) and size ([0.1, 10]), defaults a blank title
 *   - coerces the booleans (only `true` is true)
 *   - strips every field outside the known four
 *   - keeps `kind` only when it names a known session surface, and `automation`
 *     only alongside `kind: 'automation'` (T18a / C11)
 *
 * Plus the GET handler's transient `bound` flag (T18a / X2), which is the whole
 * reason the roster route now reaches into the automations session registry.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  sanitizeRoster, MAX_SESSIONS, handleAgentSessionsGet, type SavedMeta,
} from '../../src/server/routes/agent-sessions.js';
import { recordAutomationSession } from '../../src/lib/automations/session-registry.js';

const valid = (over: Partial<SavedMeta> = {}): SavedMeta => ({
  title: 'Agent', bypass: false, minimized: false, size: 1, ...over,
});

describe('MAX_SESSIONS', () => {
  it('is 20', () => {
    expect(MAX_SESSIONS).toBe(20);
  });
});

describe('sanitizeRoster — body shape rejection', () => {
  it('returns null for a non-array `sessions`', () => {
    expect(sanitizeRoster({ sessions: 'nope' })).toBeNull();
    expect(sanitizeRoster({ sessions: 42 })).toBeNull();
    expect(sanitizeRoster({ sessions: { 0: 'x' } })).toBeNull();
    expect(sanitizeRoster({ sessions: null })).toBeNull();
  });

  it('returns null when `sessions` is absent', () => {
    expect(sanitizeRoster({})).toBeNull();
  });

  it('returns null for a non-object body', () => {
    expect(sanitizeRoster(null)).toBeNull();
    expect(sanitizeRoster(undefined)).toBeNull();
    expect(sanitizeRoster('string')).toBeNull();
    expect(sanitizeRoster(123)).toBeNull();
    expect(sanitizeRoster([])).toBeNull(); // a top-level array is not the `{ sessions }` envelope
  });

  it('returns an empty array for an empty `sessions` array', () => {
    expect(sanitizeRoster({ sessions: [] })).toEqual([]);
  });
});

describe('sanitizeRoster — length cap', () => {
  it('caps the roster to MAX_SESSIONS, dropping extras', () => {
    const sessions = Array.from({ length: 50 }, (_, i) => valid({ title: `Agent ${i}` }));
    const out = sanitizeRoster({ sessions });
    expect(out).toHaveLength(MAX_SESSIONS);
    // Keeps the FIRST 20 (slice from the head), not the tail.
    expect(out?.[0].title).toBe('Agent 0');
    expect(out?.[MAX_SESSIONS - 1].title).toBe(`Agent ${MAX_SESSIONS - 1}`);
  });

  it('passes through a roster at the cap unchanged in length', () => {
    const sessions = Array.from({ length: MAX_SESSIONS }, () => valid());
    expect(sanitizeRoster({ sessions })).toHaveLength(MAX_SESSIONS);
  });
});

describe('sanitizeRoster — title coercion + clamp', () => {
  it('trims and caps the title at 200 chars', () => {
    const longTitle = 'x'.repeat(500);
    const out = sanitizeRoster({ sessions: [valid({ title: longTitle })] });
    expect(out?.[0].title).toHaveLength(200);
  });

  it('trims surrounding whitespace', () => {
    const out = sanitizeRoster({ sessions: [valid({ title: '  Refactor  ' })] });
    expect(out?.[0].title).toBe('Refactor');
  });

  it('defaults a blank / whitespace-only title to "Agent"', () => {
    expect(sanitizeRoster({ sessions: [valid({ title: '' })] })?.[0].title).toBe('Agent');
    expect(sanitizeRoster({ sessions: [valid({ title: '   ' })] })?.[0].title).toBe('Agent');
  });

  it('defaults a non-string title to "Agent"', () => {
    const out = sanitizeRoster({ sessions: [{ title: 123, bypass: true, minimized: false, size: 1 }] });
    expect(out?.[0].title).toBe('Agent');
  });
});

describe('sanitizeRoster — size clamp', () => {
  it('clamps size below the floor up to 0.1', () => {
    expect(sanitizeRoster({ sessions: [valid({ size: -5 })] })?.[0].size).toBe(0.1);
    expect(sanitizeRoster({ sessions: [valid({ size: 0 })] })?.[0].size).toBe(0.1);
  });

  it('clamps size above the ceiling down to 10', () => {
    expect(sanitizeRoster({ sessions: [valid({ size: 9999 })] })?.[0].size).toBe(10);
  });

  it('defaults a non-finite / non-number size to 1', () => {
    expect(sanitizeRoster({ sessions: [valid({ size: NaN })] })?.[0].size).toBe(1);
    expect(sanitizeRoster({ sessions: [{ title: 'A', size: 'big' }] })?.[0].size).toBe(1);
    expect(sanitizeRoster({ sessions: [{ title: 'A' }] })?.[0].size).toBe(1);
  });

  it('keeps an in-range size verbatim', () => {
    expect(sanitizeRoster({ sessions: [valid({ size: 2.5 })] })?.[0].size).toBe(2.5);
  });
});

describe('sanitizeRoster — boolean coercion', () => {
  it('treats only literal `true` as true for bypass/minimized', () => {
    const out = sanitizeRoster({ sessions: [
      { title: 'A', bypass: true, minimized: true, size: 1 },
      { title: 'B', bypass: 1, minimized: 'yes', size: 1 },
      { title: 'C', bypass: 'true', minimized: 0, size: 1 },
    ] });
    expect(out?.[0]).toMatchObject({ bypass: true, minimized: true });
    expect(out?.[1]).toMatchObject({ bypass: false, minimized: false });
    expect(out?.[2]).toMatchObject({ bypass: false, minimized: false });
  });

  it('defaults missing booleans to false', () => {
    const out = sanitizeRoster({ sessions: [{ title: 'A', size: 1 }] });
    expect(out?.[0]).toMatchObject({ bypass: false, minimized: false });
  });
});

describe('sanitizeRoster — field stripping', () => {
  it('keeps ONLY the four known fields, dropping everything else', () => {
    const out = sanitizeRoster({ sessions: [{
      title: 'Refactor',
      bypass: true,
      minimized: false,
      size: 2,
      id: 'agent-7',
      dormant: true,
      __proto__: { polluted: true },
      evil: 'rm -rf',
    }] });
    expect(out?.[0]).toEqual({ title: 'Refactor', bypass: true, minimized: false, size: 2 });
    expect(Object.keys(out![0]).sort()).toEqual(['bypass', 'minimized', 'size', 'title']);
  });

  it('coerces a non-object roster entry into a full default meta', () => {
    const out = sanitizeRoster({ sessions: [null, 'string', 42, []] });
    expect(out).toHaveLength(4);
    for (const meta of out!) {
      expect(meta).toEqual({ title: 'Agent', bypass: false, minimized: false, size: 1 });
    }
  });
});

describe('sanitizeRoster — sessionId (Claude --resume id) coercion', () => {
  const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('keeps a canonical UUID sessionId', () => {
    expect(sanitizeRoster({ sessions: [valid({ sessionId: UUID })] })?.[0].sessionId).toBe(UUID);
  });

  it('drops a non-UUID sessionId so a malformed id never reaches `claude --resume <id>`', () => {
    const bad: unknown[] = ['', 'not-a-uuid', '../../etc/passwd', '3f2504e0', `${UUID}; rm -rf /`, `${UUID}x`, 123, null, { uuid: UUID }];
    for (const sessionId of bad) {
      const out = sanitizeRoster({ sessions: [{ title: 'A', bypass: false, minimized: false, size: 1, sessionId }] });
      expect(out?.[0].sessionId).toBeUndefined();
      expect('sessionId' in out![0]).toBe(false);
    }
  });

  it('omits sessionId entirely when absent (legacy rosters)', () => {
    expect('sessionId' in sanitizeRoster({ sessions: [valid()] })![0]).toBe(false);
  });
});

/**
 * C11: the client has PUT `kind` for a while and the server silently dropped it, so a
 * restored automation tab always came back as a plain agent — which made D7's "open every
 * run since the last open" impossible to distinguish from an ordinary chat. `kind` now
 * round-trips, but through the SAME sanitizer discipline as every other field: a value
 * this build does not recognize is dropped, never passed through.
 */
describe('sanitizeRoster — kind (which surface this tab is)', () => {
  const entry = (over: Record<string, unknown>) =>
    sanitizeRoster({ sessions: [{ title: 'A', bypass: false, minimized: false, size: 1, ...over }] })![0];

  it('round-trips every known kind', () => {
    for (const kind of ['agent', 'shell', 'chat', 'automation'] as const) {
      expect(entry({ kind }).kind).toBe(kind);
    }
  });

  it('drops an unrecognized kind rather than passing it through', () => {
    // A typo, a hand-edited roster, or a kind a FUTURE build understands and this one does
    // not. Dropping degrades to "agent" on the client, which is the surface with the least
    // authority of the four — the safe direction for an unknown value.
    for (const kind of ['automations', 'AGENT', 'terminal', '', 42, null, {}, ['agent']]) {
      const out = entry({ kind });
      expect(out.kind).toBeUndefined();
      expect('kind' in out).toBe(false);
    }
  });

  it('omits kind entirely on a legacy roster that never had one', () => {
    expect('kind' in entry({})).toBe(false);
  });
});

describe('sanitizeRoster — automation companion object', () => {
  const FIRED_AT = '2026-08-10T09:00:00.000Z';
  const entry = (over: Record<string, unknown>) =>
    sanitizeRoster({ sessions: [{ title: 'A', bypass: false, minimized: false, size: 1, ...over }] })![0];

  it('keeps a well-formed automation alongside kind: automation', () => {
    const out = entry({ kind: 'automation', automation: { slug: 'eod-digest', runFiredAt: FIRED_AT } });
    expect(out.automation).toEqual({ slug: 'eod-digest', runFiredAt: FIRED_AT });
  });

  it('REJECTS an unsafe slug — this is the one place it arrives from an untrusted roster', () => {
    // The slug is a path segment everywhere else in the automations subsystem
    // (`~/.dreamcontext/automations/<slug>.sessions.json`, `automations/hitl/<slug>/`), and
    // every other producer validated it before it got there. A roster is hand-editable and
    // travels in the brain, so it is the one untrusted source — refuse at the boundary
    // rather than reason about who consumes it later.
    for (const slug of ['../../etc/passwd', 'a/b', '.', '..', '', 'has space', 'CAPS/../x', 123, null]) {
      const out = entry({ kind: 'automation', automation: { slug, runFiredAt: FIRED_AT } });
      expect(out.automation).toBeUndefined();
    }
  });

  it('drops an automation whose runFiredAt does not parse as a date', () => {
    // An unparseable timestamp means the entry was not written by the code that produces
    // this field, so nothing about it is trustworthy — the same reading `session-registry`
    // gives an unparseable binding `at`.
    for (const runFiredAt of ['', 'not-a-date', 'yesterday', 42, null, {}]) {
      expect(entry({ kind: 'automation', automation: { slug: 'eod-digest', runFiredAt } }).automation).toBeUndefined();
    }
  });

  it('drops automation when the kind is NOT automation, even if well-formed', () => {
    for (const kind of ['agent', 'shell', 'chat', undefined]) {
      const out = entry({ ...(kind ? { kind } : {}), automation: { slug: 'eod-digest', runFiredAt: FIRED_AT } });
      expect(out.automation).toBeUndefined();
      expect('automation' in out).toBe(false);
    }
  });
});

/**
 * X2: a restored automation tab must not attempt a resume this machine cannot serve. The
 * WS resume gate (`agent-chat.ts`) rejects at the HTTP upgrade level, which closes BEFORE
 * any application frame — so the client sees a bare `onclose` with no error and cannot
 * tell a security refusal from a crash. The roster GET therefore answers "may I resume
 * this here" up front, computed fresh on every request rather than persisted.
 */
describe('handleAgentSessionsGet — the transient `bound` flag', () => {
  const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const dirs: string[] = [];

  function scratch(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  /** A contextRoot with a roster holding one automation entry pinned to {@link UUID}. */
  function contextRootWithRoster(): string {
    const contextRoot = scratch('dc-roster-ctx-');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    const roster = {
      sessions: [{
        title: 'EOD Digest · Aug 10',
        bypass: true,
        minimized: false,
        size: 1,
        sessionId: UUID,
        kind: 'automation',
        automation: { slug: 'eod-digest', runFiredAt: '2026-08-10T09:00:00.000Z' },
      }],
    };
    writeFileSync(join(contextRoot, 'state', '.agent-sessions.json'), `${JSON.stringify(roster, null, 2)}\n`, 'utf-8');
    return contextRoot;
  }

  function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
    let statusCode = 0;
    let responseBody: unknown = null;
    const res = {
      writeHead(code: number) { statusCode = code; },
      end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
      setHeader() {},
    } as unknown as ServerResponse;
    return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
  }

  const req = {} as IncomingMessage;
  const realDesktop = process.env.DREAMCONTEXT_DESKTOP;

  afterEach(() => {
    if (realDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
    else process.env.DREAMCONTEXT_DESKTOP = realDesktop;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function get(contextRoot: string, home: string) {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    const { res, status, body } = makeRes();
    await handleAgentSessionsGet(req, res, {}, contextRoot, home);
    return { status: status(), sessions: (body().sessions ?? []) as Array<Record<string, unknown>> };
  }

  it('is FALSE for a session id this machine never recorded — the brain-synced case', async () => {
    // Nothing was ever written to `<home>/.dreamcontext/automations/`, which is exactly the
    // state of a teammate's machine after a brain sync carried the roster across.
    const home = scratch('dc-roster-home-');
    const { status, sessions } = await get(contextRootWithRoster(), home);
    expect(status).toBe(200);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].bound).toBe(false);
  });

  it('is TRUE once this machine\'s runner has recorded that session', async () => {
    const home = scratch('dc-roster-home-');
    expect(recordAutomationSession('eod-digest', UUID, home)).toBe(true);
    const { sessions } = await get(contextRootWithRoster(), home);
    expect(sessions[0].bound).toBe(true);
  });

  it('binds on the session id alone, not on the roster\'s claimed slug', async () => {
    // The roster says `eod-digest`, the binding says `weekly-report`. The machine-local
    // registry is the authority: it recorded this id, so it IS resumable here. The roster's
    // own claim about which automation owns it is the untrusted half.
    const home = scratch('dc-roster-home-');
    recordAutomationSession('weekly-report', UUID, home);
    const { sessions } = await get(contextRootWithRoster(), home);
    expect(sessions[0].bound).toBe(true);
  });

  it('is FALSE for an entry with no sessionId at all — there is nothing to resume', async () => {
    const home = scratch('dc-roster-home-');
    const contextRoot = scratch('dc-roster-ctx-');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(
      join(contextRoot, 'state', '.agent-sessions.json'),
      `${JSON.stringify({ sessions: [{ title: 'A', bypass: false, minimized: false, size: 1 }] })}\n`,
      'utf-8',
    );
    const { sessions } = await get(contextRoot, home);
    expect(sessions[0].bound).toBe(false);
  });

  it('never returns the owning slug — the answer is "may I resume", not "what else exists"', async () => {
    // Leaking the slug would tell a caller about automations it never asked about, from a
    // file (`*.sessions.json`) that is deliberately machine-local.
    const home = scratch('dc-roster-home-');
    recordAutomationSession('a-secret-automation', UUID, home);
    const { sessions } = await get(contextRootWithRoster(), home);
    expect(JSON.stringify(sessions)).not.toContain('a-secret-automation');
  });

  it('403s outside the desktop app, before reading anything', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status, body } = makeRes();
    await handleAgentSessionsGet(req, res, {}, contextRootWithRoster(), scratch('dc-roster-home-'));
    expect(status()).toBe(403);
    expect(body().sessions).toBeUndefined();
  });
});
