#!/usr/bin/env node
/**
 * Regenerates `SANDBOX_FONT_CSS` in `dashboard/src/lib/sandboxFont.ts` from the vendored
 * Inter subsets in `dashboard/src/assets/fonts/`.
 *
 * Same mirror-with-drift-test shape as `gen-chat-html-kit-mirror.mjs`, and for the same
 * reason: the sandboxed surfaces must stay importable by root vitest with a `.js`
 * specifier, so they cannot rely on Vite's `?inline` asset handling. The bytes therefore
 * live in a generated TS constant, and `tests/unit/chat-html.test.ts` fails if the constant
 * and the woff2 files ever disagree.
 *
 * Usage: node scripts/gen-sandbox-font-mirror.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(REPO, 'dashboard', 'src', 'assets', 'fonts');
const OUT = join(REPO, 'dashboard', 'src', 'lib', 'sandboxFont.ts');

/** Unicode ranges copied from Google's own Inter stylesheet — latin covers the ASCII
 *  world, latin-ext is where Turkish ğ ş İ ı actually live. */
const EXT_RANGE = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, '
  + 'U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, '
  + 'U+2113, U+2C60-2C7F, U+A720-A7FF';
const LATIN_RANGE = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, '
  + 'U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, '
  + 'U+FEFF, U+FFFD';

/**
 * ALL THREE faces the kit names, not just the body's.
 *
 * `--font-family-display` dresses every heading, `.dc-value` and `.dc-card-title`;
 * `--font-mono` dresses `.dc-code`, `.dc-pre` and the aligned number columns. Embedding
 * only the text face left those two still falling back — measured in the real app at
 * 436.5px vs 416.9px for a heading, a 4.5% gap on the most prominent type in the block.
 */
const FAMILIES = [
  { family: 'Inter', weight: '100 900', stem: 'inter' },
  { family: 'Plus Jakarta Sans', weight: '200 800', stem: 'jakarta' },
  { family: 'JetBrains Mono', weight: '100 800', stem: 'jetbrains' },
];

const faces = FAMILIES.flatMap(({ family, weight, stem }) => (
  [['-latin-ext.woff2', EXT_RANGE], ['-latin.woff2', LATIN_RANGE]].map(([suffix, range]) => {
    const b64 = readFileSync(join(FONTS, stem + suffix)).toString('base64');
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};`
      + `font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');`
      + `unicode-range:${range}}`;
  })
)).join('\n');

const header = `/**
 * THE READING FACE, carried INTO the sandbox — generated, do not hand-edit.
 *
 * Run \`node scripts/gen-sandbox-font-mirror.mjs\` after changing the woff2 files in
 * \`dashboard/src/assets/fonts/\`.
 *
 * WHY THIS FILE EXISTS. The app sets its type in Inter, loaded from Google Fonts by
 * \`index.html\`. A \`dream-html\` block cannot: its CSP is \`default-src 'none'\`, so the
 * frame has no way to fetch a font, and \`font-family: 'Inter', …\` inside it silently fell
 * through to system-ui. Measured, same string at the same size: 473px in the transcript,
 * 430px in the block — a 10% difference that reads as "the text size doesn't match" even
 * after the size and leading were made identical (owner report 2026-09-02, F5).
 *
 * WHY IT IS SAFE. A \`data:\` URL is not a fetch — nothing resolves, nothing is requested,
 * no host is contacted. The CSP gains \`font-src data:\` and NOTHING ELSE, so the frame
 * still cannot reach the network by any route. The bytes travel inside the document that
 * uses them, which is the same property that lets an exported block render offline.
 *
 * WHY BOTH SUBSETS. Turkish is the first language of this project's owner and \`ğ ş İ\` are
 * Latin Extended-A: shipping only the latin subset would render exactly those letters in a
 * different face, which is worse than a uniform fallback.
 *
 * WHY ALL THREE FAMILIES. The kit names three: the text face, the display face every
 * heading and headline number is set in, and the mono of \`.dc-code\`. Each is a separate
 * webfont the app loads over the network and the frame cannot, so each is a separate
 * fallback if left out.
 *
 * All three are SIL Open Font License 1.1 — see the \`*-LICENSE.txt\` beside the woff2s.
 */
`;

writeFileSync(OUT, `${header}export const SANDBOX_FONT_CSS = ${JSON.stringify(faces)};\n`);
console.log(`font mirror regenerated (${Math.round(faces.length / 1024)}KB of CSS)`);
