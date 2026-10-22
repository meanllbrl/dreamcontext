/**
 * `super ask` takes AskUserQuestion's own input shape (owner 2026-10-22: the Super Agent asks
 * exactly the way any agent asks). The validator is the one gate (route and record reader), the
 * CLI builds the shape from `--json` or flags, and the old `--options "a|b"` form still works.
 * Fictional project and words (synthetic-fixtures pattern).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_ASK_LABEL, MAX_ASK_PREVIEW, askSpecFromLegacy, askSummary, cleanAskSpec, emptySuperState,
} from '../../src/lib/super/types.js';
import { sanitizeSuperState } from '../../src/lib/super/store.js';
import { buildAskBody } from '../../src/lib/super/ask-cli.js';

const input = {
  title: 'Login fix · ship or wait',
  questions: [
    {
      question: 'Ship the login fix now?', header: 'Ship', description: 'The release train leaves at five.',
      options: [{ label: 'Ship it', description: 'Goes out today' }, { label: 'Wait', description: 'Next train', preview: '<div class="dc-card">Next week</div>' }],
    },
    { question: 'Who tells the team?', multiSelect: true, options: [{ label: 'Me' }, { label: 'You' }] },
  ],
  metadata: { source: 'swipe' },
};

describe('cleanAskSpec: AskUserQuestion\'s shape, refused whole, never cut', () => {
  it('keeps every field the card draws', () => {
    expect(cleanAskSpec(input)).toEqual({ ok: true, spec: {
      title: 'Login fix · ship or wait',
      questions: [
        { question: 'Ship the login fix now?', header: 'Ship', description: 'The release train leaves at five.', options: [{ label: 'Ship it', description: 'Goes out today' }, { label: 'Wait', description: 'Next train', preview: '<div class="dc-card">Next week</div>' }] },
        { question: 'Who tells the team?', multiSelect: true, options: [{ label: 'Me' }, { label: 'You' }] },
      ],
      source: 'swipe',
    } });
  });

  it('one-line fields are cleaned (format characters out, controls to spaces); a preview stays whole', () => {
    const r = cleanAskSpec({ questions: [{ question: 'Ship​ it\nnow?', options: [{ label: ' Yes‮ ', preview: '<p>\n  two lines\n</p>' }] }] });
    expect(r).toEqual({ ok: true, spec: { questions: [{ question: 'Ship it now?', options: [{ label: 'Yes', preview: '<p>\n  two lines\n</p>' }] }] } });
  });

  it('a question with no options is answered in words; multiSelect on one option means nothing', () => {
    expect(cleanAskSpec({ questions: [{ question: 'Name the app?' }] })).toEqual({ ok: true, spec: { questions: [{ question: 'Name the app?', options: [] }] } });
    expect(cleanAskSpec({ questions: [{ question: 'Sure?', multiSelect: true, options: ['Yes'] }] })).toEqual({ ok: true, spec: { questions: [{ question: 'Sure?', options: [{ label: 'Yes' }] }] } });
  });

  it.each([
    ['not an object', 'nope'],
    ['no questions', { questions: [] }],
    ['five questions', { questions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?` })) }],
    ['an empty question', { questions: [{ question: '  ' }] }],
    ['two questions alike', { questions: [{ question: 'Q?' }, { question: 'Q?' }] }],
    ['five options', { questions: [{ question: 'Q?', options: ['a', 'b', 'c', 'd', 'e'] }] }],
    ['a label too long', { questions: [{ question: 'Q?', options: ['x'.repeat(MAX_ASK_LABEL + 1)] }] }],
    ['two labels alike', { questions: [{ question: 'Q?', options: ['a', 'a'] }] }],
    ['a header too long', { questions: [{ question: 'Q?', header: 'h'.repeat(30) }] }],
    ['a preview too large', { questions: [{ question: 'Q?', options: [{ label: 'a', preview: 'p'.repeat(MAX_ASK_PREVIEW + 1) }] }] }],
    ['previews too large together', { questions: [{ question: 'Q?', options: ['a', 'b', 'c'].map((label) => ({ label, preview: 'p'.repeat(MAX_ASK_PREVIEW) })) }] }],
    ['a title too long', { title: 't'.repeat(200), questions: [{ question: 'Q?' }] }],
  ])('refuses %s', (_why, raw) => {
    expect(cleanAskSpec(raw).ok).toBe(false);
  });

  it('a source is a plain word or nothing', () => {
    const r = cleanAskSpec({ questions: [{ question: 'Q?' }], metadata: { source: '<script>' } });
    expect(r.ok && r.spec.source).toBeFalsy();
  });
});

describe('what the notch, banners and event texts show of it', () => {
  it('the first question, and its labels as buttons only when they are one short single choice', () => {
    const spec = (cleanAskSpec(input) as { spec: ReturnType<typeof askSpecFromLegacy> }).spec;
    expect(askSummary(spec)).toEqual({ ownerText: 'Ship the login fix now? (+1)', options: [] });
    expect(askSummary(askSpecFromLegacy('Ship it now?', ['Ship it', 'Wait']))).toEqual({ ownerText: 'Ship it now?', options: ['Ship it', 'Wait'] });
    expect(askSummary({ questions: [{ question: 'Q?', options: [{ label: 'a much longer label than a button holds' }] }] }).options).toEqual([]);
  });
});

describe('the record keeps the spec, re-validated whole', () => {
  it('a valid spec survives a read; a hostile one is dropped (the card falls back to text and options)', () => {
    const base = { ...emptySuperState(), session: 'sup-1', enabled: true };
    const good = sanitizeSuperState({ ...base, queue: [{ id: 'q-ask-1', sessionId: 'sup-1', kind: 'ask', state: 'escalated', createdAt: 1, ownerText: 'Ship?', ask: input }] });
    expect(good.queue[0].ask?.questions[0].options[1].preview).toBe('<div class="dc-card">Next week</div>');
    const bad = sanitizeSuperState({ ...base, queue: [{ id: 'q-ask-1', sessionId: 'sup-1', kind: 'ask', state: 'escalated', createdAt: 1, ownerText: 'Ship?', ask: { questions: [{ question: 'Q?', options: ['x'.repeat(99)] }] } }] });
    expect(bad.queue[0].ask).toBeUndefined();
    expect(bad.queue[0].ownerText).toBe('Ship?');
    // A closed question keeps no spec: nothing draws it, and its previews would ride every write.
    const closed = sanitizeSuperState({ ...base, queue: [{ id: 'q-ask-1', sessionId: 'sup-1', kind: 'ask', state: 'done', createdAt: 1, ownerText: 'Ship?', ask: input }] });
    expect(closed.queue[0].ask).toBeUndefined();
    expect(closed.queue[0].ownerText).toBe('Ship?');
    // Never on a child's question.
    const child = sanitizeSuperState({ ...base, queue: [{ id: 'q-c', sessionId: 'c1', kind: 'question', state: 'escalated', createdAt: 1, ask: input }] });
    expect(child.queue[0].ask).toBeUndefined();
  });
});

describe('the CLI: --json, flags, and the old --options form', () => {
  it('the old form is sent exactly as before', () => {
    expect(buildAskBody('Ship it now?', { options: 'Ship it|Wait' })).toEqual({ text: 'Ship it now?', options: ['Ship it', 'Wait'] });
    expect(buildAskBody('Ship it now?', {})).toEqual({ text: 'Ship it now?' });
  });

  it('flags build one question in the shape', () => {
    expect(buildAskBody('Ship it now?', { title: 'Login fix · ship', description: 'Train at five', header: 'Ship', multi: true, option: ['Ship it::Goes out today', 'Wait'] })).toEqual({
      ask: { title: 'Login fix · ship', questions: [{ question: 'Ship it now?', header: 'Ship', description: 'Train at five', multiSelect: true, options: [{ label: 'Ship it', description: 'Goes out today' }, { label: 'Wait' }] }] },
    });
    expect(buildAskBody('Ship it now?', { title: 'T', options: 'a|b' })).toEqual({ ask: { title: 'T', questions: [{ question: 'Ship it now?', options: [{ label: 'a' }, { label: 'b' }] }] } });
  });

  it('--json inline, @file and - (stdin)', () => {
    expect(buildAskBody(undefined, { json: JSON.stringify(input) })).toEqual({ ask: input });
    const dir = mkdtempSync(join(tmpdir(), 'ask-cli-'));
    try {
      const f = join(dir, 'q.json');
      writeFileSync(f, JSON.stringify(input));
      expect(buildAskBody(undefined, { json: `@${f}` })).toEqual({ ask: input });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(buildAskBody(undefined, { json: '-' }, () => JSON.stringify(input))).toEqual({ ask: input });
  });

  it('refuses what cannot be one question', () => {
    expect(() => buildAskBody(undefined, {})).toThrow(/write the question/);
    expect(() => buildAskBody('Q?', { json: '{}' })).toThrow(/no text or other flags/);
    expect(() => buildAskBody(undefined, { json: '{oops' })).toThrow(/not valid JSON/);
    expect(() => buildAskBody('Q?', { option: ['a'], options: 'b|c' })).toThrow(/not both/);
  });
});
