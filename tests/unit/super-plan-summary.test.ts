/**
 * "Plan hazır, başlasın mı?" without the plan (owner 2026-10-29): the Super asked him to start a
 * plan and the card said only that it was ready, so he had to answer "Bana planı özetle". Then
 * (owner 2026-10-30) the summary it packed into the yes option's preview could not be read: a
 * report card on the stage carries it, and the question asks the decision in one line. Three
 * places carry the rule: the briefing, the event note of a finished plan the owner waits on, and
 * a warning on the `super ask` answer when a start question shows no report card, or a preview
 * is a text to read.
 */
import { describe, it, expect } from 'vitest';
import { SUPER_BRIEF_TEXT, superBriefing } from '../../src/server/chat-modes.js';
import { AWAITED_LINE, PLAN_DONE_LINE, superBatchText } from '../../src/lib/super/inbox.js';
import { LONG_PREVIEW_WARNING, MAX_PREVIEW_TEXT, START_ASK_WARNING, askWarning } from '../../src/lib/super/ask-summary.js';
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

describe('askWarning', () => {
  it('warns on a start question in Turkish or English that shows no report card', () => {
    // The Tilki card of 2026-10-29, cut: a prose description, no preview; he answered "Bana özetle".
    const tilki = ask('Çınar için haftalık kapalı saat planı hazır. Kodu yazmaya başlansın mı?', {
      title: 'Çınar kapalı saat → geliştirme',
      description: 'Kapalı saat taralı görünecek, o saate ders eklenince uyarı çıkacak ama engellemeyecek. Mevcut dersler silinmeyecek. Sunucuda değişiklik yok, canlıya çıkmadan önce sana sorulacak.',
    });
    expect(askWarning(tilki, 0)).toBe(START_ASK_WARNING);
    for (const q of ['The plan is ready. Shall development start?', 'Do you approve this design?', 'Onaylıyor musun?', 'Geliştirmeye başlayalım mı?', 'Proceed with the migration?']) {
      expect(askWarning(ask(q), 0), q).toBe(START_ASK_WARNING);
    }
    // The title alone can carry it ("İki plan hazır → geliştirme başlasın mı").
    expect(askWarning(ask('Doğa Sanat: iki düzeltme birlikte yazılsın mı?', { title: 'İki plan hazır → geliştirme başlasın mı' }), 0)).toBe(START_ASK_WARNING);
  });

  it('a shown report card is the summary; a preview no longer is (owner 2026-10-30)', () => {
    expect(askWarning(ask('The plan is ready. Shall it start?'), 1)).toBeNull();
    expect(askWarning(ask('The plan is ready. Shall it start?', { preview: SUMMARY }), 0)).toBe(START_ASK_WARNING);
  });

  it('a preview that is a text to read is pointed at a report card, on any question', () => {
    // The Tilki card of 2026-10-30: seven work items in the yes option's preview, cut off.
    const seven = `<div class="dc-doc"><h3 class="dc-h3">Bugün yapılacak 7 iş</h3><ul class="dc-list">${
      ['Hesabı kapatma ve bildirimleri durdurma', 'Boş program ve 9 hayalet ders silinir', 'Yeni konular aramada görünsün',
        'Kurum öğrencisine Başka pakete geç menüsü', 'Gelir verisi yeniden akmaya başlar', 'Paket eklerken eski dersleri sayıp saymamayı sor',
        'Faturadan önce ek indirim'].map((x) => `<li>${x}</li>`).join('')}</ul></div>`;
    expect(askWarning(ask('Which items stay in this sprint?', { preview: seven }), 0)).toBe(LONG_PREVIEW_WARNING);
    expect(askWarning(ask('Bugün 7 işi başlatayım mı?', { preview: seven }), 1)).toBe(LONG_PREVIEW_WARNING);
    // A mockup's labels are a look at an option, not a text: quiet.
    expect(askWarning(ask('Which mockup do you like?', { preview: '<div class="dc-card"><b>Header</b> · Hero · Button</div>' }), 0)).toBeNull();
    expect(LONG_PREVIEW_WARNING).toContain('super open web');
    expect(START_ASK_WARNING).toContain('--show <its card>');
    expect(MAX_PREVIEW_TEXT).toBeGreaterThan(150);
  });

  it('stays quiet on a question that starts nothing and carries no long preview', () => {
    for (const q of ['Which way should institutions send messages?', 'Hangi yoldan gidelim?', 'Canlıya çıkarılsın mı?', 'Push the branch to GitHub?', 'Which mockup do you like?']) {
      expect(askWarning(ask(q), 0), q).toBeNull();
    }
  });
});

describe('the rule rides where the Super reads it', () => {
  it(`the briefing (rev ${SUPER_BRIEF_REV}) puts the information on a report card, the decision in the question, the summary in the text`, () => {
    expect(SUPER_BRIEF_REV).toBeGreaterThanOrEqual(19);
    for (const t of [superBriefing(), SUPER_BRIEF_TEXT]) {
      expect(t).toContain('Information he must READ never rides\nin a question: it is a report card on his stage.');
      expect(t).toContain('`super open web <that path> --title "<name>"`, and ask with `--show <its card>`');
      expect(t).toContain('the question is the decision in one short line');
      expect(t).toContain('the report stays after his answer');
      expect(t).toContain('3-6 short bullets of what will be done');
      expect(t).toContain('(the exception to 2-4)');
      expect(t).toContain('A `preview` is only a look at an option');
      expect(t).toContain('A report on a plan or on options is DRAWN, never written: screen\nmockups, options side by side, short headings');
      // 2026-11-03 (rev 29): the mockup is the product's real look, a sequence is a graph.
      expect(t).toContain("A product mockup wears that\nproduct's real colors and frame, not the kit; steps in order are a `dc-graph`, never chips.");
      expect(t).not.toContain("the yes option's `preview`");
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
    expect(PLAN_DONE_LINE).toContain('Put that summary on a report card first');
    expect(PLAN_DONE_LINE).toContain('`--show <its card>`');
  });

  it('a develop job, a plan nobody waits on, and a stuck plan do not', () => {
    expect(superBatchText('/tmp/acme/_dream_context', state('develop'), done, 'b-1')).not.toContain(PLAN_DONE_LINE);
    const quiet = state('plan');
    delete quiet.children.p.awaited;
    expect(superBatchText('/tmp/acme/_dream_context', quiet, done, 'b-1')).not.toContain(PLAN_DONE_LINE);
    expect(superBatchText('/tmp/acme/_dream_context', state('plan'), [{ ...done[0], kind: 'stuck' as const }], 'b-1')).not.toContain(PLAN_DONE_LINE);
  });
});
