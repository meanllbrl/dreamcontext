import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evenTurnCap,
  cutTurn,
  capTurnsEvenly,
  cleanTurn,
  readTypedTurns,
  countCriteria,
  lastStatusChange,
  compareVersions,
  shippedState,
  reviewRows,
  boardRows,
  renderSleepPacket,
  renderSleepBoard,
  writeSleepPacket,
  factSwitches,
  turnsSince,
  type PacketSession,
  type SleepPacket,
} from '../../src/lib/sleep-packet.js';
import { DEFAULT_STATUSES } from '../../src/lib/task-status.js';
import type { TaskData, TaskSummary } from '../../src/lib/task-backend/types.js';

/**
 * SL-1 / SL-8 / SL-14: the sleep packet the specialists read instead of rebuilding their input.
 * Owner turns are capped evenly and never dropped; machine-written turns are counted, never
 * shown as the owner's; the board names what is ready to close and what went stale by STATUS.
 */

let dir: string;
beforeEach(() => {
  dir = join(tmpdir(), `sleep-packet-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function session(id: string, turns: string[]): PacketSession {
  return {
    id, stopped_at: null, score: 1, task_slugs: [], spawn: null, last_assistant_message: null,
    turns: turns.map((t) => ({ at: null, text: t, cut: 0 })), machine_turns: {}, turns_since: null,
    transcript_problem: null, digest: null,
  };
}

describe('owner turns are capped evenly, never dropped', () => {
  it('returns null when everything fits', () => {
    expect(evenTurnCap([10, 20], 100)).toBeNull();
  });

  it('water-fills: short turns stay whole, long ones share the rest equally', () => {
    // budget 100: 10 stays, the two long ones get (100-10)/2 = 45 each.
    expect(evenTurnCap([10, 500, 900], 100, 1)).toBe(45);
  });

  it('never cuts below the floor, even when that overruns the budget', () => {
    expect(evenTurnCap([5000, 5000, 5000], 100, 400)).toBe(400);
  });

  it('a cut keeps head and tail and names the cut and the command for the whole turn', () => {
    const text = 'A'.repeat(700) + 'MIDDLE' + 'Z'.repeat(300);
    const c = cutTurn(text, 100, 'sess-1');
    expect(c.cut).toBe(text.length - 100);
    expect(c.text.startsWith('A'.repeat(70))).toBe(true);
    expect(c.text.endsWith('Z'.repeat(30))).toBe(true);
    expect(c.text).toContain(`${text.length - 100} chars cut`);
    expect(c.text).toContain('dreamcontext transcript distill sess-1');
  });

  it('every turn survives a cap: an ask after a huge paste is still there', () => {
    const sessions = [session('s1', ['x'.repeat(100_000), 'please fix the login button']), session('s2', ['y'.repeat(50_000)])];
    const r = capTurnsEvenly(sessions, 10_000);
    expect(r.cap).not.toBeNull();
    expect(sessions[0].turns).toHaveLength(2);
    expect(sessions[0].turns[1].text).toBe('please fix the login button');
    expect(sessions[0].turns[1].cut).toBe(0);
    expect(r.cutTurns).toBe(2);
  });
});

describe('machine-written turns are counted, never shown as the owner\'s', () => {
  it('strips harness blocks and keeps the owner\'s words', () => {
    const r = cleanTurn('<system-reminder>CLAUDE.md says…</system-reminder>\nfix the export button');
    expect(r).toEqual({ text: 'fix the export button' });
  });

  it('classifies server, notification and slash-command turns', () => {
    expect(cleanTurn('[super events] batch=1 items=2')).toEqual({ machine: 'super events' });
    expect(cleanTurn('<task-notification><task-id>a</task-id></task-notification>')).toEqual({ machine: 'task notification' });
    expect(cleanTurn('<command-name>/clear</command-name> <command-message>clear</command-message> <command-args></command-args>')).toEqual({ machine: 'command /clear' });
  });

  it('reads typed turns and mid-turn messages, sets the rest aside by kind, and drops an exact echo', () => {
    const lines = [
      { type: 'user', timestamp: '2026-11-11T10:00:00Z', message: { role: 'user', content: 'old ask before the last sleep' } },
      { type: 'user', timestamp: '2026-11-11T12:00:00Z', message: { role: 'user', content: 'new ask: the tab name is wrong' } },
      { type: 'user', timestamp: '2026-11-11T12:00:01Z', message: { role: 'user', content: 'new ask: the tab name is wrong' } },
      { type: 'user', timestamp: '2026-11-11T12:01:00Z', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: x' } },
      { type: 'user', timestamp: '2026-11-11T12:02:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'attachment', timestamp: '2026-11-11T12:03:00Z', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'and the button too' }] } },
      { type: 'attachment', timestamp: '2026-11-11T12:04:00Z', attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>' } },
      { type: 'user', timestamp: '2026-11-11T12:05:00Z', message: { role: 'user', content: '[super events] batch=b items=1' } },
      { type: 'assistant', timestamp: '2026-11-11T12:06:00Z', message: { role: 'assistant', content: 'sure' } },
    ];
    const path = join(dir, 't.jsonl');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
    const r = readTypedTurns(path, '2026-11-11T11:00:00Z');
    expect(r.turns.map((t) => t.text)).toEqual(['new ask: the tab name is wrong', 'and the button too']);
    expect(r.machine).toEqual({ 'repeat of the previous turn': 1, 'task notification': 1, 'super events': 1 });
  });

  it('an unreadable transcript reads as no turns, never a throw', () => {
    expect(readTypedTurns(join(dir, 'missing.jsonl'), null)).toEqual({ turns: [], machine: {} });
  });

  it('turns since: the last consolidation that covered the session', () => {
    const h = [
      { date: '', consolidated_at: '2026-11-10T00:00:00Z', summary: '', debt_before: 0, debt_after: 0, sessions_processed: 0, bookmarks_processed: 0, session_ids: ['a'] },
    ];
    expect(turnsSince('a', h)).toBe('2026-11-10T00:00:00Z');
    expect(turnsSince('b', h)).toBeNull();
  });
});

describe('the board: ready to close and stale, keyed on the last STATUS change', () => {
  it('counts checkbox criteria', () => {
    expect(countCriteria('- [x] a\n- [ ] b\n* [X] c\nnot a box')).toEqual({ total: 3, ticked: 2 });
  });

  it('finds the newest Status → header, ignoring session updates', () => {
    const log = '### 2026-11-11 - Session Update\n- x\n### 2026-10-02 - Status → in_review (by claude)\n### 2026-09-01 - Status -> in_progress\n';
    expect(lastStatusChange(log)).toBe('2026-10-02');
    expect(lastStatusChange('### 2026-11-11 - Session Update')).toBeNull();
  });

  it('compares versions numerically and knows what shipped', () => {
    expect(compareVersions('0.41.10', '0.41.9')).toBeGreaterThan(0);
    const rel = [{ version: '0.41.13', status: 'released' }, { version: '0.41.14', status: 'planning' }];
    expect(shippedState('0.41.13', rel, '0.41.12')).toBe('released');
    expect(shippedState('0.41.5', rel, '0.41.16')).toBe('installed');
    expect(shippedState('0.41.17', rel, '0.41.16')).toBeNull();
    expect(shippedState(null, rel, '0.41.16')).toBeNull();
    expect(shippedState('BACKLOG', rel, '0.41.16')).toBeNull();
  });

  function task(slug: string, over: Partial<TaskData>): TaskData {
    return {
      slug, id: slug, name: slug, description: '', priority: 'medium', urgency: 'medium', status: 'in_review',
      created_at: '2026-09-01', updated_at: '2026-11-11', tags: [], parent_task: null, related_feature: null,
      version: '0.41.5', rice: null, start_date: null, due_date: null, objectives: [], assignee: null,
      custom_fields: {}, filed_by: null, filing_basis: null, why: '', user_stories: '', acceptance_criteria: '',
      constraints: '', technical_details: '', notes: '', changelog: '', sections: [], body: '', rawBody: '', raw: {},
      ...over,
    };
  }

  it('ready = every criterion ticked AND shipped; stale = old status change, not ready', () => {
    const now = new Date('2026-11-12T00:00:00Z');
    const r = reviewRows([
      task('ready', { acceptance_criteria: '- [x] a\n- [x] b', changelog: '### 2026-10-01 - Status → in_review' }),
      task('open-criterion', { acceptance_criteria: '- [x] a\n- [ ] b', changelog: '### 2026-10-01 - Status → in_review' }),
      task('no-criteria', { acceptance_criteria: '', changelog: '### 2026-11-10 - Status → in_review' }),
      task('unshipped', { version: '0.42.0', acceptance_criteria: '- [x] a', changelog: '### 2026-11-11 - Status → in_review' }),
      // Edited yesterday, but its STATUS has not moved since September: stale.
      task('edited-but-stale', { updated_at: '2026-11-11', acceptance_criteria: '- [ ] a', changelog: '### 2026-11-11 - Session Update\n### 2026-09-15 - Status → in_review' }),
    ], [], '0.41.16', now);
    expect(r.ready.map((x) => x.slug)).toEqual(['ready']);
    expect(r.ready[0]).toMatchObject({ criteria: 2, ticked: 2, shipped: 'installed', last_status_change: '2026-10-01' });
    expect(r.stale.map((x) => x.slug).sort()).toEqual(['edited-but-stale', 'open-criterion']);
  });

  it('the open board leaves terminal statuses out, newest first', () => {
    const rows = boardRows([
      { name: 'done-one', description: 'Done one', status: 'completed', updated_at: '2026-11-12', file: '/x/done-one.md', version: null, parent_task: null } as unknown as TaskSummary,
      { name: 'older', description: 'Older', status: 'todo', updated_at: '2026-11-01', file: '/x/older.md', version: '0.1.0', parent_task: null } as unknown as TaskSummary,
      { name: 'newer', description: 'Newer: a longer sentence', status: 'in_progress', updated_at: '2026-11-10', file: '/x/newer.md', version: null, parent_task: 'older' } as unknown as TaskSummary,
    ], DEFAULT_STATUSES);
    expect(rows.map((r) => r.slug)).toEqual(['newer', 'older']);
    expect(rows[0]).toMatchObject({ status: 'in_progress', updated: '2026-11-10', parent: 'older', name: 'Newer: a longer sentence' });
  });
});

describe('rendering and writing', () => {
  function packet(): SleepPacket {
    const s = session('sess-a', ['fix the thing please']);
    s.machine_turns = { 'super events': 2 };
    return {
      generated_at: '2026-11-12T00:00:00Z', epoch: '2026-11-12T00:00:00Z', since: '2026-11-11T00:00:00Z',
      sessions: [s], owner_turns: { total_chars: 20, budget: 40_000, per_turn_cap: null, cut_turns: 0 },
      board: { open: [{ slug: 'a-task', status: 'todo', updated: '2026-11-11', name: 'A task', version: null, parent: null }], counts: { todo: 1 } },
      ready_to_close: [{ slug: 'r', name: 'R', version: '0.1.0', criteria: 1, ticked: 1, last_status_change: '2026-10-01', shipped: 'released' }],
      stale_review: [], git: [{ repo: 'project', path: '/p', log: ['abc fix'], status: [], more: 0, problem: null }],
      active_version: '0.2.0', filing_rules: ['!rules unreadable'], flags: [],
      facts: { people: 1, single_person: true, automation_outputs: 0, app_findings: 0, objectives: false, marketing: false, learning: false, depth: 'standard' },
    };
  }

  it('the facts switch whole prompt sections off (SL-14)', () => {
    const lines = factSwitches(packet().facts).join('\n');
    expect(lines).toContain('sleep-tasks skips §2.5');
    expect(lines).toContain('sleep-state skips Pass B.5');
    expect(lines).toContain('sleep-product skips B7');
    expect(lines).toContain('sleep-product skips B8');
    expect(lines).toContain('skips grooming (d)');
    const multi = factSwitches({ ...packet().facts, people: 3, single_person: false, automation_outputs: 2, app_findings: 1, objectives: true }).join('\n');
    expect(multi).toContain('sleep-tasks runs §2.5');
    expect(multi).toContain('runs B7');
    expect(multi).toContain('runs B8');
  });

  it('the packet names machine turns and warnings; the board half carries ready-to-close', () => {
    const md = renderSleepPacket(packet());
    expect(md).toContain('fix the thing please');
    expect(md).toContain('super events ×2');
    expect(md).toContain('WARNING: rules unreadable');
    expect(md).toContain('abc fix');
    expect(md).not.toContain('## Open board');
    const board = renderSleepBoard(packet());
    expect(board).toContain('a-task | todo | 2026-11-11');
    expect(board).toContain('- r · 1/1 · 0.1.0 released · 2026-10-01');
  });

  it('writes packet.md, board.md and packet.json under tmp/sleep', () => {
    const paths = writeSleepPacket(dir, packet());
    expect(readFileSync(paths.md, 'utf-8')).toContain('# Sleep packet');
    expect(readFileSync(paths.board, 'utf-8')).toContain('# Sleep packet: task board');
    expect(JSON.parse(readFileSync(paths.json, 'utf-8')).sessions[0].id).toBe('sess-a');
  });

  it('refuses a symlinked tmp/ (the owner\'s turns never go where a link points)', () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    const ctx = join(dir, 'ctx');
    mkdirSync(ctx);
    symlinkSync(elsewhere, join(ctx, 'tmp'));
    expect(() => writeSleepPacket(ctx, packet())).toThrow(/symlink/);
    expect(existsSync(join(elsewhere, 'sleep'))).toBe(false);
  });
});
