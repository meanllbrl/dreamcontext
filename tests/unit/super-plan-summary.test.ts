/**
 * "Plan hazır, başlasın mı?" without the plan (owner 2026-10-29): the Super asked him to start a
 * plan and the card said only that it was ready, so he had to answer "Bana planı özetle". Three
 * places carry the rule: the briefing, the event note of a finished plan the owner waits on, and
 * a warning on the `super ask` answer when a start question has no summary on its card.
 */
import { describe, it, expect } from 'vitest';
import { SUPER_BRIEF_TEXT, superBriefing } from '../../src/server/chat-modes.js';
import { AWAITED_LINE, PLAN_DONE_LINE, superBatchText } from '../../src/lib/super/inbox.js';
import { START_ASK_WARNING, startAskWarning } from '../../src/lib/super/ask-summary.js';
import { SUPER_BRIEF_REV, emptySuperState, type SuperAskSpec, type SuperState } from '../../src/lib/super/types.js';

const SUMMARY = `<div class="dc-doc"><p class="dc-p">Teachers cannot block weekly hours.</p><ul class="dc-list">
<li>Blocked hours show hatched on the calendar</li><li>A lesson put there warns, never blocks</li>
<li>Existing lessons stay</li></ul><p class="dc-p">Your call: the warning text. No new cost.</p></div>`;

const ask = (question: string, opts: { title?: string; description?: string; preview?: string } = {}): SuperAskSpec => ({
  ...(opts.title ? { title: opts.title } : {}),
  questions: [{
    question,
    ...(opts.description ? { description: opts.description } : {}),
    options: [{ label: 'Yes, start', ...(opts.preview ? { preview: opts.preview } : {}) }, { label: 'Wait' }],
  }],
});

describe('startAskWarning', () => {
  it('warns on a start question in Turkish or English that carries no summary', () => {
    // The Tilki card of 2026-10-29, cut: a prose description, no preview; he answered "Bana özetle".
    const tilki = ask('Çınar için haftalık kapalı saat planı hazır. Kodu yazmaya başlansın mı?', {
      title: 'Çınar kapalı saat → geliştirme',
      description: 'Kapalı saat taralı görünecek, o saate ders eklenince uyarı çıkacak ama engellemeyecek. Mevcut dersler silinmeyecek. Sunucuda değişiklik yok, canlıya çıkmadan önce sana sorulacak.',
    });
    expect(startAskWarning(tilki)).toBe(START_ASK_WARNING);
    for (const q of ['The plan is ready. Shall development start?', 'Do you approve this design?', 'Onaylıyor musun?', 'Geliştirmeye başlayalım mı?', 'Proceed with the migration?']) {
      expect(startAskWarning(ask(q)), q).toBe(START_ASK_WARNING);
    }
    // The title alone can carry it ("İki plan hazır → geliştirme başlasın mı").
    expect(startAskWarning(ask('Doğa Sanat: iki düzeltme birlikte yazılsın mı?', { title: 'İki plan hazır → geliştirme başlasın mı' }))).toBe(START_ASK_WARNING);
  });

  it('a preview holding a real summary silences it; an empty or token preview does not', () => {
    expect(startAskWarning(ask('The plan is ready. Shall it start?', { preview: SUMMARY }))).toBeNull();
    expect(startAskWarning(ask('The plan is ready. Shall it start?', { preview: '<p class="dc-p">The plan.</p>' }))).toBe(START_ASK_WARNING);
    // Markup alone is not a summary.
    expect(startAskWarning(ask('Start?', { preview: `<div class="dc-doc">${'<span></span>'.repeat(40)}</div>` }))).toBe(START_ASK_WARNING);
  });

  it('stays quiet on a question that starts nothing', () => {
    for (const q of ['Which way should institutions send messages?', 'Hangi yoldan gidelim?', 'Canlıya çıkarılsın mı?', 'Push the branch to GitHub?', 'Which mockup do you like?']) {
      expect(startAskWarning(ask(q)), q).toBeNull();
    }
  });
});

describe('the rule rides where the Super reads it', () => {
  it(`the briefing (rev ${SUPER_BRIEF_REV}) puts the summary on the card and in the text, the exception to 2-4`, () => {
    expect(SUPER_BRIEF_REV).toBeGreaterThanOrEqual(17);
    for (const t of [superBriefing(), SUPER_BRIEF_TEXT]) {
      expect(t).toContain('Asking him to approve or start a plan\nor any work: the card carries what he says yes to');
      expect(t).toContain("the yes option's `preview`");
      expect(t).toContain('3-6 short bullets of what will be done');
      expect(t).toContain('(the exception to 2-4)');
    }
  });

  const state = (mode?: string): SuperState => {
    const s = emptySuperState();
    s.children.p = { sessionId: 'p', brief: 'plan the blocked hours', adopted: false, startedAt: 1, awaited: true, ...(mode ? { mode } : {}) } as SuperState['children'][string];
    return s;
  };
  const done = [{ id: 'q-1', sessionId: 'p', kind: 'done' as const, state: 'pending' as const, createdAt: 1 }];

  it('a finished plan the owner waits on brings the summary line with the awaited line', () => {
    const text = superBatchText('/tmp/acme/_dream_context', state('plan'), done, 'b-1');
    expect(text).toContain(AWAITED_LINE);
    expect(text).toContain(PLAN_DONE_LINE);
    expect(text.split(PLAN_DONE_LINE).length).toBe(2);
  });

  it('a develop job, a plan nobody waits on, and a stuck plan do not', () => {
    expect(superBatchText('/tmp/acme/_dream_context', state('develop'), done, 'b-1')).not.toContain(PLAN_DONE_LINE);
    const quiet = state('plan');
    delete quiet.children.p.awaited;
    expect(superBatchText('/tmp/acme/_dream_context', quiet, done, 'b-1')).not.toContain(PLAN_DONE_LINE);
    expect(superBatchText('/tmp/acme/_dream_context', state('plan'), [{ ...done[0], kind: 'stuck' as const }], 'b-1')).not.toContain(PLAN_DONE_LINE);
  });
});
