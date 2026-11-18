/**
 * Peeking between rounds (plan Decision 6, criterion 9). Pure: the conductor reads the validated
 * thesis cards through `crossing.ts` and hands them here.
 *
 *  - Round 1 and the last round give no cards: a peek runs after round r and feeds round r+1
 *    only when r+1 is neither the first nor the last round.
 *  - Each team sees its two ring neighbours' cards, anonymous ("sol komşu", "sağ komşu").
 *  - The control team (4+ teams) gets none and is shown to none: the ring skips it.
 *  - One question per team per peek; its two-sentence answer comes back in the next turn.
 */
import type { Design } from './designer.js';
import { fenceAsData, type PeekQuestion, type ThesisCard } from './team-files.js';

/** Whether the round after `round` receives peek cards. */
export function peekFeeds(round: number, rounds: number): boolean {
  const next = round + 1;
  return next > 1 && next < rounds;
}

/** The ring of peeking teams, in design order, control team removed. */
export function ring(design: Pick<Design, 'teams' | 'controlTeam'>): string[] {
  return design.teams.map((t) => t.id).filter((id) => id !== design.controlTeam);
}

export function neighbours(design: Pick<Design, 'teams' | 'controlTeam'>, team: string): { left: string; right: string } | null {
  const r = ring(design);
  const i = r.indexOf(team);
  if (i < 0 || r.length < 2) return null;
  const left = r[(i - 1 + r.length) % r.length]!;
  const right = r[(i + 1) % r.length]!;
  return { left, right };
}

export function renderCard(side: 'left' | 'right', card: ThesisCard): string {
  const label = side === 'left' ? 'sol komşu' : 'sağ komşu';
  const body = [`Tez: ${card.thesis}`, ...card.claims.map((c, i) => `İddia ${i + 1}: ${c}`), `Durum: ${card.status}${card.stuck ? ` (takıldığı yer: ${card.stuck})` : ''}`].join('\n');
  return fenceAsData(label, body);
}

export interface PeekPlan {
  /** Per team: the block added to its next round message. */
  messages: Record<string, string[]>;
  /** Per team: who its question goes to (resolved team id). */
  routes: Record<string, { to: string; side: 'left' | 'right' }>;
  /** Per team: the teams whose cards it saw (the owner's peek screen). */
  seen: Record<string, string[]>;
}

/**
 * The cards each team gets after `round`. A team whose neighbour has no valid card gets that
 * side's "kart yok" line; a two-team ring shows the one other team once.
 */
export function planPeek(design: Pick<Design, 'teams' | 'controlTeam' | 'rounds'>, round: number, cards: Record<string, ThesisCard | null>): PeekPlan {
  const messages: Record<string, string[]> = {};
  const routes: PeekPlan['routes'] = {};
  const seen: PeekPlan['seen'] = {};
  if (!peekFeeds(round, design.rounds)) return { messages, routes, seen };
  for (const team of ring(design)) {
    const n = neighbours(design, team);
    if (!n) continue;
    const sides: ('left' | 'right')[] = n.left === n.right ? ['right'] : ['left', 'right'];
    const blocks = sides.map((side) => {
      const c = cards[side === 'left' ? n.left : n.right];
      return c ? renderCard(side, c) : `(${side === 'left' ? 'sol' : 'sağ'} komşunun geçerli kartı yok)`;
    });
    messages[team] = [
      `=== GÖZ ATMA (tur ${round} sonu) ===`,
      'Komşu ekiplerin tez kartları, isimsiz. En çok BİR soru sorabilirsin: out/question-r' + (round + 1) + '.json {"to":"left"|"right","text":"≤2 cümle"}. En çok bir fikir ödünç alabilirsin; alırsan decisions.jsonl satırında "borrowed": true yaz ve sunumda kaynağını göster.',
      ...blocks,
    ];
    routes[team] = { to: n.right, side: 'right' };
    seen[team] = sides.map((side) => (side === 'left' ? n.left : n.right));
  }
  return { messages, routes, seen };
}

/**
 * Questions from the round's files, at most one per team, routed to the asked neighbour.
 * Returns per answering team the questions it must answer next turn (anonymous).
 */
export function routeQuestions(design: Pick<Design, 'teams' | 'controlTeam'>, questions: Record<string, PeekQuestion | null>): Record<string, { from: string; text: string }[]> {
  const out: Record<string, { from: string; text: string }[]> = {};
  for (const [asker, q] of Object.entries(questions)) {
    if (!q) continue;
    const n = neighbours(design, asker);
    if (!n) continue;
    const to = q.to === 'left' ? n.left : n.right;
    (out[to] ??= []).push({ from: asker, text: q.text });
  }
  return out;
}

export function questionBlock(round: number, qs: readonly { text: string }[]): string {
  return [
    `=== KOMŞUDAN SORU ===`,
    ...qs.map((q, i) => fenceAsData(`soru ${i + 1}`, q.text)),
    `Her soruya iki cümleyi geçmeyen bir cevap yaz: out/answer-r${round}.json {"text":"…"} (birden çok soru varsa cevapları tek metinde sırayla).`,
  ].join('\n');
}

export function answerBlock(text: string): string {
  return ['=== SORUNA CEVAP ===', fenceAsData('cevap', text)].join('\n');
}
