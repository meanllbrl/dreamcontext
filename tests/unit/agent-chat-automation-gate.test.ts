/**
 * Unit tests for `shouldRejectAutomationResume` — the T24 security gate on
 * `src/server/routes/agent-chat.ts`'s WebSocket upgrade handler.
 *
 * THE THREAT (see the function's own doc comment for the full trust model): an
 * automation's session ids live in `automations/cache/<slug>.json` →
 * `history[].sessionId`, which IS BRAIN-SYNCED and therefore teammate-writable.
 * `bypass=1&resume=<uuid>` on this route becomes a live
 * `claude --resume <uuid> --permission-mode bypassPermissions` process with zero
 * automations-awareness, so a planted synced session id would otherwise hand a
 * fully-armed, unattended resume to anyone who can push to the shared brain.
 *
 * THE RULE (plan §11 R2, binding): if `<uuid>` appears in ANY automation's
 * `cache.history[].sessionId` for this project (brain-synced) AND
 * `isAutomationBoundSession(uuid)` (machine-local) returns null, REJECT. Otherwise
 * proceed as today. Restricted to `bypass=1` connects — the capability being
 * gated is `bypassPermissions` specifically (see the "bypass=0" tests below).
 *
 * A `true` return from `shouldRejectAutomationResume` is called BEFORE
 * `startChatSession` — the only place in agent-chat.ts that spawns the resumable
 * `claude` process this gate exists to guard — so "upgrade rejected" and "no
 * process spawned" are the same fact here, not two things to prove separately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldRejectAutomationResume } from '../../src/server/routes/agent-chat.js';
import {
  createAutomation, recordRun, automationCacheDir, automationCachePath,
} from '../../src/lib/automations/store.js';
import { recordAutomationSession } from '../../src/lib/automations/session-registry.js';
import type { RunEvent } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;
let home: string;

// A real UUID shape (matches `UUID_RE` in agent-session-map.ts, which is what
// `sanitizeUuid` validates against before this gate ever sees a `resumeId`).
const RESUME_ID = '13b74217-a64f-4902-a275-2a4c3dd2d67d';
const OTHER_ID = '6f345b66-c54e-4978-9011-b6d0f3225b6f';

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-agent-chat-gate-project-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-agent-chat-gate-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function fakeRunEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    firedAt: '2026-08-01T18:00:00.000Z',
    startedAt: '2026-08-01T18:00:01.000Z',
    finishedAt: '2026-08-01T18:00:05.000Z',
    status: 'ok',
    durationMs: 4000,
    outputPath: '/out.md',
    error: null,
    exitCode: 0,
    sessionId: null,
    costUsd: 0.01,
    numTurns: 3,
    permissionDenials: 0,
    ...overrides,
  };
}

/** Plants a session id into ONE automation's brain-synced cache — the
 *  teammate-writable side of the gate. Mirrors what a synced `cache/<slug>.json`
 *  legitimately looks like after a real run, but here it stands in for either a
 *  genuine run OR an attacker's edit — the gate cannot and must not care which. */
function plantSyncedSession(slug: string, sessionId: string): void {
  createAutomation(contextRoot, { slug, title: slug, days: 'daily', at: '18:00' });
  recordRun(contextRoot, slug, fakeRunEvent({ sessionId }));
}

