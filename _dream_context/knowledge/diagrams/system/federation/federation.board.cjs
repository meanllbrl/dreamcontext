// dreamcontext "cross-vault federation" source-of-truth board.
// Two halves: PUSH (sleep-driven, automatic) and PULL (recall --connected, on-demand).
// Mirrors src/lib/federation-digest.ts (computeDigest), federation-ingest.ts (drain),
// federation-recall.ts (crossVaultRecall) and the consent + watermark gates.
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector, annotate, bullets,
  topOf, bottomOf, leftOf, rightOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'federation.excalidraw.md');
const els = [];

els.push(...sectionTitle({ x: 60, y: 8, text: 'dreamcontext — how two vaults federate', fontSize: 38 }));

// Shared registry strip (top, full width context)
const REG = { x: 60, y: 70, w: 1180, h: 60 };
els.push(...card({ ...REG, color: 'gray', fontSize: 17, text: 'vault registry (~/.dreamcontext) — every _dream_context/ project addressable by name · the one shared index' }));

// ───────────────────────── PUSH band (sleep-driven, automatic) ─────────────────────────
els.push(...sectionTitle({ x: 60, y: 168, text: 'PUSH — sleep-driven, automatic', fontSize: 24, color: '#1971c2' }));

const A_SLEEP  = { x: 60,  y: 220, w: 220, h: 96 };
const DIGEST   = { x: 340, y: 210, w: 300, h: 116 };
const CONSENT  = { x: 700, y: 220, w: 230, h: 96 };
const B_INBOX  = { x: 990, y: 220, w: 250, h: 96 };

els.push(...card({ ...A_SLEEP, color: 'purple', fontSize: 17, text: 'Vault A — sleep cycle\nsleep-federation\nspecialist' }));
els.push(...card({ ...DIGEST,  color: 'yellow', fontSize: 16, text: 'computeDigest\nFULL corpus − federated\n− already-synced (watermark)' }));
els.push(...card({ ...CONSENT, color: 'red',    fontSize: 16, text: 'consent gate\nreceiver must declare\nin/both + shareable' }));
els.push(...card({ ...B_INBOX, color: 'gray',   fontSize: 16, text: 'Vault B\n.federation-inbox\n(digest entries)' }));

els.push(...connector({ from: rightOf(A_SLEEP.x, A_SLEEP.y, A_SLEEP.w, A_SLEEP.h), to: leftOf(DIGEST.x, DIGEST.y, DIGEST.w, DIGEST.h), label: 'since last sync' }));
els.push(...connector({ from: rightOf(DIGEST.x, DIGEST.y, DIGEST.w, DIGEST.h), to: leftOf(CONSENT.x, CONSENT.y, CONSENT.w, CONSENT.h), label: 'BM25-ranked to\npeer interest' }));
els.push(...connector({ from: rightOf(CONSENT.x, CONSENT.y, CONSENT.w, CONSENT.h), to: leftOf(B_INBOX.x, B_INBOX.y, B_INBOX.w, B_INBOX.h), label: 'if consent' }));

// annotation: source is the full corpus (the key correction) — placed in the empty
// band above the consent card so it never collides with the PUSH section title.
els.push(...annotate({
  from: [DIGEST.x + DIGEST.w, DIGEST.y + 12],
  to:   [DIGEST.x + DIGEST.w + 70, 150],
  text: 'source = FULL corpus (knowledge+feature+task+changelog+memory)\nNOT knowledge-only · only a title+summary digest crosses',
}));

// drain row (under the inbox, flowing right→left back into B's knowledge)
const B_DRAIN = { x: 990, y: 380, w: 250, h: 80 };
const B_KNOW  = { x: 620, y: 372, w: 320, h: 96 };
const B_RECALL = { x: 300, y: 380, w: 270, h: 80 };

