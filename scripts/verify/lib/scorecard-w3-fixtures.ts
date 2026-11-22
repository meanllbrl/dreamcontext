/**
 * W3 fixtures for scripts/verify/member-scorecard.mjs (criterion 26 of plan uye-karnesi). Run with the
 * scratch HOME in the env: `npx vite-node scripts/verify/lib/scorecard-w3-fixtures.ts <project> <member> <routine>`.
 * Writes, through the real modules, into the scratch project only:
 *   - one run of the routine that ended 4 days ago (past the 72 h window, unrated: "Not rated");
 *   - one fresh run, rated 4 from Telegram with a Turkish note and an active lesson;
 *   - one fresh run, the Super's judged 2 from his words, with a correction under it;
 *   - one Super job of the member, rated 3 from his words (its snapshot only).
 * Prints the run keys as JSON. Fictional names only.
 */
import { appendThreadEntry } from '../../../src/lib/automations/threads.js';
import { withScorecard, runKeyFor, newId } from '../../../src/lib/agents/scorecard.js';
import { commitLesson, rateRun } from '../../../src/lib/agents/scorecard-ops.js';
import { contextRootOf } from '../../../src/lib/agents/slot.js';
import { foldNote } from '../../../src/lib/agents/scorecard.js';

const [project, member, routine] = process.argv.slice(2);
if (!project || !member || !routine) throw new Error('usage: <project> <member> <routine>');
const root = contextRootOf(project);
const home = process.env.HOME!;

function runAt(when: Date, text: string, slug = routine, via: 'runner' | 'super' = 'runner'): string {
  const runId = when.toISOString();
  const at = (s: number) => new Date(when.getTime() + s * 1000);
  appendThreadEntry(root, slug, { runId, kind: 'user', text: via === 'super' ? 'Bu haftanın bütçe planını çıkart.' : 'Front desk news round.', via: via === 'super' ? 'super' : 'runner', now: at(0) });
  appendThreadEntry(root, slug, { runId, kind: 'system', event: 'started', text: '', via: 'runner', now: at(1) });
  appendThreadEntry(root, slug, { runId, kind: 'agent', text, via: 'cli', now: at(30) });
  appendThreadEntry(root, slug, { runId, kind: 'system', event: 'ok', text: 'ok', via: 'runner', now: at(31) });
  return `${slug}::${runId}`;
}

const now = Date.now();
const old = runAt(new Date(now - 4 * 86_400_000), 'Desk is tidy: two parcels filed.');
const tg = runAt(new Date(now - 2 * 3_600_000), 'Desk is tidy: five parcels filed, one return logged.');
const judged = runAt(new Date(now - 90 * 60_000), 'Raised the parcel budget to 300 $ for the new courier.');
const NOTE = 'Kargo notunu kısa tut';
const r = rateRun(project, member, { run: tg, stars: 4, note: NOTE, by: 'owner', via: 'telegram', home });
withScorecard(project, member, (card, scope) => {
  const k = runKeyFor(scope, tg);
  commitLesson(card, k, 'Keep the parcel note short.', card.ratings[k].noteFold!, new Date());
  delete card.ratings[k].draft;
  const jk = runKeyFor(scope, judged);
  const at = new Date().toISOString();
  card.ratings[jk] = {
    stars: 2, firstAt: at, at, by: 'super', judged: true, via: 'super',
    quote: 'Hayır, bütçeyi bana sormadan artırmamalıydı.', title: 'Front desk news', runAt: judged.split('::')[1], status: 'ok', project: r.rating!.project,
    note: 'bütçeyi bana sormadan artırmamalıydı', noteFold: foldNote('bütçeyi bana sormadan artırmamalıydı'),
    corrections: [{ id: newId('co'), note: 'kuryeyi de bana sormalıydı', noteFold: foldNote('kuryeyi de bana sormalıydı'), quoteTurn: 'fixture-turn-2', at }],
  } as never;
  const superRun = new Date(now - 30 * 60_000).toISOString();
  const sk = runKeyFor(scope, `${member}::${superRun}`);
  card.ratings[sk] = {
    stars: 3, firstAt: at, at, by: 'super', via: 'super', viaSuper: true,
    quote: 'Üç, yeni kitleye fazla para ayırmış.', title: 'Bu haftanın bütçe planını çıkart.', runAt: superRun, status: 'ok', project: r.rating!.project,
    note: 'yeni kitleye fazla para ayırmış', noteFold: foldNote('yeni kitleye fazla para ayırmış'),
  } as never;
}, { home });
console.log(JSON.stringify({ old, tg, judged, note: NOTE }));
