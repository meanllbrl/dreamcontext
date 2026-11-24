/**
 * D3's rule on REAL prompt shapes (plan uye-gecmis-is, owner decision round 6): one labelled
 * fixture per shape found in real member and member-stage transcripts, its record fields and its
 * segment's shape (worked or not) kept, its words fictional (pattern synthetic-fixtures).
 *
 * Inventory (22 Nov 2026, a one-off script outside the repo; counts = records of that shape):
 *   this Mac, the three member transcripts (Doc, Conor, Atlas): 116 prompt records + 12 folded steers.
 *     [super events] child-event batch 39 · plain owner text 27 · [super events] request 16 ·
 *     isMeta string record 9 · card feedback 8 · [Reply to message ref= 5 · path-led (string) 3 ·
 *     [super owed] 2 · [super answer] 1 · [dreamcontext server] 1 · steers: typed 7, <agent-message> 3,
 *     [Reply to 1, [super owed] 1. Every prompt record carries promptSource/turnOrigin 'sdk',
 *     entrypoint 'sdk-cli'.
 *   Doc's extract of the company-Mac pack (owner_turns.jsonl, 1,364 turns): plain 1,106 ·
 *     [Reply to 82 · [super answer] 90 · xml-shaped 26 · path-led 14 · [dreamcontext server] Allow 8 and
 *     Not run 3 · card feedback 11 · [secret submitted 8 · The previous turn 6 · command 4 ·
 *     [About agenda line 3 · [super schedule] 2 · [dreamcontext] app restarted 1.
 *   The company-Mac pack itself (~/Downloads/dreamcontext-teshis-2026-11-21) is not readable on the
 *   build Mac (macOS privacy): its shapes come through Doc's extract only (logged on the task).
 */
import { describe, expect, it } from 'vitest';
import { deriveJobs, parseRecords } from '../../src/lib/agents/work-trace.js';
import { wrapUntrusted } from '../../src/lib/assistant/autonomy.js';
import { REQUEST_FROM, REQUEST_LAST_LINE, ALLOW_TURN_HEAD, REWRITE_TURN_HEAD } from '../../src/lib/super/inbox.js';
import { RESUME_TEXT } from '../../src/lib/super/outbox.js';
import { LIMIT_CONTINUE_TEXT } from '../../src/server/routes/agent-chat.js';
import { Tx, asStringContent } from '../helpers/work-trace-fixtures.js';

type Label = 'ask' | 'continuation' | 'none' | 'not-an-entry';
const SDK = { promptSource: 'sdk', turnOrigin: 'sdk', entrypoint: 'sdk-cli' };

interface Shape {
  name: string;
  label: Label;
  /** Adds the shape's record(s) to a transcript that already holds one finished job. */
  add: (tx: Tx) => void;
  /** Its segment worked (an assistant reply and a written file followed it). */
  worked?: boolean;
  /** The ask text the job must carry (an `ask`), or the steer text added (a typed steer). */
  askText?: string;
}

const request = (text: string) => [`[super events] batch=b7 items=1`, `- item=q-r1 event=request from=super model=opus effort=high`, wrapUntrusted('kestrel', `${REQUEST_FROM}: ${text}`), REQUEST_LAST_LINE].join('\n');

