#!/usr/bin/env node
/**
 * A stand-in `claude` for the quick edit's browser check (scripts/verify/whiteboard-quick-edit.mjs):
 * reads the `-p` user message the server builds (the owner's words + the fenced board data) and
 * answers ONE quick edit the way `claude -p --output-format json --json-schema` does, with
 * `structured_output`. Deterministic, no network. Words it knows:
 *   "buraya … çiz|ekle" → add a small drawing (an apple) at the region (or right of the board)
 *   "yeşil" / "sarı" / "kırmızı" → fill every scope shape that colour
 *   "adını X yap" → rename the first scope shape
 *   "büyüt"     → scale 1.25
 *   "Seçenek D" with nothing selected → name a shape outside the scope (out of scope)
 *   "kaç görev" → not a board change
 *   "yavaş"     → wait 20 s first (for Durdur)
 */
const args = process.argv.slice(2);
const msg = args[args.indexOf('-p') + 1] ?? '';
const typed = /^Request from the owner: (.*)$/m.exec(msg)?.[1] ?? '';
const request = typed.toLocaleLowerCase('tr');
const fence = /<board-data-[0-9a-f]+>\n([\s\S]*?)\n<\/board-data-/.exec(msg);
const data = fence ? JSON.parse(fence[1]) : { scope: [], near: [], board: null };

const answer = (a) => {
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 50,
    result: JSON.stringify(a), structured_output: a, total_cost_usd: 0.002,
  }));
  process.exit(0);
};

if (request.includes('yavaş')) await new Promise((r) => setTimeout(r, 20_000));

if (request.includes('kaç görev')) answer({ reply: 'Bu bir tahta değişikliği değil, tahtada bir şey değişmedi.', notBoard: true });

if (request.includes('seçenek d') && data.scope.length === 0) {
  const d = data.near.find((n) => /Seçenek D/.test(n.text ?? ''));
  answer({ reply: 'Önce Seçenek D şeklini seç.', notBoard: false, update: [{ id: d?.id ?? 'x', fill: 'green' }] });
}

if (/buraya .*(çiz|ekle)/.test(request)) {
  const a = data.area;
  const at = a ? [a.x, a.y] : [data.board ? data.board.x + data.board.w + 80 : 0, data.board ? data.board.y : 0];
  answer({
    reply: request.includes('elma') ? 'Elma eklendi.' : 'Çizildi.', notBoard: false,
    add: [{ at, spec: { elements: [
      { type: 'ellipse', x: 10, y: 40, width: 160, height: 140, backgroundColor: '#ff6b6b', strokeColor: '#c92a2a', fillStyle: 'solid' },
      { type: 'line', x: 90, y: 10, points: [[0, 30], [8, 0]], strokeColor: '#8d5524', strokeWidth: 4 },
      { type: 'ellipse', x: 100, y: 5, width: 50, height: 26, backgroundColor: '#51cf66', strokeColor: '#2b8a3e', fillStyle: 'solid' },
    ] } }],
  });
}

// The new name as the owner typed it (lowercasing and re-capitalising breaks on ç: "SeçEnek").
const rename = /adını (.+?) yap/i.exec(typed);
if (rename && data.scope.length) {
  // A kit card is a rectangle and its free label in one group: the label is the text to change.
  const target = data.scope.find((s) => s.type === 'text') ?? data.scope[0];
  const name = rename[1];
  answer({ reply: `Adı ${name} oldu.`, notBoard: false, update: [{ id: target.id, text: name }] });
}

const colour = Object.entries({ yeşil: 'green', sarı: 'yellow', kırmızı: 'red' }).find(([w]) => request.includes(w));
if (colour && data.scope.length) {
  answer({ reply: 'Renk değişti.', notBoard: false, update: data.scope.filter((s) => s.type !== 'text').map((s) => ({ id: s.id, fill: colour[1] })) });
}

if (request.includes('büyüt') && data.scope.length) answer({ reply: 'Büyütüldü.', notBoard: false, scale: 1.25 });

answer({ reply: 'Anlaşılamadı.', notBoard: true });
