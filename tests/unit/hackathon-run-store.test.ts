/**
 * Hackathon criteria 3, 5 and 13 (frames half): the run record moves only along its states;
 * `result.json` is written once, from structured fields, and `outcome --pr merged` sets `pr`; a
 * live frame shows a team command with its secret redacted; no hackathon UI, card or skill text
 * holds a dollar amount; the chat's hackathon card names only the run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addMoment, canMove, createRun, designHash, listRuns, newRunId, readRun, resultPath, runDir, updateRun, RUN_ID_RE, type RunRecord,
} from '../../src/lib/hackathon/run-store.js';
import { setOutcome, writeResult } from '../../src/lib/hackathon/apply.js';
import { parseEvents, runFrames } from '../../src/lib/hackathon/frames.js';
import { validateDesign } from '../../src/lib/hackathon/designer.js';
import { parseViewBlock } from '../../src/lib/chat-view-spec.js';

const repo = join(__dirname, '..', '..');
const design = validateDesign({
  kind: 'plan', problem: 'Gelir deneyi', target: '/repo',
  teams: [{ id: 'a', name: 'Alfa', tool: 'claude' }, { id: 'b', name: 'Beta', tool: 'claude', inner: 'solo' }],
  rounds: 2, roundMinutes: 20,
}, { codexUsable: false }, new Date('2026-11-18T10:00:00Z')).design;

let ctx: string;
beforeEach(() => { ctx = join(mkdtempSync(join(tmpdir(), 'hk-store-')), '_dream_context'); mkdirSync(ctx); });
afterEach(() => rmSync(join(ctx, '..'), { recursive: true, force: true }));

function seed(state: RunRecord['state'] = 'awaiting-owner'): RunRecord {
  const id = newRunId(ctx, design.problem, new Date('2026-11-18T10:00:00Z'));
  const r: RunRecord = { version: 1, id, problem: design.problem, state, createdAt: '2026-11-18T10:00:00Z', design };
  createRun(ctx, r);
  return r;
}

describe('run record', () => {
  it('names the run by date and slug and lists it', () => {
    const r = seed();
    expect(RUN_ID_RE.test(r.id)).toBe(true);
    expect(listRuns(ctx).map((x) => x.id)).toEqual([r.id]);
    expect(readFileSync(join(ctx, 'hackathon', '.gitignore'), 'utf-8')).toMatch(/\*\/teams\//);
  });
  it('moves only along its states', () => {
    expect(canMove('awaiting-owner', 'running')).toBe(true);
    expect(canMove('picked', 'running')).toBe(false);
    const r = seed();
    expect(() => updateRun(ctx, r.id, (x) => ({ ...x, state: 'picked' }))).toThrow();
    const next = updateRun(ctx, r.id, (x) => addMoment({ ...x, state: 'running' }, 'tur 1 başladı'));
    expect(next.state).toBe('running');
    expect(readRun(ctx, r.id)?.moments?.[0]?.text).toBe('tur 1 başladı');
  });
  it('hashes the design canonically (key order does not matter)', () => {
    const a = designHash({ design });
    const reverse = (v: unknown): unknown => Array.isArray(v) ? v.map(reverse)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverse((v as Record<string, unknown>)[k])])) : v;
    const shuffled = reverse(design) as typeof design;
    expect(Object.keys(shuffled)[0]).not.toBe(Object.keys(design)[0]);
    expect(designHash({ design: shuffled })).toBe(a);
    expect(designHash({ design: { ...design, rounds: 3 } })).not.toBe(a);
  });
});

describe('result.json', () => {
  it('is written once, from structured fields; outcome sets pr', () => {
    const r = seed('judging');
    writeFileSync(join(runDir(ctx, r.id), 'jury.json'), JSON.stringify({ scores: { a: 8, b: 6 }, originality: { a: 7, b: 9 }, ranking: ['a', 'b'], sameVendor: true, verdicts: [] }));
    const first = writeResult(ctx, r, design, 'a');
    expect(first?.pick).toBe('a');
    expect(first?.juryOwnerAgree).toBe(true);
    expect(writeResult(ctx, r, design, 'b')).toBeNull();
    const onDisk = JSON.parse(readFileSync(resultPath(ctx, r.id), 'utf-8')) as { pick: string; teams: { juryScore: number }[] };
    expect(onDisk.pick).toBe('a');
    expect(onDisk.teams[0]?.juryScore).toBe(8);
    expect(setOutcome(ctx, r.id, 'merged').pr).toBe('merged');
  });
});

describe('frames', () => {
  it('shows a team command with its secret redacted', () => {
    const r = seed('running');
    const dir = join(runDir(ctx, r.id), 'teams', 'a');
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 npm test' } }] } },
    ];
    writeFileSync(join(dir, 'r1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    const f = runFrames(ctx, r.id, design, () => '/repo').find((x) => x.team === 'a')!;
    expect(f.screen?.kind).toBe('bash');
    expect(f.screen?.command).not.toContain('sk-ant-api03');
    expect(f.screen?.command).toContain('[gizli]');
    expect(f.members.map((m) => m.role)).toEqual(['kaptan', 'yapici', 'elestirmen']);
  });
  it('counts the files a team changed across every round, not only the newest turn', () => {
    const r = seed('running');
    const dir = join(runDir(ctx, r.id), 'teams', 'a');
    mkdirSync(dir, { recursive: true });
    const r1 = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { subagent_type: 'yapici' } }] } },
      { type: 'assistant', parent_tool_use_id: 'ag', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/index.html', new_string: '<h1>Deneme</h1>' } }] } },
      { type: 'assistant', parent_tool_use_id: 'ag', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/style.css' } }] } },
      { type: 'result' },
    ];
    writeFileSync(join(dir, 'r1.jsonl'), r1.map((l) => JSON.stringify(l)).join('\n'));
    // Round 2 has begun and made no move yet (only its init line).
    writeFileSync(join(dir, 'r2.jsonl'), JSON.stringify({ type: 'system', subtype: 'init' }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(dir, 'r2.jsonl'), later, later);
    const f = runFrames(ctx, r.id, design, () => '/repo').find((x) => x.team === 'a')!;
    expect(f.edited).toEqual(['index.html']);
    expect(f.reads).toBe(1);
    expect(f.screen?.path).toBe('style.css');
    expect(f.ended).toBe(false);
  });
  it('reads a sub-agent tool call as the Yapıcı and a result as the turn end', () => {
    const raw = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { subagent_type: 'yapici' } }] } },
      { type: 'assistant', parent_tool_use_id: 'ag', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/web/Home.tsx', new_string: 'x' } }] } },
      { type: 'result' },
    ].map((l) => JSON.stringify(l)).join('\n');
    const { events, ended } = parseEvents(raw);
    expect(events[1]?.role).toBe('yapici');
    expect(ended).toBe(true);
  });
});

describe('chat card', () => {
  it('names the run only', () => {
    expect(parseViewBlock('{"type":"hackathon","run":"20261118-ana-sayfa"}').view).toEqual({ type: 'hackathon', run: '20261118-ana-sayfa' });
    expect(parseViewBlock('{"type":"hackathon","run":"../etc"}').view).toBeNull();
    const described = parseViewBlock('{"type":"hackathon","run":"20261118-ana-sayfa","teams":[]}');
    expect(described.view).toEqual({ type: 'hackathon', run: '20261118-ana-sayfa' });
    expect(described.notices.join(' ')).toMatch(/ignored/);
  });
});

describe('no dollar amounts (criterion 5)', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else files.push(p);
    }
  };
  walk(join(repo, 'src', 'lib', 'hackathon'));
  walk(join(repo, 'dashboard', 'src', 'components', 'hackathon'));
  files.push(
    join(repo, 'src', 'cli', 'commands', 'hackathon.ts'),
    join(repo, 'src', 'server', 'routes', 'hackathon.ts'),
    join(repo, 'dashboard', 'src', 'pages', 'HackathonPage.tsx'),
    join(repo, 'skill', 'references', 'hackathon.md'),
  );
  it.each(files.map((f) => [f.slice(repo.length + 1), f]))('%s holds no dollar amount', (_rel, f) => {
    const text = readFileSync(f, 'utf-8');
    expect(text).not.toMatch(/\$\s?\d|\d\s?(USD|dolar)\b|\bUSD\b/i);
  });
  it('the hackathon i18n strings hold no dollar amount', () => {
    const i18n = readFileSync(join(repo, 'dashboard', 'src', 'context', 'I18nContext.tsx'), 'utf-8');
    const lines = i18n.split('\n').filter((l) => /'(hk\.|plugin\.hackathon\.)/.test(l));
    expect(lines.length).toBeGreaterThan(100);
    for (const l of lines) expect(l).not.toMatch(/\$\s?\d|\bUSD\b|dolar/i);
  });
});
