/**
 * MIRROR of the dashboard's prompt templates in src/lib/app-prompts.ts (the dashboard bundle
 * cannot be imported from src/). Every prompt dreamcontext types into a Claude session as a user
 * turn must be recognisable there, or the owner-corrections ledger and sleep's `--basis ask`
 * read it as the owner speaking (F10, 2026-10-19).
 *
 * Each dashboard template is rendered for real (and flattened, as the server's `sanitizePrompt`
 * does): every fixed sentence in the module must occur in it (no stale mirror), and nothing of it
 * may be left once the module's sentences are stripped (no sentence the mirror is missing).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_PROMPTS, sentenceHits, stripAppPrompts } from '../../src/lib/app-prompts.js';

vi.mock('../../dashboard/src/api/client', () => ({ api: { post: vi.fn() }, getActiveVault: () => 'test-vault' }));
const { developKickoffPrompt, trainKickoffPrompt, initializerKickoffPrompt } = await import('../../dashboard/src/lib/agentPrompt');
const { DELEGATE_MODES } = await import('../../dashboard/src/lib/delegateModes');

const ROOT = join(import.meta.dirname, '..', '..');
const TASK = {
  slug: 'larkspur-refunds', name: 'Ledger refunds', description: 'Refunds post to the ledger.', why: 'Refunds vanish today.',
  user_stories: '- As an owner, I can refund', acceptance_criteria: '- [ ] A refund posts',
} as never;

/** The refused "Go to development" notice, read out of AgentSurface.tsx and rendered. */
function refusedNotice(): string {
  const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf-8');
  const start = src.indexOf('postToSession(cs, `The "Go to development" hand-off');
  expect(start, 'the refused hand-off notice is still posted from AgentSurface.tsx').toBeGreaterThan(0);
  const end = src.indexOf('`);', start);
  const literal = src.slice(start + 'postToSession(cs, `'.length, end);
  // Two template literals joined by `+`: join them, then render.
  return literal.split(/`\s*\+\s*`/).join('')
    .replace(/\\`/g, '`').replace(/\\n/g, '\n')
    .replace(/\$\{taskSlug\}/g, 'larkspur-refunds').replace(/\$\{gaps\}/g, '• why: missing\n• acceptance_criteria: none');
}

const DASHBOARD: Array<[id: string, text: string]> = [
  ['develop-kickoff', developKickoffPrompt('larkspur-refunds')],
  ['train-kickoff', trainKickoffPrompt('ledger-digest', 'Ledger digest')],
  ['initializer-kickoff', initializerKickoffPrompt()],
  ['develop-refused', refusedNotice()],
  ...DELEGATE_MODES.map((m): [string, string] => [`delegate-${m.id}`, m.build(TASK, 'Ledger refunds')]),
];

describe('the dashboard\'s prompts are mirrored in src/lib/app-prompts.ts', () => {
  it('every delegate mode has its entry', () => {
    for (const m of DELEGATE_MODES) expect(APP_PROMPTS.map((p) => p.id), m.id).toContain(`delegate-${m.id}`);
  });

  for (const [id, text] of DASHBOARD) {
    for (const [form, t] of [['as sent', text], ['flattened', text.replace(/[\n\t]+/g, ' ')]] as const) {
      it(`${id} (${form}): every mirrored sentence occurs, and nothing of it is left after the strip`, () => {
        const hits = sentenceHits(id, t);
        const sentences = APP_PROMPTS.find((p) => p.id === id)!.sentences;
        expect(sentences.filter((_, i) => !hits[i]), 'mirrored sentences the dashboard no longer sends').toEqual([]);
        const { rest, matched } = stripAppPrompts(t);
        expect(matched).toContain(id);
        expect(rest.replace(/\s+/g, ' ').trim(), 'text the mirror does not know (add it to app-prompts.ts)').toBe('');
      });
    }
  }
});