const SHAPES: Shape[] = [
  { name: 'plain owner text (sdk fields)', label: 'ask', add: (tx) => { tx.user('lumen icin yeni fiyat satirini ekle', SDK); }, askText: 'lumen icin yeni fiyat satirini ekle' },
  { name: 'voice owner text', label: 'ask', add: (tx) => { tx.user('🎙 fjord raporunu bir daha cikar', SDK); } },
  { name: 'picture-led owner text', label: 'ask', add: (tx) => { tx.user('[Picture 1: /fictional/shot.png]\nbu buton neden kirmizi', SDK); } },
  { name: '[super events] request batch', label: 'ask', add: (tx) => { tx.user(request('kestrel paywall icin guven rozetleri'), SDK); }, askText: 'kestrel paywall icin guven rozetleri' },
  { name: '[super events] child-event batch (done, gone, owner wait)', label: 'none', add: (tx) => { tx.user('[super events] batch=b8 items=2\n- item=q-r1 child=c-1 event=done status=idle\n- item=q-r1 child=c-2 event=owner wait status=idle\nBatch line.', SDK); } },
  { name: '[super events] reply batch', label: 'continuation', add: (tx) => { tx.user(`[super events] batch=b9 items=1\n- item=q-r1 event=reply from=super\n${wrapUntrusted('kestrel', `${REQUEST_FROM}, the answer to your question: mavi olan`)}`, SDK); } },
  { name: '[Reply to message ref=', label: 'ask', add: (tx) => { tx.user('[Reply to message ref=ab12cd from=super]\nquote: "rapor hazir"\n\nbenden adim adim iste', SDK); } },
  { name: '[About agenda line', label: 'ask', add: (tx) => { tx.user('[About agenda line 3: lumen export]\nbunu yarina tasi', SDK); } },
  { name: '[super answer]', label: 'continuation', add: (tx) => { tx.user('[super answer] item=q-x1\nUser answered: evet, ikinci secenek', SDK); } },
  { name: '[super owed]', label: 'continuation', add: (tx) => { tx.user('[super owed] items=1\n- item=q-x1 owed since 10:00', SDK); } },
  { name: '[super recap]', label: 'continuation', add: (tx) => { tx.user('[super recap] item=r-1 children=2', SDK); } },
  { name: '[super schedule]', label: 'ask', add: (tx) => { tx.user('[super schedule] daily fjord digest', SDK); } },
  { name: 'card feedback note', label: 'continuation', add: (tx) => { tx.user('<dreamcontext-card-feedback>\nThe chat did NOT show a card you wrote.\n</dreamcontext-card-feedback>', SDK); } },
  { name: 'path-led owner text (string content)', label: 'ask', add: (tx) => { tx.userStr('/fictional/projects/kestrel/shot.png fiyat satiri yanlis', SDK); } },
  { name: '[dreamcontext server] Allow turn', label: 'continuation', add: (tx) => { tx.user(`${ALLOW_TURN_HEAD} exactly this command: \`npm test\`.`, SDK); } },
  { name: '[dreamcontext server] Not run (rewrite)', label: 'continuation', add: (tx) => { tx.user(`${REWRITE_TURN_HEAD} stopped it.`, SDK); } },
  { name: 'The previous turn (limit continue)', label: 'continuation', add: (tx) => { tx.user(LIMIT_CONTINUE_TEXT, SDK); } },
  { name: '[dreamcontext] app restarted', label: 'continuation', add: (tx) => { tx.user(RESUME_TEXT, SDK); } },
  { name: '[secret submitted receipt', label: 'continuation', add: (tx) => { tx.user('[secret submitted · STRIPE_TEST_KEY → .env]', SDK); } },
  { name: 'MCP connected receipt', label: 'continuation', add: (tx) => { tx.user('MCP connected: posthog\nposthog was already set up', SDK); } },
  { name: 'bridge Stop hook turn', label: 'continuation', add: (tx) => { tx.user('Stop hook feedback:\n[goal]: dogrula', SDK); } },
  { name: 'command with no arguments that worked', label: 'ask', add: (tx) => { tx.user('<command-message>daily</command-message>\n<command-name>/daily</command-name>', SDK); }, askText: '/daily' },
  { name: 'skill command with arguments', label: 'ask', add: (tx) => { tx.skill('goal-skill', 'fjord export ekranini bitir'); }, askText: 'fjord export ekranini bitir' },
  { name: 'local command (/effort), stdout only', label: 'none', worked: false, add: (tx) => { tx.local('effort', 'Set effort to high'); } },
  { name: 'isMeta string record (harness note)', label: 'not-an-entry', add: (tx) => { tx.push({ type: 'user', uuid: 'meta-1', timestamp: new Date(tx.t += 1000).toISOString(), isMeta: true, entrypoint: 'sdk-cli', message: { role: 'user', content: '[Your previous response was cut]' } }); } },
  { name: 'quoted skill header with provenance (negative)', label: 'ask', add: (tx) => { tx.user('Base directory for this skill: neden iki kez cikiyor?', SDK); } },
  { name: 'Handoff first entry of a new transcript', label: 'ask', add: () => undefined },
  { name: 'note nobody answered', label: 'none', worked: false, add: (tx) => { tx.user('bunu sonra konusuruz', SDK); } },
  { name: 'typed folded steer', label: 'continuation', add: (tx) => { tx.steer('daha kisa yaz'); }, askText: 'daha kisa yaz' },
  { name: 'folded steer [Reply to', label: 'continuation', add: (tx) => { tx.steer('[Reply to message ref=ab12 from=super]\nevet'); }, askText: '[Reply to message ref=ab12 from=super] evet' },
  { name: 'folded steer [super owed] (machine)', label: 'continuation', add: (tx) => { tx.steer('[super owed] items=1\n- item=q-x1'); } },
  { name: 'folded steer <agent-message> (machine, hostsOwnTurn)', label: 'continuation', add: (tx) => { tx.steer('<agent-message from="a1b2c3">child finished</agent-message>'); } },
  { name: 'folded task notification', label: 'not-an-entry', add: (tx) => { tx.steer('<task-notification><task-id>t1</task-id></task-notification>'); } },
];

