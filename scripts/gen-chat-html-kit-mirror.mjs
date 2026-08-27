/**
 * Regenerates `CHAT_HTML_KIT_CSS` in `chatHtmlKit.ts` from `chat-html-kit.css`.
 *
 * The TS constant is what actually SHIPS (vitest stubs `.css?raw` imports to empty), and the
 * .css file is the reference copy a human reads and a brand override is written against.
 * `tests/unit/chat-html.test.ts` pins them byte-identical, so this script — not a hand edit —
 * is how the mirror moves. Non-ASCII is escaped so the source file stays ASCII-only, matching
 * how the constant was first written.
 *
 * Usage: node scripts/gen-chat-html-kit-mirror.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CSS = 'dashboard/src/components/sleepy/chat/chat-html-kit.css';
const TS = 'dashboard/src/components/sleepy/chat/chatHtmlKit.ts';

const css = readFileSync(CSS, 'utf-8');
const NON_ASCII = new RegExp('[\\u0080-\\uffff]', 'g');
const literal = JSON.stringify(css).replace(
  NON_ASCII,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
);

const ts = readFileSync(TS, 'utf-8');
const pattern = /export const CHAT_HTML_KIT_CSS = "(?:[^"\\]|\\.)*";/;
if (!pattern.test(ts)) throw new Error(`CHAT_HTML_KIT_CSS constant not found in ${TS}`);

writeFileSync(TS, ts.replace(pattern, `export const CHAT_HTML_KIT_CSS = ${literal};`), 'utf-8');
console.log(`mirror regenerated from ${css.length} css chars`);