els.push(...card({ ...B_DRAIN,  color: 'blue',  fontSize: 16, text: 'Vault B\nfederation drain' }));
els.push(...card({ ...B_KNOW,   color: 'green', fontSize: 15, text: 'knowledge/<slug>--from-A.md\nfederated:true + provenance\n(origin vault · entryId · timestamp)' }));
els.push(...card({ ...B_RECALL, color: 'mint',  fontSize: 16, text: 'normal recall surfaces it\nlike any local doc' }));

els.push(...connector({ from: bottomOf(B_INBOX.x, B_INBOX.y, B_INBOX.w, B_INBOX.h), to: topOf(B_DRAIN.x, B_DRAIN.y, B_DRAIN.w, B_DRAIN.h) }));
els.push(...connector({ from: leftOf(B_DRAIN.x, B_DRAIN.y, B_DRAIN.w, B_DRAIN.h), to: rightOf(B_KNOW.x, B_KNOW.y, B_KNOW.w, B_KNOW.h), label: 'ingest as first-class' }));
els.push(...connector({ from: leftOf(B_KNOW.x, B_KNOW.y, B_KNOW.w, B_KNOW.h), to: rightOf(B_RECALL.x, B_RECALL.y, B_RECALL.w, B_RECALL.h), label: 'now local' }));

// kind-map annotation under the knowledge card
els.push(...annotate({
  from: [B_KNOW.x + B_KNOW.w / 2, B_KNOW.y + B_KNOW.h],
  to:   [B_KNOW.x + 30, B_KNOW.y + B_KNOW.h + 40],
  text: 'kind map: changelog→changelog · task→decision · rest→knowledge.\nAll land as knowledge/*.md on the receiver.',
}));

// ───────────────────────── PULL band (on-demand) ─────────────────────────
els.push(...sectionTitle({ x: 60, y: 560, text: 'PULL — on-demand (you run it)', fontSize: 24, color: '#6741d9' }));

const RECALL = { x: 60,  y: 612, w: 300, h: 96 };
const XVAULT = { x: 440, y: 602, w: 340, h: 116 };
const RESULT = { x: 860, y: 612, w: 300, h: 96 };

els.push(...card({ ...RECALL, color: 'blue',   fontSize: 16, text: 'dreamcontext memory recall\n--connected / --all-vaults' }));
els.push(...card({ ...XVAULT, color: 'purple', fontSize: 15, text: 'crossVaultRecall\nsearch A + consenting peers LIVE\nfederated docs excluded (no re-serve)' }));
els.push(...card({ ...RESULT, color: 'mint',   fontSize: 16, text: 'merged hits, tagged by vault\n<vault>::<type>/<slug>' }));

els.push(...connector({ from: rightOf(RECALL.x, RECALL.y, RECALL.w, RECALL.h), to: leftOf(XVAULT.x, XVAULT.y, XVAULT.w, XVAULT.h) }));
els.push(...connector({ from: rightOf(XVAULT.x, XVAULT.y, XVAULT.w, XVAULT.h), to: leftOf(RESULT.x, RESULT.y, RESULT.w, RESULT.h), label: 'rankScore desc' }));

// the only gates (bottom-right reference block)
els.push(...sectionTitle({ x: 860, y: 740, text: 'The only knobs', fontSize: 18, color: '#495057' }));
els.push(...bullets({
  x: 860, y: 772, fontSize: 15, width: 320,
  items: [
    'direction: out / in / both',
    'status: active / stale (dead peer skipped)',
    'consent: receiver shareable + reciprocal',
    'topics: filter WHAT (not WHEN)',
  ],
}));

// no-trigger note (answers "when do they read each other?")
els.push(...bullets({
  x: 60, y: 760, fontSize: 16, width: 740, color: '#1e1e1e',
  items: [
    'There is no "when X, read Y" trigger.',
    'PUSH copies peer digests in at every sleep cycle → then they are just local.',
    'PULL is live but only when you pass --connected. The per-prompt hook is local-only.',
  ],
}));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
