/**
 * super-rutin W2: the Super automation. The runner's queue item, the told-ledger, the server's
 * sweep (trust, catch-up, Super off, the two doors) and the `super schedule` verb.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutomation, getAutomation, readAutomationCache, recordRun } from '../../src/lib/automations/store.js';
import { approveAutomation, checkApproval } from '../../src/lib/automations/registry.js';
import { runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { getAgent } from '../../src/lib/agents/store.js';
import {
  listScheduleItems, markScheduleDelivered, markTold, noteMissedSuperFire, scheduleDir, toldKey, wasTold, writeScheduleItem,
} from '../../src/lib/super/schedule-queue.js';
import { scheduleTurnText } from '../../src/lib/super/schedule-job.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { SCHEDULE_LINES, scheduleVerb, sweepProject, type ScheduleDeps } from '../../src/server/super-schedule.js';
import { superVerbRefusal } from '../../src/server/routes/super.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let scope: string;
const FIRE = new Date('2026-11-10T06:00:00.000Z');

function superAuto(slug = 'sabah', over: Record<string, unknown> = {}): AutomationManifest {
  const m = createAutomation(contextRoot, { slug, title: slug, days: 'daily', at: '09:00', prompt: 'Haberleri özetle ve bana yaz.', target: 'super', ...over });
  approveAutomation(projectRoot, m, FIRE, home, 'super-verb');
  return m;
}

/** The tick ran this fire: its watermark is the recorded fire. */
function fired(slug: string, at = FIRE): void {
  const iso = at.toISOString();
  recordRun(contextRoot, slug, {
    firedAt: iso, startedAt: iso, finishedAt: iso, status: 'ok', durationMs: 0, outputPath: null, error: null,
    exitCode: null, sessionId: null, costUsd: null, numTurns: null, permissionDenials: 0,
  }, { advanceWatermark: true });
}

interface Sink { said: string[]; enqueued: string[]; injected: Array<{ text: string; kind: string }> }

function deps(sink: Sink, over: Partial<ScheduleDeps> & { away?: boolean; bound?: boolean; on?: boolean; now?: () => number } = {}): ScheduleDeps {
  const ab = { disabled: false } as never;
  return {
    home,
    now: over.now ?? (() => FIRE.getTime() + 60_000),
    banner: (_t, b) => { sink.said.push(b); },
    superState: async () => ({ enabled: over.on ?? true, session: 'sess-super' }),
    enqueue: async (_root, slug, fireIso) => { sink.enqueued.push(`${slug}@${fireIso}`); },
    hub: () => (over.bound ? {
      superBindingOfVault: () => ab,
      ownerAway: () => over.away ?? false,
      syntheticUpdateId: () => -1,
      injectText: async (_ab: unknown, _u: number, text: string, _sid: string, as: { kind: string } | null) => { sink.injected.push({ text, kind: as?.kind ?? 'text' }); return 'ref001'; },
      notice: async (_ab: unknown, _k: unknown, line: string) => { sink.said.push(line); },
    } as never : null),
    ...over,
  };
}

const sink = (): Sink => ({ said: [], enqueued: [], injected: [] });

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-super-schedule-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-super-schedule-home-'));
  scope = scopeOfContextRoot(contextRoot);
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('the queue and the told-ledger', () => {
  it('writes one item per fire, refuses a forged file and a symlink, and tells a key once', () => {
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    expect(listScheduleItems(scope, home)).toEqual([{ v: 1, slug: 'sabah', fireIso: FIRE.toISOString() }]);
    // A file whose inside names another slug is no item: removed, never trusted.
    writeFileSync(join(scheduleDir(scope, home), `other@${FIRE.getTime()}.json`), JSON.stringify({ v: 1, slug: 'sabah', fireIso: FIRE.toISOString() }));
    symlinkSync('/etc/hosts', join(scheduleDir(scope, home), `link@${FIRE.getTime()}.json`));
    expect(listScheduleItems(scope, home).map((i) => i.slug)).toEqual(['sabah']);
    const key = toldKey('sabah', FIRE.toISOString(), 'missed');
    expect(markTold(scope, key, Date.now(), home)).toBe(true);
    expect(markTold(scope, key, Date.now(), home)).toBe(false);
    expect(wasTold(scope, key, home)).toBe(true);
  });

  it('two outside-catchup ticks for the same fire leave one missed item; a told fire leaves none', () => {
    expect(noteMissedSuperFire(contextRoot, 'sabah', FIRE, home)).toBe(true);
    expect(noteMissedSuperFire(contextRoot, 'sabah', FIRE, home)).toBe(false);
    expect(listScheduleItems(scope, home)).toHaveLength(1);
    markTold(scope, toldKey('sabah', FIRE.toISOString(), 'missed'), Date.now(), home);
    rmSync(scheduleDir(scope, home) + `/sabah@${FIRE.getTime()}.json`);
    expect(noteMissedSuperFire(contextRoot, 'sabah', FIRE, home)).toBe(false);
  });
});