describe('shouldRejectAutomationResume — bypass=1, the capability path', () => {
  it('rejects: uuid present in a synced cache.history[].sessionId but never recorded locally', () => {
    plantSyncedSession('daily-report', RESUME_ID);
    // Machine-local side (~/.dreamcontext/automations/*.sessions.json under `home`) has
    // nothing for this uuid — nobody ran `recordAutomationSession` for it on this machine.
    expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(true);
  });

  it('proceeds: the SAME uuid, after this machine\'s runner actually bound it locally', () => {
    plantSyncedSession('daily-report', RESUME_ID);
    recordAutomationSession('daily-report', RESUME_ID, home);
    expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(false);
  });

  it(
    'DELIBERATE: proceeds when the uuid is bound under automation A but planted into ' +
      "automation B's synced cache — isAutomationBoundSession is intentionally slug-agnostic",
    () => {
      // Attacker (or a stale/corrupt sync) plants automation A's real, machine-recorded
      // session id into automation B's cache.
      plantSyncedSession('automation-b', RESUME_ID);
      recordAutomationSession('automation-a', RESUME_ID, home);
      // `isAutomationBoundSession` scans EVERY `.sessions.json` file and returns whichever
      // slug owns the uuid, regardless of which cache triggered the check (see its own doc:
      // "a session somehow claimed by two slugs resolves the same way every time"). The
      // machine-local binding is the authority on whether this id is a REAL, already-granted
      // capability — slug identity only matters to the unrelated per-conversation lookup
      // `readAutomationSession(slug, sessionId)` uses elsewhere (e.g. "reply to THIS
      // automation's thread"). Since automation A's runner genuinely produced this session on
      // THIS machine, resuming it hands out nothing an attacker's B-cache edit could not
      // already see was resumable — so the gate must not reject it.
      expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(false);
    },
  );

  it('unchanged from today: an ordinary uuid that appears in no automation cache at all (bypass=1)', () => {
    plantSyncedSession('daily-report', OTHER_ID); // some OTHER uuid is bound, not this one
    expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(false);
  });

  it('unchanged from today: an ordinary uuid with NO automations at all on the project (bypass=1)', () => {
    expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(false);
  });

  it(
    'rejects: uuid present in a cache file with NO corresponding manifest — an orphan cache ' +
      'is scanned exactly like any other',
    () => {
      // Both halves of an automation (its manifest at `automations/<slug>.md` and its cache
      // at `automations/cache/<slug>.json`) are independent, teammate-writable files. An
      // attacker who can plant `automations/cache/evil.json` can simply decline to plant
      // `automations/evil.md` — so the brain-synced side of this gate MUST enumerate cache
      // files directly (see the gate's own doc comment) rather than deriving slugs from
      // `listAutomations`, which only sees manifests and would silently skip this file.
      // `recordRun` writes straight to the cache path with no manifest requirement, which is
      // exactly what reproduces that gap here.
      recordRun(contextRoot, 'evil', fakeRunEvent({ sessionId: RESUME_ID }));
      expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(true);
    },
  );
});

describe('shouldRejectAutomationResume — bypass=0, out of scope by design', () => {
  it('unchanged from today: an ordinary uuid in no automation cache (bypass=0)', () => {
    expect(shouldRejectAutomationResume(false, RESUME_ID, contextRoot, home)).toBe(false);
  });

  it(
    'DECISION: never rejects a bypass=0 resume, even for a uuid that IS claimed-but-unbound — ' +
      'the capability this gate protects is bypassPermissions specifically, and a bypass=0 ' +
      'resume only ever reaches `auto` mode (still prompts for anything not auto-approved), ' +
      'so it is not the capability a planted synced session id would buy an attacker',
    () => {
      plantSyncedSession('daily-report', RESUME_ID); // claimed by the cache…
      // …and never bound locally — under bypass=1 this exact setup rejects (see above).
      expect(shouldRejectAutomationResume(false, RESUME_ID, contextRoot, home)).toBe(false);
    },
  );
});

describe('shouldRejectAutomationResume — no-op edges', () => {
  it('no resumeId at all → never rejects (nothing to gate — mirrors a fresh/pinned session)', () => {
    expect(shouldRejectAutomationResume(true, '', contextRoot, home)).toBe(false);
  });
});

