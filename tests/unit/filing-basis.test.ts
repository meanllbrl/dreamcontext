import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decideFiling,
  filingFields,
  findQuote,
  normalizeQuote,
  quoteTooThin,
  readFilingBasis,
  type FilingInput,
} from '../../src/lib/filing-basis.js';

/**
 * Who opened a task and why (lib/filing-basis.ts): the decision every create path takes, the
 * Turkish-aware quote match, and the transcript rules (only turns the owner typed count; a
 * compaction summary is not an ask; defect evidence lives in tool results).
 */

let dir: string;
let transcript: string;

function line(rec: unknown): string {
  return JSON.stringify(rec);
}

beforeEach(() => {
  const raw = join(tmpdir(), `fb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  dir = realpathSync(raw);
  transcript = join(dir, 's1.jsonl');
  writeFileSync(transcript, [
    line({ type: 'user', message: { role: 'user', content: 'Şunu da ekle: görev sayfasında İTİRAZ düğmesi olsun, lütfen!' } }),
    line({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary: the owner wants a dark mode toggle in settings' } }),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: wants a purple header bar' } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Error: ENOENT reading state/.sleep.json at boot' }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will add a sync button to the header' }] } }),
  ].join('\n') + '\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sessions = (): Array<{ id: string; transcript: string | null }> => [
  { id: 'missing-one', transcript: join(dir, 'gone.jsonl') },
  { id: 's1', transcript },
];

function input(over: Partial<FilingInput>): FilingInput {
  return { contextRoot: dir, surface: 'cli', parent: null, why: 'A why that is long enough to be a real reason for the task.', sleepLive: false, env: {}, sessions: sessions(), ...over };
}

describe('normalizeQuote / quoteTooThin', () => {
  it('folds Turkish case, dotted and dotless i, quotes and punctuation', () => {
    expect(normalizeQuote('«Şunu da EKLE», İTİRAZ!')).toBe('şunu da ekle itiraz');
    expect(normalizeQuote('ITIRAZ')).toBe(normalizeQuote('itiraz'));
  });
  it('needs 3 words and 12 characters', () => {
    expect(quoteTooThin('ekle şunu')).toMatch(/3 words/);
    expect(quoteTooThin('a b c')).toMatch(/12 characters/);
    expect(quoteTooThin('itiraz düğmesi olsun')).toBeNull();
  });
});

describe('findQuote', () => {
  it('finds the owner\'s typed words across Turkish case, and names the unreadable session', () => {
    const hit = findQuote(sessions(), '"görev sayfasında itiraz düğmesi"', 'owner');
    expect(hit.session).toBe('s1');
    expect(hit.missing).toEqual(['missing-one']);
  });
  it('a compaction summary, a skill loader and the assistant are not the owner', () => {
    expect(findQuote(sessions(), 'wants a dark mode toggle', 'owner').session).toBeNull();
    expect(findQuote(sessions(), 'wants a purple header bar', 'owner').session).toBeNull();
    expect(findQuote(sessions(), 'add a sync button to the header', 'owner').session).toBeNull();
  });
  it('defect evidence is searched in tool results only', () => {
    expect(findQuote(sessions(), 'ENOENT reading state/.sleep.json', 'tools').session).toBe('s1');
    expect(findQuote(sessions(), 'ENOENT reading state/.sleep.json', 'owner').session).toBeNull();
  });
});

describe('decideFiling — every create path', () => {
  it('POST with no `by` is the owner, even mid-cycle: no bar, no basis', () => {
    const d = decideFiling(input({ surface: 'api', by: null, sleepLive: true }));
    expect(d).toMatchObject({ ok: true, filedBy: 'human', basis: null, barActor: 'human' });
  });

  it('POST by sleep with no basis on a top-level task is refused', () => {
    const d = decideFiling(input({ surface: 'api', by: 'sleep', sleepLive: true }));
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe('basis_required');
      expect(d.message).toContain('--parent');
      expect(d.message).not.toContain('--by agent');
    }
  });

  it('POST by agent with no basis records an agent and a derived note', () => {
    const d = decideFiling(input({ surface: 'api', by: 'agent' }));
    expect(d).toMatchObject({ ok: true, filedBy: 'agent', barActor: 'agent', basis: { kind: 'note', verified: false } });
    if (d.ok) expect(d.basis?.session).toBeUndefined();
  });

  it('POST by plan without a parent is an agent; with a parent it is the plan', () => {
    expect(decideFiling(input({ surface: 'api', by: 'plan' }))).toMatchObject({ ok: true, filedBy: 'agent' });
    expect(decideFiling(input({ surface: 'api', by: 'plan', parent: 'p' }))).toMatchObject({ ok: true, filedBy: 'plan', barActor: 'plan' });
  });

  it('CLI with no --by outside a cycle is an agent with a note and a warning', () => {
    const d = decideFiling(input({}));
    expect(d).toMatchObject({ ok: true, filedBy: 'agent', barActor: 'unknown', basis: { kind: 'note', quote: 'A why that is long enough to be a real reason for the task.' } });
    if (d.ok) expect(d.warnings.join(' ')).toMatch(/No --basis/);
  });

  it('CLI with no --by during a live cycle IS sleep: no basis, refused', () => {
    const d = decideFiling(input({ sleepLive: true }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.message).toContain('--by human');
  });

  it('an unknown --by value does not escape the sleep rules', () => {
    const d = decideFiling(input({ by: 'bot', sleepLive: true }));
    expect(d.ok).toBe(false);
  });

  it('CLI --by agent during a live cycle is an agent (the bar lets it pass)', () => {
    expect(decideFiling(input({ by: 'agent', sleepLive: true }))).toMatchObject({ ok: true, filedBy: 'agent', barActor: 'agent' });
  });

  it('CLI --basis plan --parent during a live cycle is the plan, not sleep', () => {
    const d = decideFiling(input({ basis: 'plan', parent: 'p', quote: 'W1 (a.ts)', sleepLive: true }));
    expect(d).toMatchObject({ ok: true, filedBy: 'plan', barActor: 'plan', basis: { kind: 'plan', quote: 'W1 (a.ts)' } });
  });

  it('CLI --basis plan with no parent outside sleep is an agent', () => {
    expect(decideFiling(input({ basis: 'plan' }))).toMatchObject({ ok: true, filedBy: 'agent' });
  });

  it('sleep: a new top-level task only for ask or defect', () => {
    const change = decideFiling(input({ by: 'sleep', basis: 'change', quote: 'renamed the flag everywhere' }));
    expect(change.ok).toBe(false);
    if (!change.ok) expect(change.code).toBe('top_level_needs_ask');
    const sub = decideFiling(input({ by: 'sleep', basis: 'change', quote: 'renamed the flag', parent: 'p' }));
    expect(sub).toMatchObject({ ok: true, filedBy: 'sleep', basis: { kind: 'change', verified: false } });
  });

  it('sleep ask: the quote must be in a turn the owner typed (Turkish quote matched)', () => {
    const ok = decideFiling(input({ by: 'sleep', basis: 'ask', quote: 'görev sayfasında itiraz düğmesi olsun' }));
    expect(ok).toMatchObject({ ok: true, filedBy: 'sleep', barActor: 'sleep', basis: { kind: 'ask', session: 's1', verified: true } });
    if (ok.ok) expect(ok.warnings.join(' ')).toContain('missing-one');
    const summary = decideFiling(input({ by: 'sleep', basis: 'ask', quote: 'wants a dark mode toggle' }));
    expect(summary.ok).toBe(false);
    if (!summary.ok) expect(summary.code).toBe('quote_not_found');
    const thin = decideFiling(input({ by: 'sleep', basis: 'ask', quote: 'ekle' }));
    expect(thin.ok).toBe(false);
    if (!thin.ok) expect(thin.code).toBe('quote_too_thin');
  });

  it('sleep defect: the evidence must be in a tool result', () => {
    expect(decideFiling(input({ by: 'sleep', basis: 'defect', evidence: 'ENOENT reading state/.sleep.json at boot' })))
      .toMatchObject({ ok: true, filedBy: 'sleep', basis: { kind: 'defect', verified: true } });
    expect(decideFiling(input({ by: 'sleep', basis: 'defect', evidence: 'görev sayfasında itiraz düğmesi' })).ok).toBe(false);
  });

  it('--by human is always the owner', () => {
    expect(decideFiling(input({ by: 'human', sleepLive: true }))).toMatchObject({ ok: true, filedBy: 'human', basis: null });
  });

  it('an invalid --basis kind is refused', () => {
    expect(decideFiling(input({ basis: 'vibes' }))).toMatchObject({ ok: false, code: 'invalid_basis' });
  });

  it('filingFields writes filed_by, plus the basis when there is one', () => {
    const human = decideFiling(input({ by: 'human' }));
    if (human.ok) expect(filingFields(human)).toEqual({ filed_by: 'human' });
    const agent = decideFiling(input({ by: 'agent' }));
    if (agent.ok) expect(Object.keys(filingFields(agent))).toEqual(['filed_by', 'filing_basis']);
  });
});

describe('readFilingBasis', () => {
  it('reads a stored basis and rejects junk', () => {
    expect(readFilingBasis({ kind: 'ask', quote: 'q', at: '2026-10-23', verified: true, session: 's' }))
      .toEqual({ kind: 'ask', quote: 'q', at: '2026-10-23', verified: true, session: 's' });
    expect(readFilingBasis({ kind: 'vibes' })).toBeNull();
    expect(readFilingBasis('ask')).toBeNull();
    expect(readFilingBasis(null)).toBeNull();
  });
});
