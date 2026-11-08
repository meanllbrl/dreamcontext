/**
 * What a chat's run card says (review r2): one precedence, so a refused press is never hidden
 * behind the record's old "finished", and only a card that ran says it ran.
 */
import { describe, it, expect } from 'vitest';
import { REFUSED_NOTE, runCardView, type RunCardFacts } from '../../dashboard/src/components/sleepy/chat/runCardView.js';

const mac: RunCardFacts = {
  loaded: true, hasRecord: true, canStart: true, phone: false, desktop: true,
  state: 'open', liveOwner: null, connected: false, connectedIsOwn: false, outcome: null,
};
const phone: RunCardFacts = { ...mac, phone: true, desktop: false };
const done = { state: 'closed' as const, closedBy: 'done' as const, recordExit: 0 };

describe('a refused press shows on ANY card, over the record\'s close reason', () => {
  it('an open card: idle, the refusal, Run stays pressable', () => {
    const v = runCardView({ ...mac, outcome: { kind: 'refused' } });
    expect(v).toMatchObject({ phase: 'idle', note: REFUSED_NOTE, chip: undefined, runLabel: 'Run', startable: true });
  });
  it('Run again on a finished card refused: the old exit chip and "Finished" are gone', () => {
    const v = runCardView({ ...mac, ...done, outcome: { kind: 'refused' } });
    expect(v.note).toBe(REFUSED_NOTE);
    expect(v.chip).toBeUndefined();
    expect(v.note).not.toMatch(/Finished|agent gets/);
    expect(v.runLabel).toBe('Run again');
    expect(v.startable).toBe(true);
  });
  it('a cut-off card refused on the Mac says the refusal, not "cut off"', () => {
    expect(runCardView({ ...mac, state: 'closed', closedBy: 'interrupted', outcome: { kind: 'refused' } }).note).toBe(REFUSED_NOTE);
  });
  it('the refusal never promises that a retry works', () => {
    expect(REFUSED_NOTE).not.toMatch(/try again/i);
  });
});

describe('only a card that ran says it ran', () => {
  it('done: Ran in chat with its exit code; Run again on the Mac only', () => {
    expect(runCardView({ ...mac, ...done })).toMatchObject({ phase: 'done', title: 'Ran in chat', chip: 0, runLabel: 'Run again' });
    expect(runCardView({ ...phone, ...done })).toMatchObject({ phase: 'done', chip: 0, runLabel: null });
  });
  it('interrupted: Cut off, no exit chip, Run again on the Mac only', () => {
    const v = runCardView({ ...mac, state: 'closed', closedBy: 'interrupted' });
    expect(v).toMatchObject({ phase: 'done', title: 'Cut off', chip: undefined, runLabel: 'Run again' });
    expect(runCardView({ ...phone, state: 'closed', closedBy: 'interrupted' }).runLabel).toBeNull();
  });
  it.each(['superseded', 'dropped', 'answered', undefined] as const)('closed as %s: never "Ran"/"Finished", no chip, nothing to run again', (closedBy) => {
    const v = runCardView({ ...mac, state: 'closed', closedBy, recordExit: 0 });
    expect(v.phase).toBe('closed');
    expect(`${v.title} ${v.note}`).not.toMatch(/Ran in chat|Finished|agent gets/);
    expect(v.chip).toBeUndefined();
    expect(v.runLabel).toBeNull();
  });
  it('an exit seen here wins over a record that has not caught up yet', () => {
    expect(runCardView({ ...mac, outcome: { kind: 'exited', code: 2 } })).toMatchObject({ phase: 'done', title: 'Ran in chat', chip: 2, runLabel: 'Run again' });
  });
});

describe('running', () => {
  it('the owner\'s own terminal takes keys; a watcher says to click it first', () => {
    expect(runCardView({ ...mac, connected: true, connectedIsOwn: true }).note).toBe('Type here as you would in your own terminal.');
    expect(runCardView({ ...mac, liveOwner: 'telegram', connected: true }).note).toContain('Started from Telegram. Click the terminal');
    expect(runCardView({ ...mac, liveOwner: 'phone', connected: true }).note).toContain('Started on the phone. Click the terminal');
    expect(runCardView({ ...phone, liveOwner: 'mac', connected: true }).note).toContain('Click the terminal');
  });
  it('a running card offers no Run, whatever the record or the last press', () => {
    expect(runCardView({ ...mac, ...done, liveOwner: 'phone', outcome: { kind: 'refused' } })).toMatchObject({ phase: 'running', runLabel: null, startable: false });
  });
});

describe('before and without a record', () => {
  it('not loaded: a disabled Run', () => {
    expect(runCardView({ ...mac, loaded: false, hasRecord: false })).toMatchObject({ runLabel: 'Run', startable: false, note: 'Checking this card…' });
  });
  it('no record: Copy only; the phone is not told to use a terminal', () => {
    expect(runCardView({ ...mac, hasRecord: false }).runLabel).toBeNull();
    expect(runCardView({ ...phone, hasRecord: false }).note).not.toMatch(/your terminal/);
  });
});