describe('shouldRejectAutomationResume — malformed/unreadable caches degrade safely, never throw', () => {
  it('degrades to "not claimed" (proceeds) when a cache file is not even valid JSON — never throws', () => {
    createAutomation(contextRoot, { slug: 'broken-json', title: 'broken-json', days: 'daily', at: '18:00' });
    mkdirSync(automationCacheDir(contextRoot), { recursive: true });
    writeFileSync(automationCachePath(contextRoot, 'broken-json'), '{ this is not valid json', 'utf-8');

    expect(() => shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).not.toThrow();
    // Read failure ⇒ cannot PROVE "claimed by an automation" ⇒ degrades to "not claimed",
    // i.e. today's unchanged behaviour — the AVAILABLE side, not the paranoid one. See the
    // gate's own doc comment for why: one corrupt cache file must not black out every chat
    // resume on the machine, for a threat this particular uuid may not even be part of.
    expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(false);
  });

  it('degrades to "not claimed" (proceeds) when a cache parses but `history` is not an array — never throws', () => {
    // Valid JSON, wrong shape: `readAutomationCache` itself only checks the TOP-LEVEL value
    // (object, not array, not null) — it does not validate `.history`. This exercises the
    // gate's OWN `Array.isArray` guard, not `readAutomationCache`'s.
    createAutomation(contextRoot, { slug: 'wrong-shape', title: 'wrong-shape', days: 'daily', at: '18:00' });
    mkdirSync(automationCacheDir(contextRoot), { recursive: true });
    writeFileSync(
      automationCachePath(contextRoot, 'wrong-shape'),
      JSON.stringify({ slug: 'wrong-shape', history: { not: 'an array' } }),
      'utf-8',
    );

    expect(() => shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).not.toThrow();
    expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(false);
  });

  it(
    'one automation\'s malformed cache does not blind the scan of another automation\'s valid cache',
    () => {
      // "broken" is scanned but its cache read explodes; "daily-report" genuinely claims the
      // uuid. Iteration order must not matter — both must still be checked.
      createAutomation(contextRoot, { slug: 'broken', title: 'broken', days: 'daily', at: '18:00' });
      mkdirSync(automationCacheDir(contextRoot), { recursive: true });
      writeFileSync(automationCachePath(contextRoot, 'broken'), '{ not json', 'utf-8');
      plantSyncedSession('daily-report', RESUME_ID);

      // Unbound locally ⇒ still rejects, proving the "broken" automation's bad cache did not
      // swallow the real hit from "daily-report".
      expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(true);
    },
  );

  it('degrades to "not claimed" (proceeds) when automations/cache/ itself is unreadable — never throws', () => {
    // `automations/` exists as a plain FILE instead of a directory, so
    // `readdirSync(automationCacheDir(contextRoot))` — i.e. `readdirSync('.../automations/cache')`
    // — throws ENOTDIR on the nested path. This is exactly the "unreadable cache directory"
    // case the gate's outer try/catch exists for.
    rmSync(contextRoot, { recursive: true, force: true });
    mkdirSync(contextRoot, { recursive: true });
    writeFileSync(join(contextRoot, 'automations'), 'not a directory', 'utf-8');

    expect(() => shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).not.toThrow();
    expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(false);
  });

  it(
    'the isSafeAutomationSlug filename guard is load-bearing: a dotfile whose content LOOKS ' +
      "like a claiming cache is still ignored, because its filename-derived \"slug\" is unsafe",
    () => {
      // `automations/cache/` also holds `.<slug>.run.json` (the in-flight run sidecar) — a
      // dotfile that ends in `.json`, same as a real cache file. Stripping just the `.json`
      // suffix from its name yields `.evil.run`, which — if the scan trusted directory
      // contents the way it trusts `listAutomations`'s already-validated manifests — would be
      // used as a slug to build a cache path via `readAutomationCache`. Here that mis-derived
      // path happens to resolve back to THIS SAME FILE (`.evil.run` + `.json` = `.evil.run.json`),
      // whose content is deliberately shaped to look like a cache claiming `RESUME_ID`.
      //
      // If `isSafeAutomationSlug` were not applied to the filename before use, this uuid would
      // read as "claimed by an automation", and — being unbound locally — the gate would
      // (wrongly) reject it. Because the guard rejects any slug starting with `.`, this file is
      // skipped entirely and the resume proceeds, exactly as if the dotfile did not exist.
      mkdirSync(automationCacheDir(contextRoot), { recursive: true });
      writeFileSync(
        join(automationCacheDir(contextRoot), '.evil.run.json'),
        JSON.stringify({ slug: 'evil', history: [{ sessionId: RESUME_ID }] }),
        'utf-8',
      );

      expect(shouldRejectAutomationResume(true, RESUME_ID, contextRoot, home)).toBe(false);
    },
  );
});