/** What the rule did with the shape: read off the traces, not the classifier. */
function observe(s: Shape): { cls: Label; asks: string[][] } {
  const tx = new Tx().user('earlier job: kestrel kupon alani', SDK).say('Kupon alani eklendi.');
  const before = tx.recs.length;
  s.add(tx);
  const added = tx.recs.length > before;
  if (s.worked !== false) tx.write('/p/shape-work.ts').say('Shape work done.');
  const { traces } = deriveJobs(parseRecords(tx.jsonl()), { transcriptId: 'corpus', project: { key: 'k', name: 'kestrel', root: '/k' } });
  const asks = traces.map((t) => t.asks.map((a) => a.text));
  if (!added) return { cls: 'not-an-entry', asks };
  if (traces.length === 2) return { cls: 'ask', asks };
  const job = traces[0]!;
  if (job.files.includes('/p/shape-work.ts')) {
    // A shape that is no prompt entry leaves its work in the open job as a continuation would; it
    // is told apart by the record count of prompt entries the reader sees.
    return { cls: 'continuation', asks };
  }
  return { cls: 'none', asks };
}

describe('every real prompt shape is classified as labelled (D3)', () => {
  for (const s of SHAPES) {
    if (s.name.startsWith('Handoff first')) continue;
    it(`${s.name} → ${s.label}`, () => {
      const got = observe(s);
      if (s.label === 'not-an-entry') {
        // Not a prompt entry: the work after it stays the earlier job's, and no ask is added.
        expect(got.asks).toEqual([['earlier job: kestrel kupon alani']]);
        return;
      }
      expect(got.cls).toBe(s.label);
      if (s.label === 'ask' && s.askText) expect(got.asks[1]![0]).toBe(s.askText);
      if (s.label === 'continuation') {
        const added = got.asks[0]!.slice(1);
        expect(added).toEqual(s.askText ? [s.askText] : []);
      }
    });
  }

  it('Handoff first entry of a new transcript → ask', () => {
    const tx = new Tx().user('Handoff: continue task kestrel-export. Read the task file first.', SDK).say('Okudum.').write('/p/x.ts');
    expect(deriveJobs(parseRecords(tx.jsonl()), { transcriptId: 'new', project: { key: 'k', name: 'kestrel', root: '/k' } }).traces).toHaveLength(1);
  });

  it('the same shapes in Antigravity\'s string content keep their labels', () => {
    for (const s of SHAPES.filter((x) => x.label === 'ask' && !x.name.includes('skill') && !x.name.includes('Handoff'))) {
      const tx = new Tx().user('earlier job: kestrel kupon alani', SDK).say('Kupon alani eklendi.');
      s.add(tx);
      tx.say('Shape work done.');
      expect(deriveJobs(parseRecords(asStringContent(tx)), { transcriptId: 'ag', project: { key: 'k', name: 'kestrel', root: '/k' } }).traces, s.name).toHaveLength(2);
    }
  });
});
