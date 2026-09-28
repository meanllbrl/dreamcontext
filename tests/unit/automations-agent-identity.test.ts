/**
 * Agents step 1 — an automation's IDENTITY: its photo and its mode.
 *
 * Four properties this file exists to hold, each of which fails silently if it
 * ever breaks:
 *
 *  1. Adding `photo` and `mode` to the manifest changed NOBODY's approval
 *     hash. Both are deliberately absent from `canonicalApprovalPayload`, so
 *     every manifest written before they existed must hash byte-identically —
 *     the alternative is every automation on the machine blocking at once on
 *     upgrade, and a blocked run notifies nobody by design.
 *  2. A `mode: 'call'` agent is NEVER fired by the dispatcher, through
 *     `isDue` and through a real `tickProject` pass.
 *  3. A photo path that escapes the photos directory is refused at write and
 *     resolves to nothing on read, so the HTTP photo route can never be
 *     pointed at the rest of the brain.
 *  4. The dialog's prefill fires exactly once per field and the first click on
 *     Delete never deletes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  automationPath,
  automationPhotosDir,
  cadenceLabel,
  createAutomation,
  getAutomation,
  isContainedPhotoRel,
  parseAutomationMode,
  photoRelPathFor,
  readAutomationFile,
  removeAutomation,
  resolveAutomationPhoto,
  updateAutomation,
  validateAutomationForWrite,
} from '../../src/lib/automations/store.js';
import { manifestHash, canonicalApprovalPayload } from '../../src/lib/automations/registry.js';
import { isDue } from '../../src/lib/automations/schedule.js';
import { tickProject } from '../../src/lib/automations/tick.js';
import { enqueueFire, queuedFire } from '../../src/lib/automations/queue.js';
import { AutomationError, AUTOMATION_PHOTOS_DIR } from '../../src/lib/automations/types.js';
import {
  DELETE_ARM_MS,
  deleteAction,
  nameFromDescription,
  packDays,
  shouldPrefill,
  timeFromDescription,
} from '../../dashboard/src/lib/agentDraft.js';

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-agent-identity-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function scheduled(slug = 'digest') {
  return createAutomation(contextRoot, {
    slug,
    title: 'Daily digest',
    days: 'daily',
    at: '09:00',
    prompt: 'Summarise yesterday.',
  });
}

function onCall(slug = 'researcher') {
  return createAutomation(contextRoot, {
    slug,
    title: 'Researcher',
    mode: 'call',
    days: 'daily',
    at: '09:00',
    prompt: 'Research whatever I hand you.',
  });
}

/** A 1x1 PNG — real magic bytes, so anything that sniffs it agrees it is one. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('manifest: mode and photo round-trip', () => {
  it('defaults to sched with no photo, and writes both keys explicitly', () => {
    const m = scheduled();
    expect(m.mode).toBe('sched');
    expect(m.photo).toBeNull();
    const raw = readFileSync(m.path, 'utf-8');
    expect(raw).toMatch(/^mode: sched$/m);
    expect(raw).toMatch(/^photo: null$/m);
  });

  it('a mode:call agent is written with NO schedule at all', () => {
    const m = onCall();
    expect(m.mode).toBe('call');
    expect(m.schedule).toBeNull();
    expect(cadenceLabel(m)).toBe('When you call it');
  });

  it('reads an unrecognized or missing mode as sched, never as call', () => {
    // The compatibility direction: every manifest on disk predates this field,
    // and reading a missing value as 'call' would silently stop all of them.
    expect(parseAutomationMode(undefined)).toBe('sched');
    expect(parseAutomationMode(null)).toBe('sched');
    expect(parseAutomationMode('cal')).toBe('sched');
    expect(parseAutomationMode(true)).toBe('sched');
    expect(parseAutomationMode('call')).toBe('call');
  });

  it('an updated photo survives a read back', () => {
    const m = scheduled();
    mkdirSync(automationPhotosDir(contextRoot), { recursive: true });
    writeFileSync(join(automationPhotosDir(contextRoot), 'digest.png'), PNG_1X1);
    const updated = updateAutomation(contextRoot, m.slug, { photo: `${AUTOMATION_PHOTOS_DIR}/digest.png` });
    expect(updated.photo).toBe(`${AUTOMATION_PHOTOS_DIR}/digest.png`);
    expect(readAutomationFile(m.path).photo).toBe(`${AUTOMATION_PHOTOS_DIR}/digest.png`);
    // The REAL path: the resolver realpaths both sides (macOS puts tmpdir
    // under `/var`, itself a symlink to `/private/var`), so it hands back the
    // canonical path the photo route will actually read.
    expect(resolveAutomationPhoto(contextRoot, updated.photo)).toBe(
      realpathSync(join(automationPhotosDir(contextRoot), 'digest.png')),
    );
  });
});

describe('approval hash is untouched by mode and photo', () => {
  it('the hashed payload never names photo, and names mode only for an on-call agent', () => {
    const schedPayload = canonicalApprovalPayload(scheduled());
    const callPayload = canonicalApprovalPayload(onCall());
    expect(schedPayload).not.toContain('"mode"');
    expect(schedPayload).not.toContain('"photo"');
    expect(callPayload).toContain('"mode":"call"');
    expect(callPayload).not.toContain('"photo"');
  });

  it('bolting a SCHEDULE onto an approved on-call agent DOES change the hash', () => {
    // The tripwire case that matters, and the reason `mode` is hashed at all.
    // An owner approves an agent as "runs only when I ask". A teammate's
    // synced edit (or a hand edit) flips it to scheduled. If the hash did not
    // move, `checkApproval` would keep saying yes and the next dispatcher tick
    // would start running that prompt headless on a timer, with nobody ever
    // shown a diff.
    const called = onCall('advisor');
    const approvedHash = manifestHash(called);
    const scheduledNow = updateAutomation(contextRoot, 'advisor', {
      mode: 'sched', days: 'daily', at: '09:00',
    });
    expect(manifestHash(scheduledNow)).not.toBe(approvedHash);
  });

  it('setting a photo does not change the hash', () => {
    // If this ever fails, every automation on every machine blocks on upgrade
    // — and a blocked run tells nobody. See AutomationMode's doc comment.
    const m = scheduled();
    const before = manifestHash(m);

    mkdirSync(automationPhotosDir(contextRoot), { recursive: true });
    writeFileSync(join(automationPhotosDir(contextRoot), 'digest.png'), PNG_1X1);
    const withPhoto = updateAutomation(contextRoot, m.slug, { photo: `${AUTOMATION_PHOTOS_DIR}/digest.png` });
    expect(manifestHash(withPhoto)).toBe(before);

  });

  it('a manifest with NO mode key hashes exactly as it did before the field existed', () => {
    // The upgrade guarantee. Every automation on every machine predates
    // `mode`, reads 'sched', and must keep the hash it was approved with —
    // otherwise an upgrade blocks all of them at once, and a blocked run
    // notifies nobody by design.
    const m = scheduled('legacy');
    const withModeKey = manifestHash(m);
    // Strip the key the way a pre-feature manifest on disk actually looks.
    writeFileSync(m.path, readFileSync(m.path, 'utf-8').replace(/^mode: sched\n/m, ''), 'utf-8');
    const legacy = readAutomationFile(m.path);
    expect(legacy.mode).toBe('sched');
    expect(manifestHash(legacy)).toBe(withModeKey);
    expect(canonicalApprovalPayload(legacy)).not.toContain('"mode"');
  });

  it('but an edited PROMPT does change it — the tripwire still works', () => {
    const m = scheduled();
    const before = manifestHash(m);
    const edited = updateAutomation(contextRoot, m.slug, { prompt: 'Summarise the whole week instead.' });
    expect(manifestHash(edited)).not.toBe(before);
    expect(edited.prompt).toBe('Summarise the whole week instead.');
  });
});

describe('the dispatcher never fires a mode:call agent', () => {
  const now = new Date('2026-09-19T12:00:00');

  it('isDue refuses on-call before it even looks at the schedule', () => {
    // A VALID schedule is passed deliberately: the refusal must come from the
    // mode, not from the absent schedule, or the guard is untested.
    const verdict = isDue({ days: 'daily', at: '09:00' }, null, now, 6, 'call');
    expect(verdict.due).toBe(false);
    expect(verdict.reason).toBe('on-call');
    expect(verdict.fireAt).toBeNull();
  });

  it('the same schedule IS due for a sched agent', () => {
    expect(isDue({ days: 'daily', at: '09:00' }, null, now, 6, 'sched').due).toBe(true);
    // Default parameter: every pre-existing caller keeps its exact behaviour.
    expect(isDue({ days: 'daily', at: '09:00' }, null, now, 6).due).toBe(true);
  });

  it('a fire QUEUED while it was scheduled is dropped once it becomes on-call', async () => {
    // The hole this closes: the drain phase runs BEFORE the isDue loop and
    // re-resolves the manifest, so it is the one path that can fire an agent
    // without ever consulting `isDue`. An agent scheduled yesterday can have a
    // fire queued (a held sleep lock, a deferral) and be edited to on-call
    // before the next drain — and that stale fire must not run.
    const home = join(projectRoot, 'fakehome');
    mkdirSync(home, { recursive: true });
    const m = createAutomation(contextRoot, {
      slug: 'digest', title: 'Daily digest', days: 'daily', at: '09:00', prompt: 'Summarise yesterday.',
    });
    // Queued while still scheduled, inside the catch-up window.
    enqueueFire(projectRoot, m.slug, '2026-09-19T09:00:00.000Z', home, now.getTime());
    // …then the owner switches it to on-call.
    updateAutomation(contextRoot, m.slug, { mode: 'call' });

    const ran: string[] = [];
    await tickProject(projectRoot, {
      now,
      home,
      runImpl: async (_root, slug) => {
        ran.push(slug);
        return { slug, status: 'ok' } as never;
      },
      pollTelegram: async () => ({ processed: 0, unauthorized: 0 }) as never,
    });

    expect(ran).toEqual([]);
    // DROPPED, not re-queued: an on-call agent has no schedule, so the fire is
    // owed to nobody and re-queuing it would keep it alive forever.
    expect(queuedFire(projectRoot, m.slug, home)).toBeNull();
  });

  it('a real tick pass runs the scheduled agent and skips the on-call one', async () => {
    scheduled('digest');
    onCall('researcher');

    const ran: string[] = [];
    const result = await tickProject(projectRoot, {
      now,
      // Stubbed runner: this test is about WHICH slugs reach it, not about
      // spawning claude.
      runImpl: async (_root, slug) => {
        ran.push(slug);
        return {
          slug, status: 'ok', firedAt: now.toISOString(), startedAt: now.toISOString(),
          finishedAt: now.toISOString(), durationMs: 1, outputPath: null, error: null,
          exitCode: 0, sessionId: null, costUsd: null, numTurns: null, permissionDenials: 0,
        } as never;
      },
      pollTelegram: async () => ({ processed: 0, unauthorized: 0 }) as never,
    });

    expect(ran).toEqual(['digest']);
    expect(result.verdicts.find((v) => v.slug === 'researcher')?.verdict).toBe('on-call');
  });
});

describe('photo containment', () => {
  it('accepts exactly one file directly inside the photos directory', () => {
    expect(isContainedPhotoRel(`${AUTOMATION_PHOTOS_DIR}/a.png`)).toBe(true);
    expect(isContainedPhotoRel(`${AUTOMATION_PHOTOS_DIR}/a-b_1.webp`)).toBe(true);
  });

  it('refuses absolute paths, climbs, other directories and nesting', () => {
    for (const bad of [
      '/etc/passwd',
      '/Users/someone/.ssh/id_rsa',
      `${AUTOMATION_PHOTOS_DIR}/../../core/soul.md`,
      `${AUTOMATION_PHOTOS_DIR}/../cache/digest.json`,
      '../automations/photos/a.png',
      'automations/digest.md',
      'core/soul.md',
      `${AUTOMATION_PHOTOS_DIR}/nested/a.png`,
      `${AUTOMATION_PHOTOS_DIR}/`,
      '',
      '   ',
    ]) {
      expect(isContainedPhotoRel(bad), `should refuse: ${bad}`).toBe(false);
    }
  });

  it('a photo outside the brain is refused AT WRITE', () => {
    expect(() => validateAutomationForWrite({
      slug: 'x', title: 'X', days: 'daily', at: '09:00', photo: '/etc/passwd',
    })).toThrow(AutomationError);
    expect(() => createAutomation(contextRoot, {
      slug: 'x', title: 'X', days: 'daily', at: '09:00', photo: '../../../etc/passwd',
    })).toThrow(AutomationError);
    expect(existsSync(automationPath(contextRoot, 'x'))).toBe(false);
  });

  it('a SYMLINK inside the photos directory pointing outside it is refused', () => {
    // Defence in depth: `resolve` does not follow links, so the lexical check
    // alone would pass this and the photo route would then read and SERVE the
    // target over HTTP. Nothing stages such a link today; this is the guard
    // against a future writer that does.
    const secret = join(projectRoot, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY');
    mkdirSync(automationPhotosDir(contextRoot), { recursive: true });
    symlinkSync(secret, join(automationPhotosDir(contextRoot), 'sneaky.png'));
    expect(resolveAutomationPhoto(contextRoot, `${AUTOMATION_PHOTOS_DIR}/sneaky.png`)).toBeNull();
  });

  it('a DIRECTORY named like a photo is refused rather than read', () => {
    mkdirSync(join(automationPhotosDir(contextRoot), 'notafile.png'), { recursive: true });
    expect(resolveAutomationPhoto(contextRoot, `${AUTOMATION_PHOTOS_DIR}/notafile.png`)).toBeNull();
  });

  it('resolveAutomationPhoto is TOTAL: a missing or escaping path is null, never a throw', () => {
    expect(resolveAutomationPhoto(contextRoot, null)).toBeNull();
    expect(resolveAutomationPhoto(contextRoot, '')).toBeNull();
    // Escapes — even though the target exists.
    const outside = join(projectRoot, 'secret.png');
    writeFileSync(outside, PNG_1X1);
    expect(resolveAutomationPhoto(contextRoot, '../secret.png')).toBeNull();
    expect(resolveAutomationPhoto(contextRoot, outside)).toBeNull();
    // Contained, but not on disk.
    expect(resolveAutomationPhoto(contextRoot, `${AUTOMATION_PHOTOS_DIR}/never-uploaded.png`)).toBeNull();
  });

  it('photoRelPathFor refuses an unsafe slug or extension rather than joining them', () => {
    expect(photoRelPathFor('digest', '.png')).toBe(`${AUTOMATION_PHOTOS_DIR}/digest.png`);
    expect(() => photoRelPathFor('../escape', '.png')).toThrow(AutomationError);
    expect(() => photoRelPathFor('digest', '/../x')).toThrow(AutomationError);
  });

  it('photos are git-ignored, so a private agent\'s picture never publishes', () => {
    scheduled();
    const ignore = readFileSync(join(contextRoot, '.gitignore'), 'utf-8');
    expect(ignore).toContain(`${AUTOMATION_PHOTOS_DIR}/`);
  });
});

describe('delete takes the photo with it', () => {
  it('removes the manifest and the photo file', () => {
    const m = scheduled();
    mkdirSync(automationPhotosDir(contextRoot), { recursive: true });
    const photoAbs = join(automationPhotosDir(contextRoot), 'digest.png');
    writeFileSync(photoAbs, PNG_1X1);
    updateAutomation(contextRoot, m.slug, { photo: `${AUTOMATION_PHOTOS_DIR}/digest.png` });

    removeAutomation(contextRoot, m.slug);
    expect(getAutomation(contextRoot, m.slug)).toBeNull();
    expect(existsSync(photoAbs)).toBe(false);
  });

  it('a manifest whose photo string escapes deletes NOTHING outside the photos dir', () => {
    const m = scheduled();
    const outside = join(projectRoot, 'keep-me.png');
    writeFileSync(outside, PNG_1X1);
    // Hand-tampered frontmatter — the write path would have refused this.
    writeFileSync(m.path, readFileSync(m.path, 'utf-8').replace('photo: null', `photo: ../keep-me.png`), 'utf-8');

    removeAutomation(contextRoot, m.slug);
    expect(existsSync(outside)).toBe(true);
  });
});

describe('editing an agent', () => {
  it('a patch leaves untouched fields exactly as they were', () => {
    const m = createAutomation(contextRoot, {
      slug: 'digest', title: 'Daily digest', days: ['mon', 'wed'], at: '09:00',
      model: 'opus', effort: 'high', prompt: 'Summarise yesterday.', catchupHours: 4,
    });
    const edited = updateAutomation(contextRoot, 'digest', { title: 'Morning digest' });
    expect(edited.title).toBe('Morning digest');
    expect(edited.model).toBe('opus');
    expect(edited.effort).toBe('high');
    expect(edited.catchupHours).toBe(4);
    expect(edited.prompt).toBe('Summarise yesterday.');
    expect(edited.schedule).toEqual({ days: ['mon', 'wed'], at: '09:00' });
  });

  it('switching to on-call drops the schedule; switching back needs a real one', () => {
    scheduled();
    const called = updateAutomation(contextRoot, 'digest', { mode: 'call' });
    expect(called.schedule).toBeNull();

    // Back to scheduled, supplying a schedule — fine.
    const back = updateAutomation(contextRoot, 'digest', { mode: 'sched', days: ['fri'], at: '17:00' });
    expect(back.schedule).toEqual({ days: ['fri'], at: '17:00' });
  });

  it('refuses an empty prompt rather than writing an agent that does nothing', () => {
    scheduled();
    expect(() => updateAutomation(contextRoot, 'digest', { prompt: '   ' })).toThrow(AutomationError);
  });

  it('refuses an unknown slug', () => {
    expect(() => updateAutomation(contextRoot, 'nope', { title: 'X' })).toThrow(AutomationError);
  });
});

describe('the dialog: prefill fires once, delete needs two clicks', () => {
  it('prefills Name and the time from the description while both are untouched', () => {
    const text = "Her sabah 09:00'da dünkü insight'ları oku; düşüş varsa araştır.";
    expect(timeFromDescription(text)).toBe('09:00');
    expect(nameFromDescription(text)).toBe("Her sabah 09:00'da dünkü insight'ları oku");
  });

  it('accepts the 09.00 form and refuses an impossible time', () => {
    expect(timeFromDescription('her gün 18.30 raporu')).toBe('18:30');
    expect(timeFromDescription('v2 25:99 sürümü')).toBeNull();
    expect(timeFromDescription('no time here at all')).toBeNull();
  });

  it('STOPS prefilling a field the owner has touched, and never prefills on an edit', () => {
    // The whole point: a form that keeps re-deriving eats your edit the moment
    // you go back to fix a typo upstream.
    expect(shouldPrefill({ touched: false, editing: false })).toBe(true);
    expect(shouldPrefill({ touched: true, editing: false })).toBe(false);
    expect(shouldPrefill({ touched: false, editing: true })).toBe(false);
    expect(shouldPrefill({ touched: true, editing: true })).toBe(false);
  });

  it('the FIRST click on Delete only arms it', () => {
    expect(deleteAction(false)).toBe('arm');
    expect(deleteAction(true)).toBe('commit');
    expect(DELETE_ARM_MS).toBe(5000);
  });

  it('all seven days pack to "daily"', () => {
    expect(packDays(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).toBe('daily');
    expect(packDays(['mon', 'fri'])).toEqual(['mon', 'fri']);
  });
});
