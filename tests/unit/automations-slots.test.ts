/**
 * Multiple fire slots, end to end below the CLI: what the store writes and
 * reads, what the run is told about which slot fired, and what the flow draws.
 * The pure schedule math lives in automations-schedule.test.ts.
 *
 * The properties that fail silently if they break:
 *  - a one-slot agent keeps writing the legacy `{ days, at }` and keeps its
 *    approval hash, so nothing on disk changes shape or re-approves;
 *  - an edit that does not name the schedule leaves every slot alone;
 *  - a broken slot is NAMED by `cadenceLabel`, not reported as "no schedule";
 *  - the run learns its slot from the fire moment, so a late catch-up and a
 *    queued fire still say "the mon 09:30 slot".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  automationPath,
  cadenceLabel,
  createAutomation,
  deriveFlowFromManifest,
  flowForDisplay,
  getAutomation,
  readAutomationFile,
  scheduleFromInput,
  updateAutomation,
  writeFlowSection,
} from '../../src/lib/automations/store.js';
import { approveAutomation, checkApproval, manifestHash } from '../../src/lib/automations/registry.js';
import { buildFireSlotLine, buildPreamble, fireSlotEnv, runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { AutomationError, type ScheduleSlot } from '../../src/lib/automations/types.js';
import {
  initialSlotRows,
  newSlotRow,
  nextFireWords,
  slotFromRow,
  slotRowFromSlot,
  slotsFromRows,
} from '../../dashboard/src/lib/agentDraft.js';

let projectRoot: string;
let contextRoot: string;
let home: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-slots-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-slots-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const FUNNEL_SLOTS: ScheduleSlot[] = [
  { kind: 'weekly', days: ['mon'], at: '09:30' },
  { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '16:30' },
];

function frontmatterOf(slug: string): string {
  const raw = readFileSync(automationPath(contextRoot, slug), 'utf-8');
  return raw.split('---')[1];
}

describe('the store writes and reads slots', () => {
  it('a one-slot agent is written in the exact legacy { days, at } shape', () => {
    createAutomation(contextRoot, { slug: 'one', title: 'One', days: ['mon', 'wed'], at: '09:00', prompt: 'x' });
    const fm = frontmatterOf('one');
    expect(fm).toMatch(/schedule:\n\s+days:\n\s+- mon\n\s+- wed\n\s+at: '09:00'/);
    expect(fm).not.toContain('slots');
  });

  it('several slots are written under schedule.slots and read back as the same union', () => {
    const m = createAutomation(contextRoot, { slug: 'funnel', title: 'Funnel', slots: FUNNEL_SLOTS, prompt: 'x' });
    expect(frontmatterOf('funnel')).toContain('slots:');
    expect(m.schedule).toEqual({ slots: FUNNEL_SLOTS });
    expect(cadenceLabel(m)).toBe('mon 09:30 · mon–fri 16:30');
  });

  it('slots win over days/at, and a bad slot is refused before anything is written', () => {
    const m = createAutomation(contextRoot, { slug: 'wins', title: 'W', days: 'daily', at: '07:00', slots: FUNNEL_SLOTS, prompt: 'x' });
    expect(m.schedule?.slots).toHaveLength(2);
    expect(() => createAutomation(contextRoot, {
      slug: 'bad', title: 'Bad', prompt: 'x',
      slots: [FUNNEL_SLOTS[0], { kind: 'monthdays', monthdays: [0], at: '09:00' }],
    })).toThrow(/slot 2: monthdays/);
    expect(getAutomation(contextRoot, 'bad')).toBeNull();
  });

  it('scheduleFromInput re-validates a typed slot from its serialized form (one validator)', () => {
    expect(() => scheduleFromInput({ slots: [{ kind: 'weekly', days: ['mon'], at: '25:00' }] })).toThrow(AutomationError);
    expect(() => scheduleFromInput({ slots: [{ kind: 'bogus' } as unknown as ScheduleSlot] })).toThrow(/slot 1/);
    expect(() => scheduleFromInput({ slots: [] })).toThrow(/at least one slot/);
  });

  it('a hand-edited broken slot is named by cadenceLabel, and never due', () => {
    const m = createAutomation(contextRoot, { slug: 'broken', title: 'Broken', days: 'daily', at: '09:00', prompt: 'x' });
    const raw = readFileSync(m.path, 'utf-8').replace(
      /schedule:\n(?:\s+.*\n)+?(?=model:)/,
      "schedule:\n  slots:\n    - { days: [mon], at: '09:30' }\n    - { monthdays: [32], at: '09:00' }\n",
    );
    writeFileSync(m.path, raw);
    const read = readAutomationFile(m.path);
    expect(read.schedule).toBeNull();
    expect(read.scheduleError).toMatch(/^slot 2: monthdays "32"/);
    expect(cadenceLabel(read)).toMatch(/^invalid schedule \(slot 2: monthdays/);
  });
});

describe('editing the schedule', () => {
  it('an edit that names no schedule leaves every slot byte-identical', () => {
    createAutomation(contextRoot, { slug: 'funnel', title: 'Funnel', slots: FUNNEL_SLOTS, prompt: 'x' });
    const before = frontmatterOf('funnel').match(/schedule:[\s\S]*?(?=\nmodel:)/)?.[0];
    const edited = updateAutomation(contextRoot, 'funnel', { title: 'Funnel watch' });
    expect(edited.schedule).toEqual({ slots: FUNNEL_SLOTS });
    expect(frontmatterOf('funnel').match(/schedule:[\s\S]*?(?=\nmodel:)/)?.[0]).toBe(before);
  });

  it('slots replace the whole schedule; the one-slot days/at shorthand collapses it to one slot', () => {
    createAutomation(contextRoot, { slug: 'funnel', title: 'Funnel', days: 'daily', at: '09:00', prompt: 'x' });
    const two = updateAutomation(contextRoot, 'funnel', { slots: FUNNEL_SLOTS });
    expect(two.schedule).toEqual({ slots: FUNNEL_SLOTS });
    const one = updateAutomation(contextRoot, 'funnel', { at: '10:00' });
    expect(one.schedule).toEqual({ slots: [{ kind: 'weekly', days: ['mon'], at: '10:00' }] });
  });

  it('refuses to edit around a schedule that is broken on disk', () => {
    const m = createAutomation(contextRoot, { slug: 'broken', title: 'Broken', days: 'daily', at: '09:00', prompt: 'x' });
    writeFileSync(m.path, readFileSync(m.path, 'utf-8').replace("at: '09:00'", "at: 'noon'"));
    expect(() => updateAutomation(contextRoot, 'broken', { title: 'Renamed' })).toThrow(/broken/);
    // …but a new schedule repairs it.
    expect(updateAutomation(contextRoot, 'broken', { slots: FUNNEL_SLOTS }).schedule).toEqual({ slots: FUNNEL_SLOTS });
  });

  it('changing the slots never touches the approval — the schedule is not hashed', () => {
    const m = createAutomation(contextRoot, { slug: 'funnel', title: 'Funnel', days: 'daily', at: '09:00', prompt: 'x' });
    approveAutomation(projectRoot, m, new Date(), home);
    const hash = manifestHash(m);
    const edited = updateAutomation(contextRoot, 'funnel', {
      slots: [...FUNNEL_SLOTS, { kind: 'weekly', days: ['mon'], at: '10:00', everyWeeks: 2, anchor: '2026-09-28' }, { kind: 'cron', cron: '0 9 1 * *' }],
    });
    expect(manifestHash(edited)).toBe(hash);
    expect(checkApproval(projectRoot, edited, home).approved).toBe(true);
  });
});

describe('the flow draws every slot', () => {
  it('the derived trigger node is labelled with all slots', () => {
    const m = createAutomation(contextRoot, { slug: 'funnel', title: 'Funnel', slots: FUNNEL_SLOTS, prompt: 'x' });
    expect(deriveFlowFromManifest(m).nodes[0].label).toBe('mon 09:30 · mon–fri 16:30');
  });

  it('a WRITTEN flow is relabelled from the live schedule for display, never on disk', () => {
    let m = createAutomation(contextRoot, { slug: 'funnel', title: 'Funnel', days: 'daily', at: '09:00', prompt: 'x' });
    m = writeFlowSection(contextRoot, m.slug, deriveFlowFromManifest(m));
    const edited = updateAutomation(contextRoot, 'funnel', { slots: FUNNEL_SLOTS });
    expect(edited.flow?.nodes[0].label).toBe('daily 09:00'); // what is hashed stays put
    expect(flowForDisplay(edited).nodes[0].label).toBe('mon 09:30 · mon–fri 16:30');
  });
});

describe('the run is told which slot fired', () => {
  const manifest = { mode: 'sched' as const, schedule: { slots: FUNNEL_SLOTS } };

  it('names the slot from the fire moment, even when the run starts late', () => {
    const fire = new Date(2026, 8, 28, 9, 30);
    expect(fireSlotEnv(manifest, fire)).toBe('mon 09:30');
    expect(fireSlotEnv(manifest, new Date(2026, 8, 29, 16, 30))).toBe('mon-fri 16:30'); // ASCII in the env
    const line = buildFireSlotLine(manifest, fire);
    expect(line).toContain('This fire: the mon 09:30 slot, scheduled for Mon 2026-09-28 09:30 local time');
  });

  it('a manual run says so, and an on-call agent gets no slot line at all', () => {
    const manual = new Date(2026, 8, 28, 11, 2, 17);
    expect(fireSlotEnv(manifest, manual)).toBe('manual');
    expect(buildFireSlotLine(manifest, manual)).toMatch(/^This fire: a manual run, not one of the scheduled slots \(mon 09:30 · mon–fri 16:30\)/);
    expect(buildFireSlotLine({ mode: 'call', schedule: null }, manual)).toBe('');
    expect(fireSlotEnv({ mode: 'call', schedule: null }, manual)).toBe('manual');
  });

  it('the preamble carries the line right after the fire time', () => {
    const m = createAutomation(contextRoot, { slug: 'funnel', title: 'Funnel', slots: FUNNEL_SLOTS, prompt: 'x' });
    const preamble = buildPreamble(m, projectRoot, new Date(2026, 8, 29, 16, 30), '/tmp/out.md');
    expect(preamble).toMatch(/Fire time \S+\. This fire: the mon–fri 16:30 slot/);
  });

  it('the spawned child gets DREAMCONTEXT_AUTOMATION_SLOT', async () => {
    const fireAt = new Date(2026, 8, 28, 9, 30);
    const m = createAutomation(contextRoot, { slug: 'funnel', title: 'Funnel', slots: FUNNEL_SLOTS, prompt: 'x' });
    approveAutomation(projectRoot, m, fireAt, home);
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 4321, stdout, stderr: new EventEmitter(), kill: () => {} });
    const spawnFn = vi.fn(() => child) as unknown as SpawnImpl;
    const run = runAutomation(contextRoot, m.slug, {
      now: () => new Date(2026, 8, 28, 11, 0), fireAt, home, spawnImpl: spawnFn, killImpl: vi.fn(), notify: () => {},
    });
    stdout.emit('data', Buffer.from(JSON.stringify({
      session_id: 's', result: 'Done.\n', is_error: false, permission_denials: [], total_cost_usd: 0, num_turns: 1, duration_ms: 1, subtype: 'success',
    })));
    child.emit('close', 0);
    await run;
    const opts = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.DREAMCONTEXT_AUTOMATION_SLOT).toBe('mon 09:30');
  });
});

describe('the dialog\'s slot rows', () => {
  const TODAY = new Date(2026, 8, 28, 8);

  it('every saved cadence opens as a row and saves back to the same slot', () => {
    const slots: ScheduleSlot[] = [
      ...FUNNEL_SLOTS,
      { kind: 'weekly', days: 'daily', at: '07:00' },
      { kind: 'weekly', days: ['mon'], at: '10:00', everyWeeks: 2, anchor: '2026-09-28' },
      { kind: 'monthdays', monthdays: [1, 15, -1], at: '09:00' },
      { kind: 'nth', nth: [{ weekday: 'mon', n: 1 }, { weekday: 'fri', n: -1 }], at: '09:30' },
      { kind: 'cron', cron: '30 9 * * 1' },
    ];
    const rows = slots.map((s) => slotRowFromSlot(s, TODAY));
    const back = slotsFromRows(rows);
    expect('slots' in back && back.slots).toEqual(slots);
  });

  it('a starter opens one row from its days/at; no days is an error named per row', () => {
    const [row] = initialSlotRows(null, { days: ['fri'], at: '17:00' }, TODAY);
    expect(slotFromRow(row)).toEqual({ slot: { kind: 'weekly', days: ['fri'], at: '17:00' } });
    const bad = slotsFromRows([row, newSlotRow(TODAY, { days: [] })]);
    expect(bad).toEqual({ error: 'Time 2: Pick at least one day.' });
    expect(slotsFromRows([newSlotRow(TODAY, { cadence: 'monthdays', monthText: '0' })])).toMatchObject({ error: expect.stringMatching(/monthdays/) });
  });

  it('nextFireWords names the next fire the way a person says it', () => {
    const now = new Date(2026, 8, 28, 10);
    expect(nextFireWords(new Date(2026, 8, 28, 16, 30).toISOString(), now)).toBe('today 16:30');
    expect(nextFireWords(new Date(2026, 8, 29, 9, 30).toISOString(), now)).toBe('tomorrow 09:30');
    expect(nextFireWords(new Date(2026, 9, 2, 9, 30).toISOString(), now)).toBe('Fri 09:30');
    expect(nextFireWords(new Date(2026, 9, 12, 10).toISOString(), now)).toBe('12 Oct, 10:00');
    expect(nextFireWords(null, now)).toBeNull();
  });
});