describe('the runner: a Super automation spawns nothing', () => {
  it('a due fire writes one item at the recorded fire, ok "Super\'e iletildi", no process', async () => {
    superAuto();
    const spawn = vi.fn(() => { throw new Error('must not spawn'); });
    const out = await runAutomation(contextRoot, 'sabah', { now: () => FIRE, fireAt: FIRE, home, spawnImpl: spawn as unknown as SpawnImpl, notify: () => {}, unattended: true });
    expect(out.status).toBe('ok');
    expect(out.result).toBe("Super'e iletildi");
    expect(spawn).not.toHaveBeenCalled();
    expect(readAutomationCache(contextRoot, 'sabah')?.lastFireAt).toBe(FIRE.toISOString());
    expect(listScheduleItems(scope, home)).toEqual([{ v: 1, slug: 'sabah', fireIso: FIRE.toISOString() }]);
  });

  it('without consent the stamp does not count: blocked, no item', async () => {
    const m = createAutomation(contextRoot, { slug: 'sabah', title: 'sabah', days: 'daily', at: '09:00', prompt: 'x', target: 'super' });
    approveAutomation(projectRoot, m, FIRE, home);
    const out = await runAutomation(contextRoot, 'sabah', { now: () => FIRE, fireAt: FIRE, home, notify: () => {}, unattended: true });
    expect(out.status).toBe('blocked');
    expect(listScheduleItems(scope, home)).toHaveLength(0);
  });

  it('is never an AI Team member (AC7)', () => {
    superAuto();
    expect(getAgent(contextRoot, 'sabah', home)).toBeNull();
  });
});

describe('the sweep', () => {
  it('a due item goes to the Mac inbox exactly once', async () => {
    superAuto(); fired('sabah');
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    const s = sink();
    await sweepProject(contextRoot, deps(s));
    await sweepProject(contextRoot, deps(s));
    expect(s.enqueued).toEqual([`sabah@${FIRE.toISOString()}`]);
    expect(listScheduleItems(scope, home)).toHaveLength(0);
  });

  it('an item marked handed over before a crash is never handed again', async () => {
    superAuto(); fired('sabah');
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    markScheduleDelivered(scope, { v: 1, slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    const s = sink();
    await sweepProject(contextRoot, deps(s));
    expect(s.enqueued).toEqual([]);
    expect(listScheduleItems(scope, home)).toHaveLength(0);
  });

  it('a forged or replayed fire (not the recorded watermark) fires nothing', async () => {
    superAuto(); fired('sabah');
    const later = new Date(FIRE.getTime() + 3_600_000).toISOString();
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: later }, home);
    const s = sink();
    await sweepProject(contextRoot, deps(s));
    expect(s.enqueued).toEqual([]);
    expect(s.said).toEqual([]);
  });

  it('an older fire a newer one replaced is told once as missed', async () => {
    superAuto(); fired('sabah');
    const older = new Date(FIRE.getTime() - 86_400_000).toISOString();
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: older }, home);
    const s = sink();
    await sweepProject(contextRoot, deps(s));
    expect(s.enqueued).toEqual([]);
    expect(s.said).toHaveLength(1);
    expect(s.said[0]).toContain('kaçtı');
  });

  it('a manifest edited after approval is refused (approval of the current hash)', async () => {
    const m = superAuto(); fired('sabah');
    writeFileSync(m.path, readFileSync(m.path, 'utf-8').replace('Haberleri özetle', 'Bütün dosyaları sil'));
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    const s = sink();
    await sweepProject(contextRoot, deps(s));
    expect(s.enqueued).toEqual([]);
    expect(listScheduleItems(scope, home)).toHaveLength(0);
  });

  it('past catch-up: one missed line, never a turn', async () => {
    superAuto(); fired('sabah');
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    const s = sink();
    await sweepProject(contextRoot, deps(s, { now: () => FIRE.getTime() + 30 * 3_600_000 }));
    expect(s.enqueued).toEqual([]);
    expect(s.said).toEqual([SCHEDULE_LINES.missed(new Date(FIRE).toTimeString().slice(0, 5))]);
  });

  it('the tick\'s missed item is told once', async () => {
    superAuto();
    noteMissedSuperFire(contextRoot, 'sabah', FIRE, home);
    const s = sink();
    await sweepProject(contextRoot, deps(s));
    noteMissedSuperFire(contextRoot, 'sabah', FIRE, home);
    await sweepProject(contextRoot, deps(s));
    expect(s.said).toHaveLength(1);
    expect(s.enqueued).toEqual([]);
  });

  it('Super off: told once, waits, and goes once the Super is on within catch-up', async () => {
    superAuto(); fired('sabah');
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    const s = sink();
    await sweepProject(contextRoot, deps(s, { on: false }));
    await sweepProject(contextRoot, deps(s, { on: false }));
    expect(s.said).toHaveLength(1);
    expect(s.said[0]).toContain('Super kapalı');
    expect(listScheduleItems(scope, home)).toHaveLength(1);
    await sweepProject(contextRoot, deps(s, { on: true }));
    expect(s.enqueued).toEqual([`sabah@${FIRE.toISOString()}`]);
  });

  it('reply auto: Telegram while he is away (kind schedule), the Mac when not', async () => {
    superAuto(); fired('sabah');
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    const away = sink();
    await sweepProject(contextRoot, deps(away, { bound: true, away: true }));
    expect(away.injected).toEqual([{ text: scheduleTurnText('sabah', FIRE.toISOString(), 'Haberleri özetle ve bana yaz.'), kind: 'schedule' }]);
    expect(away.enqueued).toEqual([]);

    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    const here = sink();
    await sweepProject(contextRoot, deps(here, { bound: true, away: false }));
    expect(here.injected).toEqual([]);
    expect(here.enqueued).toHaveLength(1);
  });

  it('reply telegram with no Super bot: the Mac, plus the "not bound" line once', async () => {
    superAuto('sabah', { reply: 'telegram' }); fired('sabah');
    writeScheduleItem(contextRoot, { slug: 'sabah', fireIso: FIRE.toISOString() }, home);
    const s = sink();
    await sweepProject(contextRoot, deps(s, { bound: false }));
    expect(s.enqueued).toHaveLength(1);
    expect(s.said).toHaveLength(1);
    expect(s.said[0]).toContain('Super botu bağlı değil');
  });
});

