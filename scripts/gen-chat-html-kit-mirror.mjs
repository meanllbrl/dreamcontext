/**
 * Regenerates the kit's two mirrored constants in `chatHtmlKit.ts`:
 *   • `CHAT_HTML_KIT_CSS` from `chat-html-kit.css`  (the class kit)
 *   • `KIT_GRAPH`         from `chat-html-graph.js` (the diagram engine)
 *
 * The TS constants are what actually SHIP (vitest stubs `?raw` imports to empty), and the
 * source files are the reference copies a human reads and a brand override is written
 * against. `tests/unit/chat-html.test.ts` pins each pair byte-identical, so this script — not
 * a hand edit — is how a mirror moves. Non-ASCII is escaped so the TS source stays ASCII-only.
 *
 * Usage: node scripts/gen-chat-html-kit-mirror.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'dashboard/src/components/sleepy/chat';
const TS = `${DIR}/chatHtmlKit.ts`;
const MIRRORS = [
  { constant: 'CHAT_HTML_KIT_CSS', source: `${DIR}/chat-html-kit.css` },
  { constant: 'KIT_GRAPH', source: `${DIR}/chat-html-graph.js` },
];

const NON_ASCII = new RegExp('[\\u0080-\\uffff]', 'g');
const literalOf = (text) => JSON.stringify(text).replace(
  NON_ASCII,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
);

let ts = readFileSync(TS, 'utf-8');
for (const { constant, source } of MIRRORS) {
  const text = readFileSync(source, 'utf-8');
  const pattern = new RegExp(`export const ${constant} = "(?:[^"\\\\]|\\\\.)*";`);
  if (!pattern.test(ts)) throw new Error(`${constant} constant not found in ${TS}`);
  ts = ts.replace(pattern, () => `export const ${constant} = ${literalOf(text)};`);
  console.log(`${constant}: mirror regenerated from ${text.length} chars of ${source}`);
}
writeFileSync(TS, ts, 'utf-8');
