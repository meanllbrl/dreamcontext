/**
 * Sleep files only at high confidence (C4).
 *
 * The filing bar's new gates: a NEW top-level task from sleep needs a basis
 * (the owner's ask, quoted from a real turn, or a defect with its failing
 * output); a sub-task of an existing parent needs none; everything else is a
 * proposal, which must quote its session. The brake turns direct filing off
 * past 30% rejects; three rejects of one kind block that kind; "already exists"
 * rejects tighten the neighbour threshold.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTaskFilingBar, type FilingBarEmbedder, type FilingBarInput } from '../../src/lib/task-filing-bar.js';
import { writeFeedback, type TaskFeedbackEntry, type FeedbackReason } from '../../src/lib/task-feedback.js';
import { filingBrake, writeProposals, type ProposalStore } from '../../src/lib/task-proposals.js';

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 3,
  isEmbedModelDownloaded: () => true,
  embeddingsAvailable: async () => true,
  embedPassages: async () => null,
  embedQuery: async () => null,
}));

let project = '';
let ctx = '';
let owner = { id: 'owner', path: '' };

const ASK = 'can you make the board remember my last filter';
const README_ASK = 'update the readme after the release';
const ERR = 'Error: ENOENT: no such file or directory, open state/.board-filter.json';
const WHY = 'The owner re-applies the same filter on every visit because the board forgets it between sessions.';

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-basis-'));
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  owner = { id: 'owner', path: join(project, 'owner.jsonl') };
  writeFileSync(owner.path, [
    { type: 'user', message: { role: 'user', content: `Small thing: ${ASK}?` } },
    { type: 'user', message: { role: 'user', content: `And ${README_ASK} please.` } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'we could also cache the board query later on' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `${ERR}\n    at open` }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  delete process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC;
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const sleepFile = (over: Partial<FilingBarInput> = {}) =>
  assertTaskFilingBar({
    contextRoot: ctx, actor: 'sleep', name: 'The board remembers the last filter', why: WHY,
    semantic: false, sessions: [owner], ...over,
  });

function verdicts(n: number, reason: FeedbackReason, name: string, why: string, verdict: 'keep' | 'reject' = 'reject'): TaskFeedbackEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `fb_${reason}_${i}`, at: new Date(Date.now() - i * 60_000).toISOString(), source: 'proposal' as const,
    verdict, proposal: { name: `${name} ${i}`, why }, basis: 'discussion' as const, quote: 'q', reason: verdict === 'reject' ? reason : null,
  }));
}

describe('a NEW top-level task from sleep needs a basis', () => {
  it('refuses with no basis, and names the three ways forward', async () => {
    const v = await sleepFile();
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('needs a basis');
    expect(v.reason).toContain('tasks propose');
    expect(v.reason).toContain('--parent');
  });

  it('files on the owner\'s ask, quoted from their own turn', async () => {
    const v = await sleepFile({ basis: 'ask', quote: ASK });
    expect(v.allowed).toBe(true);
    expect(v.basisSession).toBe('owner');
  });

  it('refuses a fabricated quote, and a quote of the assistant\'s words', async () => {
    expect((await sleepFile({ basis: 'ask', quote: 'please rewrite the whole board in rust' })).allowed).toBe(false);
    const assistant = await sleepFile({ basis: 'ask', quote: 'cache the board query later on' });
    expect(assistant.allowed).toBe(false);
    expect(assistant.reason).toContain('assistant text');
  });

  it('files on a defect whose failing output is in a tool result; refuses one that is not', async () => {
    expect((await sleepFile({ basis: 'defect', evidence: ERR })).allowed).toBe(true);
    expect((await sleepFile({ basis: 'defect', evidence: 'Error: the board exploded in a novel way' })).allowed).toBe(false);
    expect((await sleepFile({ basis: 'defect', evidence: 'oops' })).reason).toContain('verbatim');
  });

  it('refuses a real owner line that is about something else: an ask is a basis only for what it asks', async () => {
    const v = await sleepFile({
      name: 'Update the README after the release',
      why: 'The README still describes the previous release flags after every release, so users copy stale commands.',
      basis: 'ask',
      quote: ASK,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('shares no word');
  });

  it('a sub-task of an existing parent needs no basis (only a new top-level task waits for the owner)', async () => {
    expect((await sleepFile({ parent: 'some-parent' })).allowed).toBe(true);
  });

  it('a human is never asked for one', async () => {
    expect((await sleepFile({ actor: 'human' })).allowed).toBe(true);
  });
});

describe('the brake', () => {
  function store(filed: Array<'open' | 'kept' | 'rejected'>, decided: Array<'accepted' | 'rejected'> = []): ProposalStore {
    const at = (i: number) => new Date(Date.now() - i * 60_000).toISOString();
    return {
      filed: filed.map((outcome, i) => ({ slug: `f${i}`, name: `f${i}`, why: 'w', quote: 'q', basis: 'ask' as const, parent: null, filedAt: at(i), outcome })),
      proposals: decided.map((status, i) => ({
        id: `tp_${i}`, name: `p${i}`, why: 'w', quote: 'q', basis: 'discussion' as const, parent: null, session: null,
        proposedAt: at(100 + i), resolvedAt: at(i + 50), by: 'sleep' as const, status,
      })),
    };
  }

  it('turns direct filing off past 30% rejected, pointing to proposals', async () => {
    writeProposals(ctx, store(['rejected', 'rejected', 'open', 'kept', 'kept', 'kept']));
    const v = await sleepFile({ basis: 'ask', quote: ASK });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('Direct filing is off');
    // The open one is not a verdict yet: 2 of the 5 judged.
    expect(v.reason).toContain('2 of sleep\'s last 5');
  });

  it('a task still waiting is not a verdict: filing more cannot dilute a closed brake', () => {
    const closed = store(['rejected', 'rejected', 'kept', 'kept']);
    const now = new Date().toISOString();
    closed.filed.unshift(...Array.from({ length: 30 }, (_, i) => ({
      slug: `new${i}`, name: `new${i}`, why: 'w', quote: 'q', basis: 'ask' as const, parent: null, filedAt: now, outcome: 'open' as const,
    })));
    expect(filingBrake(closed)).toMatchObject({ window: 4, rejected: 2, open: false });
  });

  it('orders by when the owner judged, not when sleep filed', () => {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const rec = (i: number, outcome: 'kept' | 'rejected', filedAt: string, resolvedAt: string) => ({
      slug: `r${i}`, name: `r${i}`, why: 'w', quote: 'q', basis: 'ask' as const, parent: null, filedAt, resolvedAt, outcome,
    });
    // 20 newer filings kept long ago, 7 older filings rejected today.
    const s: ProposalStore = {
      proposals: [],
      filed: [
        ...Array.from({ length: 20 }, (_, i) => rec(i, 'kept', ago(1), ago(5))),
        ...Array.from({ length: 7 }, (_, i) => rec(100 + i, 'rejected', ago(10), ago(0))),
      ],
    };
    expect(filingBrake(s)).toMatchObject({ window: 20, rejected: 7, open: false });
  });

  it('stays on at exactly 30%', async () => {
    writeProposals(ctx, store(['rejected', 'rejected', 'rejected', 'kept', 'kept', 'kept', 'kept', 'kept', 'kept', 'kept']));
    expect((await sleepFile({ basis: 'ask', quote: ASK })).allowed).toBe(true);
  });

  it('accepted proposals bring it back (it recovers without new filed tasks)', async () => {
    writeProposals(ctx, store(['rejected', 'rejected'], Array(18).fill('accepted')));
    expect((await sleepFile({ basis: 'ask', quote: ASK })).allowed).toBe(true);
  });

  it('never stops a sub-task under an existing parent', async () => {
    writeProposals(ctx, store(['rejected', 'rejected']));
    expect((await sleepFile({ parent: 'p' })).allowed).toBe(true);
  });
});

describe('a proposal', () => {
  const propose = (over: Partial<FilingBarInput> = {}) => sleepFile({ mode: 'propose', ...over });

  it('must quote the session it came from', async () => {
    expect((await propose()).reason).toContain('--quote');
    expect((await propose({ quote: 'nothing like this was ever said here' })).allowed).toBe(false);
    const ok = await propose({ quote: 'cache the board query later on' });
    expect(ok.allowed).toBe(true);
    expect(ok.basisSession).toBe('owner');
  });

  it('is under the bar even for an awake caller, and the cap does not apply', async () => {
    const v = await propose({ actor: 'unknown', quote: ASK, why: 'too short' });
    expect(v.allowed).toBe(false);
    expect(v.reason).not.toContain('--by human');
  });
});

describe('three rejects of one kind', () => {
  const NAME = 'Update the README after the release';
  const KIND_WHY = 'The README still describes the previous release flags after the release.';

  it('blocks filing and proposing it, pointing a too-small kind at a criterion', async () => {
    writeFeedback(ctx, verdicts(3, 'too-small', NAME, KIND_WHY));
    for (const mode of ['file', 'propose'] as const) {
      const v = await sleepFile({ mode, name: `${NAME} 9`, why: KIND_WHY, basis: 'ask', quote: README_ASK });
      expect(v.allowed).toBe(false);
      expect(v.reason).toContain('as too small');
      expect(v.reason).toContain('acceptance_criteria');
    }
  });

  it('two rejects are not yet a kind; an unlike candidate is never blocked', async () => {
    writeFeedback(ctx, verdicts(2, 'badly-written', NAME, KIND_WHY));
    expect((await sleepFile({ name: `${NAME} 9`, why: KIND_WHY, basis: 'ask', quote: README_ASK })).allowed).toBe(true);
    writeFeedback(ctx, verdicts(3, 'badly-written', NAME, KIND_WHY));
    expect((await sleepFile({ basis: 'ask', quote: ASK })).allowed).toBe(true);
  });

  it('keeps do not count', async () => {
    writeFeedback(ctx, verdicts(3, 'not-work', NAME, KIND_WHY, 'keep'));
    expect((await sleepFile({ name: `${NAME} 9`, why: KIND_WHY, basis: 'ask', quote: README_ASK })).allowed).toBe(true);
  });
});

describe('"already exists" rejects tighten the neighbour gate', () => {
  function unit(x: number, y: number, z: number): Float32Array {
    const n = Math.hypot(x, y, z) || 1;
    return new Float32Array([x / n, y / n, z / n]);
  }
  const vecFor = (t: string): Float32Array => {
    const m = t.match(/@v\(([^)]+)\)/);
    if (!m) return unit(0, 0, 1);
    const [x, y, z] = m[1].split(',').map(Number);
    return unit(x, y, z);
  };
  const fakeEmbed: FilingBarEmbedder = async (texts) => texts.map(vecFor);
  const at = (c: number) => `@v(${c},${Math.sqrt(1 - c * c)},0)`;

  it('a 0.895 neighbour passes on a fresh project and is flagged after three such rejects', async () => {
    writeFileSync(join(ctx, 'state', 'board-filters.md'), `---\nname: Board filters\n---\n\n${at(0.895)} board filters body\n`);
    const candidate = { semantic: true, embed: fakeEmbed, why: `@v(1,0,0) ${WHY}`, basis: 'ask' as const, quote: ASK };
    expect((await sleepFile(candidate)).allowed).toBe(true);
    writeFeedback(ctx, verdicts(3, 'already-exists', 'Totally unrelated wording here', 'Nothing in common with the candidate at all.'));
    const v = await sleepFile(candidate);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('board-filters');
  });

  it('when the nearest task is a sub-task, the refusal offers its parent', async () => {
    writeFileSync(join(ctx, 'state', 'board-epic.md'), '---\nname: Board epic\n---\n\n@v(0,0,1) epic\n');
    writeFileSync(join(ctx, 'state', 'board-filters.md'), `---\nname: Board filters\nparent_task: board-epic\n---\n\n${at(0.93)} board filters body\n`);
    const v = await sleepFile({ semantic: true, embed: fakeEmbed, why: `@v(1,0,0) ${WHY}`, basis: 'ask', quote: ASK });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('--parent board-epic');
  });
});

describe('an unreadable store refuses sleep instead of reading as empty', () => {
  it('a corrupt ledger closes direct filing; a corrupt verdict store blocks filing and proposing', async () => {
    writeFileSync(join(ctx, 'state', '.task-proposals.json'), '{"proposals": [<<<<<<< HEAD');
    const v = await sleepFile({ basis: 'ask', quote: ASK });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('.task-proposals.json cannot be read');
    rmSync(join(ctx, 'state', '.task-proposals.json'));
    writeFileSync(join(ctx, 'state', '.task-feedback.json'), '{"not": "an array"}');
    for (const mode of ['file', 'propose'] as const) {
      const r = await sleepFile({ mode, basis: 'ask', quote: ASK });
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('.task-feedback.json cannot be read');
    }
  });
});
