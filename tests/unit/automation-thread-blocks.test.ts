/**
 * An agent's thread speaks the Chat's blocks (owner, 2026-09-30).
 *
 * The incident: a recipe-corpus run needed the owner to run two `--apply` commands and to say
 * yes first. It `propose`d under `review: off`, was refused, and fell back to prose: the
 * commands as a bullet list and "run these in your terminal", with nothing to press. Three
 * halves, each locked here:
 *
 *  - every brief that posts (run, ask, thread reply) names the run card, and its example
 *    parses through the dashboard's REAL view parser, so the brief cannot teach a shape the
 *    thread would drop;
 *  - the ask clause follows `review`, so no brief names a verb the CLI will refuse;
 *  - a card's report fits the thread's reply cap, since a refused report is a command that ran
 *    and never said so. The cap is a mirror, drift-locked to its owner.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { askClause, buildAskBlock, buildPreamble, THREAD_BLOCKS } from '../../src/lib/automations/runner.js';
import { buildThreadMessagePreamble } from '../../src/lib/automations/verdict.js';
import { reviewMismatch } from '../../src/lib/automations/store.js';
import { THREAD_TEXT_MAX_CHARS, type AutomationManifest } from '../../src/lib/automations/types.js';
import { parseViewBlock } from '../../dashboard/src/lib/chatViewSpec';
import { parseChatActions } from '../../dashboard/src/components/sleepy/chat/chatActions';
import { buildRunReport, fitRunReport } from '../../dashboard/src/components/sleepy/chat/runReport';

const ROOT = join(import.meta.dirname, '..', '..');

function manifest(review: 'off' | 'agent' | 'output'): AutomationManifest {
  return { slug: 'recipe-weekly', title: 'Recipe weekly', mode: 'call', schedule: null, review } as unknown as AutomationManifest;
}

describe('every brief that posts names the Chat\'s blocks', () => {
  it('the run, ask and thread-reply briefs all carry the run card clause', () => {
    for (const brief of [
      buildPreamble(manifest('off'), '/tmp/p', new Date(), '/tmp/out.md'),
      buildAskBlock('uygula', manifest('off')),
      buildThreadMessagePreamble('onay veriyorum', manifest('off')),
    ]) {
      expect(brief).toContain(THREAD_BLOCKS.trim());
    }
  });

  it('the run card example in the brief parses through the dashboard\'s own view parser', () => {
    const json = /\{"type":"run"[^}]*\}/.exec(THREAD_BLOCKS)?.[0];
    expect(json).toBeTruthy();
    const { view } = parseViewBlock(json as string);
    expect(view?.type).toBe('run');
    const secret = /\{"type":"secret".*?\]\}/.exec(THREAD_BLOCKS)?.[0];
    expect(parseViewBlock(secret as string).view?.type).toBe('secret');
  });

  it('a post written the way the brief says renders as a run card segment, in written order', () => {
    const post = [
      'Onaylandı. İki adım:',
      '```dream-view',
      '{"type":"run","id":"apply","command":"cd /tmp/w && npm run corpus:weekly -- --apply","why":"prod yazar, onayını çalıştırarak verirsin"}',
      '```',
      'Bitince sonucu buraya yazarım.',
    ].join('\n');
    const kinds = parseChatActions(post).segments.map((s) => (s.kind === 'view' ? `view:${s.view.type}` : s.kind));
    expect(kinds).toEqual(['prose', 'view:run', 'prose']);
  });
});

describe('the ask clause follows review, so no brief names a verb the CLI refuses', () => {
  it('review off: tells the run not to propose, and offers no --choice', () => {
    const c = askClause(manifest('off'));
    expect(c).toContain('review is off');
    expect(c).not.toContain('--choice');
    const preamble = buildPreamble(manifest('off'), '/tmp/p', new Date(), '/tmp/out.md');
    expect(preamble).not.toContain('automations propose recipe-weekly');
  });

  it('review agent: the run and the thread reply both get the propose verb with their slug', () => {
    expect(buildPreamble(manifest('agent'), '/tmp/p', new Date(), '/tmp/out.md')).toContain('automations propose recipe-weekly');
    expect(buildThreadMessagePreamble('evet', manifest('agent'))).toContain('automations propose recipe-weekly');
  });

  it('a prompt that proposes under review off is flagged, and only then', () => {
    expect(reviewMismatch({ review: 'off', prompt: 'Uygulamayı Mehmet\'e sor (propose hariç).' })).toMatch(/review: agent/);
    expect(reviewMismatch({ review: 'agent', prompt: 'propose it' })).toBeNull();
    expect(reviewMismatch({ review: 'off', prompt: 'A proposal-free job.' })).toBeNull();
  });
});

describe('a card\'s report fits the thread reply cap', () => {
  it('the dashboard cap mirrors the server\'s', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/agents/AgentMessage.tsx'), 'utf-8');
    const m = /export const THREAD_REPLY_MAX_CHARS = (\d+);/.exec(src);
    expect(Number(m?.[1])).toBe(THREAD_TEXT_MAX_CHARS);
  });

  it('a long output keeps the command, the exit code and the NEWEST lines', () => {
    const tail = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(120)}`).join('\n');
    const report = buildRunReport('npm run corpus:weekly -- --apply', { code: 1, tail, seconds: 12 }, { includeOutput: true });
    expect(report.length).toBeGreaterThan(THREAD_TEXT_MAX_CHARS);
    const fit = fitRunReport(report, THREAD_TEXT_MAX_CHARS);
    expect(fit.length).toBeLessThanOrEqual(THREAD_TEXT_MAX_CHARS);
    expect(fit).toContain('$ npm run corpus:weekly -- --apply');
    expect(fit).toContain('exit 1');
    expect(fit).toContain('line 39');
    expect(fit).not.toContain('line 0 ');
    expect(fit.endsWith('```')).toBe(true);
  });

  it('a report that already fits is returned unchanged', () => {
    const report = buildRunReport('true', { code: 0, tail: 'ok', seconds: 1 }, { includeOutput: true });
    expect(fitRunReport(report, THREAD_TEXT_MAX_CHARS)).toBe(report);
  });
});