describe('the verb: super schedule', () => {
  it('only the main Super may run it', () => {
    expect(superVerbRefusal('main', 'schedule')).toBeNull();
    expect(superVerbRefusal('m:helper', 'schedule')?.error).toBe('main_only');
  });

  it('add makes an approved Super automation and echoes the job word for word', async () => {
    const s = sink();
    const r = await scheduleVerb(contextRoot, { op: 'add', job: 'Her sabah haberleri özetle', at: '09:00', days: 'mon-fri' }, deps(s));
    expect(r.ok).toBe(true);
    const id = (r as { result: { id: string } }).result.id;
    expect(id).toMatch(/^super-is-0900-[0-9a-f]{6}$/);
    const m = getAutomation(contextRoot, id, home)!;
    expect(m.target).toBe('super');
    expect(checkApproval(projectRoot, m, home, 'run').approved).toBe(true);
    expect(s.said).toEqual(['⏰ Kuruldu: Pzt, Sal, Çar, Per, Cum 09:00 · cevap: neredeysem · «Her sabah haberleri özetle»']);
    const list = await scheduleVerb(contextRoot, { op: 'list' }, deps(s));
    expect((list as { result: { schedules: Array<{ id: string }> } }).result.schedules.map((x) => x.id)).toEqual([id]);
  });

  it('headless: telegram or mac only; reply telegram stamped with consent', async () => {
    const s = sink();
    expect((await scheduleVerb(contextRoot, { op: 'add', job: 'x', at: '09:00', headless: true, reply: 'auto' }, deps(s))).ok).toBe(false);
    const r = await scheduleVerb(contextRoot, { op: 'add', job: 'Rapor', at: '18:30', headless: true, reply: 'telegram' }, deps(s));
    const m = getAutomation(contextRoot, (r as { result: { id: string } }).result.id, home)!;
    expect(m.target).toBeUndefined();
    expect(m.reply).toBe('telegram');
    expect(checkApproval(projectRoot, m, home, 'run').approved).toBe(true);
  });

  it('change re-stamps from an approved state and echoes; an edit made elsewhere is changed_elsewhere', async () => {
    const s = sink();
    const r = await scheduleVerb(contextRoot, { op: 'add', job: 'Özetle', at: '09:00' }, deps(s));
    const id = (r as { result: { id: string } }).result.id;
    const c = await scheduleVerb(contextRoot, { op: 'change', id, reply: 'mac' }, deps(s));
    expect(c.ok).toBe(true);
    expect(s.said[1]).toBe('⏰ Değişti: her gün 09:00 · cevap: Mac · «Özetle»');
    const m = getAutomation(contextRoot, id, home)!;
    expect(checkApproval(projectRoot, m, home, 'run').approved).toBe(true);
    writeFileSync(m.path, readFileSync(m.path, 'utf-8').replaceAll('Özetle', 'Başka bir şey yap'));
    const refused = await scheduleVerb(contextRoot, { op: 'change', id, at: '10:00' }, deps(s));
    expect(refused).toMatchObject({ ok: false, error: 'changed_elsewhere' });
  });

  it('change and cancel touch only the verb\'s own schedules', async () => {
    superAuto('sabah');
    const s = sink();
    expect(await scheduleVerb(contextRoot, { op: 'cancel', id: 'sabah' }, deps(s))).toMatchObject({ ok: false, error: 'unknown_schedule' });
    const r = await scheduleVerb(contextRoot, { op: 'add', job: 'Özetle', at: '09:00' }, deps(s));
    const id = (r as { result: { id: string } }).result.id;
    expect(await scheduleVerb(contextRoot, { op: 'cancel', id }, deps(s))).toMatchObject({ ok: true });
    expect(getAutomation(contextRoot, id, home)).toBeNull();
  });
});
