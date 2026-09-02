/**
 * The `dream-html` block's injection layer — the Chat-view twin of the Lab's `labHtmlKit`.
 *
 * An agent's HTML is drawn inside a sandboxed iframe with NO same-origin grant, so the
 * app's CSS variables never reach it. This module builds that iframe's `srcdoc`: the
 * locked-down CSP first (shared with the Lab — see `lib/sandboxHtml.ts`), then a `:root` of
 * the CURRENT theme's resolved token values, then the `dc-` class kit, then the vault's
 * optional brand override, then the height bridge — and only then the body, which is the one
 * part of the document the agent wrote and therefore the one part that can break parsing.
 *
 * WHAT THIS FILE ADDS OVER THE LAB'S: two things the Lab card deliberately does without.
 *   • CONTENT-DRIVEN HEIGHT. A chat answer is not a 232px card — it is however tall the
 *     explanation is. `HEIGHT_BRIDGE` posts one number child->host when the body's size
 *     changes, and re-posts it whenever the host asks (`HEIGHT_REQUEST_KEY`) — a measurement
 *     nobody can confirm arrived is a block frozen at 40px.
 *   • A BRAND OVERRIDE. The kit is dreamcontext's, but a vault may restyle it
 *     (`_dream_context/overrides/chat-html-kit.css`), appended last so "later wins" is the
 *     whole override mechanism.
 *
 * Neither loosens the sandbox: the grant is still `allow-scripts` alone and the CSP is still
 * `default-src 'none'`. The bridge carries one number out and one boolean in — the host
 * asking to be told again — and each side answers only the other; the override is CSS text
 * the host read off local disk, not something the frame fetched.
 *
 * No React, no CSS imports — importable by root vitest with a `.js` specifier.
 */
import {
  SANDBOX_CSP, SANDBOX_GRANT, resolveTokens, buildSandboxSrcdoc,
} from '../../../lib/sandboxHtml';

/** Re-exported under Chat-local names so a reader of this surface never has to know the
 *  Lab exists — but they are the SAME constants, deliberately (see `lib/sandboxHtml.ts`). */
export const CHAT_HTML_CSP = SANDBOX_CSP;
export const CHAT_HTML_SANDBOX = SANDBOX_GRANT;

/**
 * The kit, embedded as a TS string so it survives every toolchain (vitest stubs `.css?raw`
 * imports to empty — the Lab lost a day to this in 2026-08). `chat-html-kit.css` next to
 * this file is the SAME text: the reference copy a human reads and a brand override is
 * written against, pinned byte-identical by `tests/unit/chat-html.test.ts`.
 *
 * To edit: change the .css file, then regenerate this constant — never hand-edit both.
 */
export const CHAT_HTML_KIT_CSS = "/**\n * chat-html-kit.css \u2014 the class kit an agent's ```dream-html block writes against.\n *\n * Embedded into the sandboxed iframe's srcdoc together with a :root block of RESOLVED\n * design-token values (CSS variables do not cross the iframe document boundary, so\n * chatHtmlKit.ts inlines the current theme's values and re-injects on theme change), and\n * followed by the vault's optional brand override.\n *\n * THE RULE FOR AUTHORS: don't write your own colors, fonts or spacing \u2014 use these classes\n * and the block looks native dreamcontext in both themes, on both surfaces, and follows the\n * user's brand override for free. Reach for a `style=` attribute only for geometry the kit\n * has no word for (an SVG path, a grid template, a bar width).\n *\n * Prefixed `dc-`. Unlike the Lab's `lk-` kit \u2014 a 232px card body \u2014 this is a READING and\n * PRESENTATION surface: it has headings, prose, and a slide mode.\n *\n * TWO MODES. `<html data-dc-mode>` is set by the host: \"card\" inline in the transcript,\n * \"full\" in the fullscreen presentation overlay. Only `.dc-slide` reads it \u2014 everything else\n * renders identically, so an author writes once and it works in both.\n */\n\n* { box-sizing: border-box; }\n\nhtml, body {\n  /* Auto height, both of them: the host measures the body to size the iframe, so a\n     percentage height here would make the measurement chase the frame it is setting. */\n  height: auto;\n  margin: 0;\n  padding: 0;\n}\n\n/**\n * THE ONE SIZE THE WHOLE KIT IS SET IN, and it is the TRANSCRIPT'S, not ours.\n *\n * `--chat-text` / `--chat-line-height` are the reading size and rhythm every prose surface\n * in the chat already reads (ChatPane.css) \u2014 15px x the window's zoom, led at 1.75. A block\n * that set its own 14px/1.55 sat in the middle of that column reading as a different\n * document: smaller type, tighter lines, and completely deaf to the \"- 100% +\" control,\n * because CSS variables do not cross the iframe boundary and `--zoom` never arrived\n * (owner report 2026-09-02, \"ana metin text size'i ile html text size uyusmuyor\"). The host\n * resolves both off the pane and injects them; it re-injects when the zoom changes.\n *\n * It lands on <html> rather than body so every size below can be a REM \u2014 one root, no\n * compounding, so a chip inside a stat inside a card is the size it says it is. The px\n * fallbacks keep a host that has no chat tokens (a Meeting Room embed) looking as it did.\n */\nhtml {\n  font-size: var(--chat-text, 14px);\n}\n\nbody {\n  font-family: var(--font-family);\n  font-size: 1rem;\n  line-height: var(--chat-line-height, 1.55);\n  color: var(--color-text);\n  background: transparent;\n  /* The same three the app sets on its own body (styles/global.css). Type that matches in\n     size, leading and FACE still reads as a different document if it is tracked differently\n     or ligates differently \u2014 the tracking alone was 8.6px over one line. */\n  letter-spacing: var(--letter-spacing-body, normal);\n  font-feature-settings: \"calt\" 0, \"clig\" 0, \"liga\" 0;\n  -webkit-font-smoothing: antialiased;\n  /* Everything in here sizes itself against the PANE, which is narrower than a window and\n     narrower still with the slide-over open. Makes the @container rules below possible. */\n  container-type: inline-size;\n}\n\n/* \u2500\u2500 The root wrapper. Wrap the whole block in it: it owns the rhythm between\n     sections so an author never hand-spaces margins.\n\n     BLOCK FLOW, NOT A FLEX COLUMN \u2014 and this is the single most consequential line in the\n     kit. A flex column turns every direct child into a flex ITEM, including bare text and\n     inline elements: an author who writes a sentence with a `dc-code` chip in the middle of\n     it gets three stacked full-width rows instead of one sentence. The owner's report was\n     \"hi\u00e7bir \u015fey anla\u015f\u0131lm\u0131yor\", and it was literally true \u2014 the prose had been cut into\n     pieces (screenshot 2026-09-02). `> * + *` gives block children the same rhythm a `gap`\n     did, while inline content goes back to doing what inline content does. Same idiom\n     `.dc-panel` already used. \u2500\u2500 */\n.dc-doc { display: block; }\n/* Little content does not want a 960px box. One kv, three chips, a single stat \u2014 stretched\n   across the full measure they read as a mostly-empty panel with something lost in it. */\n.dc-doc--hug { max-inline-size: max-content; }\n\n/* \u2550\u2550\u2550 Typography \u2550\u2550\u2550 */\n\n.dc-h1, .dc-h2, .dc-h3 {\n  font-family: var(--font-family-display);\n  font-weight: 700;\n  letter-spacing: -0.02em;\n  color: var(--color-text);\n  margin: 0;\n}\n.dc-h1 { font-size: 1.714rem; line-height: 1.25; }\n.dc-h2 { font-size: 1.286rem; line-height: 1.3; }\n.dc-h3 { font-size: 1.071rem; line-height: 1.35; font-weight: 600; letter-spacing: -0.01em; }\n\n/* The one line under a heading that frames what follows. */\n.dc-lede { font-size: 1.036rem; color: var(--color-text-secondary); margin: 0; }\n.dc-p { margin: 0; color: var(--color-text); }\n.dc-muted { font-size: 0.929rem; color: var(--color-text-tertiary); }\n.dc-label {\n  font-size: 0.786rem;\n  font-weight: 700;\n  letter-spacing: 0.06em;\n  text-transform: uppercase;\n  color: var(--color-text-tertiary);\n}\n.dc-strong { font-weight: 650; color: var(--color-text); }\n\n.dc-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }\n.dc-list li { color: var(--color-text); }\n\n/* The marker stroke \u2014 the SAME pen as the transcript's own ==highlight== (styles/global.css):\n   ink that stops short of the ascender line and of the baseline gap, over INHERITED text\n   colour. It used to be an accent-tinted box with `--color-accent-text` on top \u2014 which is\n   white \u2014 so the marked phrase was the one phrase in the block you could not read (owner\n   report 08-27). Same class of bug as ChatPane's context chip and composer's slash row:\n   `--color-accent-text` belongs on a SOLID accent fill, never on a tint of it.\n   A bare `mark` is in the selector because the iframe never sees global.css, and the UA\n   stylesheet repaints <mark> black-on-yellow \u2014 a contrast failure in the dark theme. */\n.dc-mark, mark {\n  /* One pair of variables, so a coloured pen re-inks the stroke instead of redescribing it. */\n  --dc-mark-ink: var(--color-highlight);\n  --dc-mark-edge: var(--color-highlight-edge);\n  background: linear-gradient(\n    to bottom,\n    transparent 8%,\n    var(--dc-mark-ink) 8%,\n    var(--dc-mark-ink) 88%,\n    var(--dc-mark-edge) 88%,\n    var(--dc-mark-edge) 94%,\n    transparent 94%\n  );\n  color: inherit;\n  padding: 0 0.22em;\n  /* Pulled back so the stroke overhangs the phrase without adding width and re-wrapping\n     the line under it. */\n  margin: 0 -0.1em;\n  border-radius: 0.15em;\n  /* A highlight that wraps is TWO strokes, one per line. */\n  -webkit-box-decoration-break: clone;\n  box-decoration-break: clone;\n}\n\n.dc-code {\n  font-family: var(--font-mono);\n  font-size: 0.893rem;\n  padding: 1px 5px;\n  border-radius: 4px;\n  background: var(--color-bg-tertiary);\n  color: var(--color-text);\n}\n.dc-pre {\n  font-family: var(--font-mono);\n  font-size: 0.893rem;\n  line-height: 1.5;\n  margin: 0;\n  padding: 12px 14px;\n  border-radius: var(--radius-md);\n  border: 1px solid var(--color-border);\n  background: var(--color-bg-secondary);\n  color: var(--color-text);\n  overflow-x: auto;\n  white-space: pre;\n}\n\n/* \u2550\u2550\u2550 Numbers \u2014 the NumberCard idiom: display face, tight tracking, tabular digits.\n     Mono is for ALIGNED COLUMNS only (see .dc-num), never for a headline figure. \u2550\u2550\u2550 */\n\n.dc-value {\n  font-family: var(--font-family-display);\n  font-size: 2rem;\n  font-weight: 700;\n  letter-spacing: -0.02em;\n  font-variant-numeric: tabular-nums;\n  line-height: 1.1;\n  color: var(--color-text);\n}\n.dc-value--lg { font-size: 2.857rem; }\n.dc-value--sm { font-size: 1.357rem; }\n.dc-unit { font-size: 1rem; font-weight: 500; color: var(--color-text-tertiary); margin-left: 4px; }\n.dc-num { font-family: var(--font-mono); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }\n\n.dc-delta { font-size: 0.929rem; font-weight: 600; }\n.dc-delta--up { color: var(--color-success); }\n.dc-delta--down { color: var(--color-error); }\n.dc-delta--flat { color: var(--color-text-tertiary); }\n\n/* \u2550\u2550\u2550 Layout \u2550\u2550\u2550 */\n\n.dc-row { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }\n.dc-row--top { align-items: flex-start; }\n.dc-row--between { justify-content: space-between; }\n/* Block flow for the same reason as .dc-doc \u2014 a stack holding a sentence must not cut it\n   into rows. Use .dc-row when you want things beside each other. */\n.dc-stack { display: block; min-width: 0; }\n.dc-spacer { flex: 1; }\n\n.dc-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }\n.dc-grid--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n.dc-grid--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }\n.dc-grid--4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }\n\n/* The horizontally scrolling shelf \u2014 what `page`'s rail was for: six things read\n   side by side instead of stacked down the screen. */\n.dc-rail {\n  display: flex;\n  gap: 12px;\n  overflow-x: auto;\n  padding-bottom: 6px;\n  scroll-snap-type: x proximity;\n  -webkit-overflow-scrolling: touch;\n}\n.dc-rail > * { flex: 0 0 auto; width: 250px; scroll-snap-align: start; }\n.dc-rail::-webkit-scrollbar { height: 8px; }\n.dc-rail::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 4px; }\n\n.dc-divider { border: none; border-top: 1px solid var(--color-border); margin: 2px 0; }\n.dc-divider-label {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  font-size: 0.786rem;\n  font-weight: 700;\n  letter-spacing: 0.06em;\n  text-transform: uppercase;\n  color: var(--color-text-tertiary);\n}\n.dc-divider-label::after { content: \"\"; flex: 1; border-top: 1px solid var(--color-border); }\n\n/* \u2550\u2550\u2550 Card \u2550\u2550\u2550 */\n\n.dc-card {\n  padding: 14px 16px;\n  border: 1px solid var(--color-border);\n  border-radius: var(--radius-lg);\n  background: var(--color-bg-secondary);\n  min-width: 0;\n}\n.dc-card--flat { background: transparent; }\n.dc-card--accent { border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border)); }\n.dc-card-title { font-family: var(--font-family-display); font-size: 1.071rem; font-weight: 650; letter-spacing: -0.01em; color: var(--color-text); }\n.dc-card-sub { font-size: 0.893rem; color: var(--color-text-tertiary); }\n.dc-card-img { width: 100%; border-radius: var(--radius-md); display: block; object-fit: cover; }\n.dc-card-foot { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }\n\n/* \u2550\u2550\u2550 Stat tile \u2014 a lighter surface than the chips inside it, so toned chips keep\n     their separation instead of sinking into the same grey. \u2550\u2550\u2550 */\n\n.dc-stat {\n  padding: 12px 14px;\n  border: 1px solid var(--color-border);\n  border-radius: var(--radius-lg);\n  background: var(--color-bg-secondary);\n  min-width: 0;\n}\n.dc-stat-label { font-size: 0.857rem; font-weight: 600; color: var(--color-text-secondary); }\n.dc-stat-note { font-size: 0.821rem; color: var(--color-text-tertiary); }\n\n/* \u2550\u2550\u2550 Chip / badge \u2014 the .lab-badge pair: subtle background, toned text, no border \u2550\u2550\u2550 */\n\n.dc-chip {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  padding: 3px 9px;\n  border-radius: 999px;\n  font-size: 0.821rem;\n  font-weight: 600;\n  white-space: nowrap;\n  color: var(--color-text-secondary);\n  background: var(--color-bg-tertiary);\n}\n.dc-chip--accent { color: var(--color-accent); background: var(--color-accent-soft); }\n.dc-chip--good { color: var(--color-success); background: var(--color-success-subtle); }\n.dc-chip--bad { color: var(--color-error); background: var(--color-error-subtle); }\n.dc-chip--warn { color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 15%, transparent); }\n\n/* \u2550\u2550\u2550 Callout \u2014 tinted SURFACE with body text on top (never a solid accent fill\n     behind prose: it fails contrast in one theme or the other) \u2550\u2550\u2550 */\n\n.dc-callout {\n  padding: 11px 14px;\n  border-radius: var(--radius-md);\n  border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border));\n  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-tertiary));\n  color: var(--color-text);\n  font-size: 0.964rem;\n}\n.dc-callout--good { border-color: color-mix(in srgb, var(--color-success) 38%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 10%, var(--color-bg-tertiary)); }\n.dc-callout--bad { border-color: color-mix(in srgb, var(--color-error) 38%, var(--color-border)); background: color-mix(in srgb, var(--color-error) 10%, var(--color-bg-tertiary)); }\n.dc-callout--warn { border-color: color-mix(in srgb, var(--color-warning) 38%, var(--color-border)); background: color-mix(in srgb, var(--color-warning) 10%, var(--color-bg-tertiary)); }\n\n/* \u2550\u2550\u2550 Table \u2014 the MetricTable idiom \u2550\u2550\u2550 */\n\n.dc-table {\n  width: 100%;\n  border-collapse: collapse;\n  font-size: 0.929rem;\n  border: 1px solid var(--color-border);\n  border-radius: var(--radius-md);\n  overflow: hidden;\n}\n.dc-table th {\n  text-align: left;\n  padding: 8px 12px;\n  font-weight: 600;\n  font-size: 0.857rem;\n  color: var(--color-text-secondary);\n  background: var(--color-bg-tertiary);\n  white-space: nowrap;\n}\n.dc-table td { padding: 7px 12px; border-top: 1px solid var(--color-border); color: var(--color-text); }\n.dc-table th.dc-num, .dc-table td.dc-num { text-align: right; }\n.dc-table tr.dc-row--pick td { background: var(--color-accent-soft); }\n.dc-caption { font-size: 0.857rem; color: var(--color-text-tertiary); }\n\n/* A table wider than the pane. `.dc-table` keeps its `overflow: hidden` \u2014 that is what\n   clips its own corners to the radius \u2014 so the SCROLL has to live one level out, or the\n   right-hand columns just stop existing at the pane's edge with nothing to say they did. */\n.dc-table-wrap { overflow-x: auto; max-width: 100%; }\n.dc-table-wrap::-webkit-scrollbar { height: 8px; }\n.dc-table-wrap::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 4px; }\n\n/* Key/value pairs \u2014 a spec list without a table's ceremony. */\n.dc-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 0.929rem; }\n.dc-kv dt { color: var(--color-text-tertiary); }\n.dc-kv dd { margin: 0; color: var(--color-text); }\n\n/* \u2550\u2550\u2550 Bar row \u2014 the BarList idiom. Set the fill's width inline. \u2550\u2550\u2550 */\n\n.dc-bar { display: flex; align-items: center; gap: 10px; font-size: 0.929rem; min-width: 0; }\n.dc-bar-label { flex: 0 0 32%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); }\n.dc-bar-track { flex: 1; min-width: 0; height: 9px; border-radius: 5px; background: var(--color-bg-tertiary); overflow: hidden; }\n.dc-bar-fill { display: block; height: 100%; border-radius: 5px; background: var(--chart-1); }\n.dc-bar-value { flex-shrink: 0; font-family: var(--font-mono); font-size: 0.893rem; font-variant-numeric: tabular-nums; color: var(--color-text); }\n\n/* \u2550\u2550\u2550 Funnel \u2014 stacked proportional steps, the shape a conversion story wants \u2550\u2550\u2550 */\n\n.dc-funnel { display: flex; flex-direction: column; gap: 6px; }\n.dc-funnel-step { display: flex; align-items: center; gap: 10px; font-size: 0.929rem; }\n.dc-funnel-bar { height: 30px; border-radius: var(--radius-sm); background: var(--chart-1); display: flex; align-items: center; padding: 0 10px; color: var(--color-accent-text, #fff); font-weight: 600; font-size: 0.893rem; min-width: 44px; }\n.dc-funnel-drop { font-size: 0.857rem; color: var(--color-text-tertiary); }\n\n/* \u2550\u2550\u2550 Steps / flow \u2014 how to explain a PROCESS instead of narrating it \u2550\u2550\u2550 */\n\n.dc-steps { display: flex; flex-direction: column; gap: 10px; counter-reset: dc-step; }\n.dc-step { display: flex; gap: 12px; align-items: flex-start; }\n.dc-step::before {\n  counter-increment: dc-step;\n  content: counter(dc-step);\n  flex: 0 0 24px;\n  height: 24px;\n  border-radius: 999px;\n  display: grid;\n  place-items: center;\n  font-size: 0.857rem;\n  font-weight: 700;\n  color: var(--color-accent);\n  background: var(--color-accent-soft);\n}\n.dc-step-body { min-width: 0; }\n\n/* Left-to-right pipeline: boxes the kit joins with arrows. Write NODES ONLY \u2014 every node\n   after the first draws its own leading arrow, so when the row wraps the arrow travels\n   WITH the node it points at and a continuation row opens with \"\u2192 next step\". The flat\n   `.dc-flow-arrow` spans this used to take are absorbed (hidden, superseded by the drawn\n   arrow): as free flex items they could wrap AWAY from their node, leaving a trailing \u2192\n   pointing at nothing over a full-bleed orphan with no row gap (owner report 08-27). */\n.dc-flow { display: flex; align-items: stretch; gap: 10px 0; flex-wrap: wrap; }\n.dc-flow-node {\n  /* Hugs its label \u2014 a node that stretches to fill the row it wrapped onto reads as a\n     different kind of thing than the boxes before it. */\n  flex: 0 1 auto;\n  position: relative;\n  min-width: 0;\n  padding: 10px 12px;\n  border: 1px solid var(--color-border);\n  border-radius: var(--radius-md);\n  background: var(--color-bg-secondary);\n  font-size: 0.893rem;\n}\n.dc-flow-node ~ .dc-flow-node { margin-left: 30px; }\n.dc-flow-node ~ .dc-flow-node::before {\n  content: \"\\2192\";\n  position: absolute;\n  right: 100%;\n  top: 50%;\n  width: 30px;\n  transform: translateY(-50%);\n  text-align: center;\n  color: var(--color-text-tertiary);\n  font-size: 1.071rem;\n  line-height: 1;\n}\n.dc-flow-arrow { display: none; }\n/* A step that MEANS something \u2014 the failure, the branch that pays off \u2014 tinted the same way\n   a callout is: a 10% surface under normal text, never a solid fill with prose on top. The\n   modifier exists so \"this node matters\" has a legitimate class; without one the reach is\n   for `dc-bg3`, which is a chart fill, and dark-red body text on saturated orange is what\n   that produced (owner screenshot 2026-09-02). Tone is MEANING here, not decoration. */\n.dc-flow-node--accent {\n  border-color: color-mix(in srgb, var(--color-accent) 38%, var(--color-border));\n  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-secondary));\n}\n.dc-flow-node--good {\n  border-color: color-mix(in srgb, var(--color-success) 38%, var(--color-border));\n  background: color-mix(in srgb, var(--color-success) 10%, var(--color-bg-secondary));\n}\n.dc-flow-node--bad {\n  border-color: color-mix(in srgb, var(--color-error) 38%, var(--color-border));\n  background: color-mix(in srgb, var(--color-error) 10%, var(--color-bg-secondary));\n}\n.dc-flow-node--warn {\n  border-color: color-mix(in srgb, var(--color-warning) 38%, var(--color-border));\n  background: color-mix(in srgb, var(--color-warning) 10%, var(--color-bg-secondary));\n}\n\n/* \u2550\u2550\u2550 Timeline \u2550\u2550\u2550 */\n\n.dc-timeline { display: flex; flex-direction: column; gap: 0; }\n.dc-tl { display: flex; gap: 12px; align-items: flex-start; padding-bottom: 14px; position: relative; }\n.dc-tl:not(:last-child)::after {\n  content: \"\";\n  position: absolute;\n  left: 5px;\n  top: 14px;\n  bottom: 0;\n  width: 1px;\n  background: var(--color-border);\n}\n.dc-tl-dot { flex: 0 0 11px; height: 11px; margin-top: 5px; border-radius: 999px; background: var(--chart-1); position: relative; z-index: 1; }\n.dc-tl-body { min-width: 0; }\n.dc-tl-when { font-size: 0.821rem; color: var(--color-text-tertiary); }\n\n/* \u2550\u2550\u2550 Compare \u2014 the DECISION block. Two or three options rendered side by side so\n     the reader picks by looking, instead of reading a paragraph about each. \u2550\u2550\u2550 */\n\n/* 340px, not 230px, and the difference is the whole readability of a decision block.\n   `auto-fit` keeps two columns for as long as they FIT, which is not the same as for as\n   long as they READ: at a 534px pane, minmax(230px) gave two 261px columns and a measure\n   of 27 characters \u2014 prose broken every three words down two ragged ribbons (owner\n   screenshot 2026-09-02). Measured across pane widths, ~340px is where a column still\n   holds ~40 characters; below that the honest answer is one column, which at the SAME pane\n   width reads at 45. 380px is the measured floor: it keeps two columns at a full-width\n   pane (~48 characters each) and stacks everywhere narrower, where one column reads at 67.\n   An option that is a title and three short bullets loses nothing by stacking; an option\n   that is a paragraph gains everything. The briefing asks for the short kind. */\n.dc-compare { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); align-items: stretch; }\n.dc-option {\n  padding: 14px 16px;\n  border: 1px solid var(--color-border);\n  border-radius: var(--radius-lg);\n  background: var(--color-bg-secondary);\n  min-width: 0;\n}\n/* The one being recommended \u2014 a tinted surface and a heavier border, never a fill. */\n.dc-option--pick {\n  border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border));\n  background: color-mix(in srgb, var(--color-accent) 7%, var(--color-bg-secondary));\n}\n.dc-option-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }\n.dc-option-title { font-family: var(--font-family-display); font-size: 1.071rem; font-weight: 650; letter-spacing: -0.01em; }\n.dc-pros, .dc-cons { margin: 0; padding-left: 16px; font-size: 0.929rem; display: flex; flex-direction: column; gap: 3px; }\n.dc-pros li { color: var(--color-text); }\n.dc-cons li { color: var(--color-text-secondary); }\n.dc-pros li::marker { content: \"+ \"; color: var(--color-success); font-weight: 700; }\n.dc-cons li::marker { content: \"\u2212 \"; color: var(--color-error); font-weight: 700; }\n\n/* \u2550\u2550\u2550 Tabs \u2014 no script the AUTHOR has to write. Two forms work, and the reason there are\n     two is a defect worth remembering (owner screenshot, 2026-09-02):\n\n       1. BUTTONS (write this). `<div class=\"dc-tablist\"><button class=\"dc-tab\">A</button>\u2026`\n          followed by `<div class=\"dc-panels\"><div class=\"dc-panel\">\u2026</div>\u2026`. Tab N opens\n          panel N, wired by the HOST's own tab script (`KIT_BEHAVIOUR` in chatHtmlKit.ts) \u2014\n          which is also inlined into an exported file, so the export keeps switching.\n       2. RADIOS (still supported, and what the kit shipped with). Ids unique in the block:\n            <div class=\"dc-tabs\">\n              <input type=\"radio\" name=\"g\" id=\"g1\" checked><input type=\"radio\" name=\"g\" id=\"g2\">\n              <div class=\"dc-tablist\"><label class=\"dc-tab\" for=\"g1\">A</label>\u2026</div>\n              <div class=\"dc-panels\"><section class=\"dc-panel\">\u2026</section>\u2026</div>\n            </div>\n          Pure CSS, up to five tabs, works with scripting off entirely.\n\n     Form 1 exists because form 2 was the ONLY one and the briefing said \"dc-tabs needs no\n     script\": an author wrote the obvious button tablist, got no radios, and every panel\n     stayed `display: none` \u2014 a tab bar over an EMPTY BOX, two panels of real content gone.\n     Valid markup, every class defined, nothing failed anywhere. Hence the rule below that\n     a panel is never invisible by default. \u2550\u2550\u2550 */\n\n.dc-tabs { display: flex; flex-direction: column; gap: 10px; }\n.dc-tabs > input[type=\"radio\"] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }\n.dc-tablist { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--color-border); }\n/* The first four declarations are the <button> RESET. Without them a button tablist renders\n   as a row of grey OS buttons in the middle of the kit, in the OS UI face \u2014 the second half\n   of the same screenshot. A <label> is untouched by any of them. */\n.dc-tab {\n  appearance: none;\n  -webkit-appearance: none;\n  background: none;\n  border: 0;\n  font: inherit;\n  border-bottom: 2px solid transparent;\n  border-radius: 0;\n  padding: 6px 12px;\n  font-size: 0.929rem;\n  font-weight: 600;\n  color: var(--color-text-secondary);\n  margin-bottom: -1px;\n  cursor: pointer;\n  user-select: none;\n}\n.dc-tab:hover { color: var(--color-text); }\n/* The host script's selected tab. The radio form's equivalent is the :checked chain below. */\n.dc-tab--on { color: var(--color-accent); border-bottom-color: var(--color-accent); }\n\n/* A PANEL IS NEVER INVISIBLE BY DEFAULT \u2014 the whole lesson above, as one rule. Panel one\n   shows unconditionally, and steps aside only for a REAL selection, by either mechanism.\n   Worst case (no radios, no script at all) the reader gets the first panel, which is a\n   readable block; the old worst case was nothing. */\n.dc-panels > .dc-panel { display: none; }\n.dc-panels > .dc-panel:nth-of-type(1) { display: block; }\n.dc-panels > .dc-panel--on { display: block; }\n.dc-tabs > input:nth-of-type(n+2):checked ~ .dc-panels > .dc-panel:nth-of-type(1),\n.dc-panels:has(> .dc-panel--on) > .dc-panel:nth-of-type(1):not(.dc-panel--on) { display: none; }\n.dc-panel > * + * { margin-top: 10px; }\n\n.dc-tabs > input:nth-of-type(1):checked ~ .dc-tablist > .dc-tab:nth-of-type(1),\n.dc-tabs > input:nth-of-type(2):checked ~ .dc-tablist > .dc-tab:nth-of-type(2),\n.dc-tabs > input:nth-of-type(3):checked ~ .dc-tablist > .dc-tab:nth-of-type(3),\n.dc-tabs > input:nth-of-type(4):checked ~ .dc-tablist > .dc-tab:nth-of-type(4),\n.dc-tabs > input:nth-of-type(5):checked ~ .dc-tablist > .dc-tab:nth-of-type(5) {\n  color: var(--color-accent);\n  border-bottom-color: var(--color-accent);\n}\n.dc-tabs > input:nth-of-type(1):checked ~ .dc-panels > .dc-panel:nth-of-type(1),\n.dc-tabs > input:nth-of-type(2):checked ~ .dc-panels > .dc-panel:nth-of-type(2),\n.dc-tabs > input:nth-of-type(3):checked ~ .dc-panels > .dc-panel:nth-of-type(3),\n.dc-tabs > input:nth-of-type(4):checked ~ .dc-panels > .dc-panel:nth-of-type(4),\n.dc-tabs > input:nth-of-type(5):checked ~ .dc-panels > .dc-panel:nth-of-type(5) {\n  display: block;\n}\n/* Keyboard: the hidden radio is what actually receives focus, so the ring has to be\n   drawn on the label it controls or a keyboard user sees nothing move. */\n.dc-tabs > input:nth-of-type(1):focus-visible ~ .dc-tablist > .dc-tab:nth-of-type(1),\n.dc-tabs > input:nth-of-type(2):focus-visible ~ .dc-tablist > .dc-tab:nth-of-type(2),\n.dc-tabs > input:nth-of-type(3):focus-visible ~ .dc-tablist > .dc-tab:nth-of-type(3),\n.dc-tabs > input:nth-of-type(4):focus-visible ~ .dc-tablist > .dc-tab:nth-of-type(4),\n.dc-tabs > input:nth-of-type(5):focus-visible ~ .dc-tablist > .dc-tab:nth-of-type(5) {\n  outline: 2px solid var(--color-accent);\n  outline-offset: 2px;\n  border-radius: var(--radius-sm);\n}\n\n/* \u2550\u2550\u2550 Interactive affordances \u2014 a button the author's own inline script wires up.\n     It can change what the block SHOWS; it cannot reach the network or the app. \u2550\u2550\u2550 */\n\n.dc-btn {\n  appearance: none;\n  font: inherit;\n  font-size: 0.893rem;\n  font-weight: 600;\n  padding: 5px 12px;\n  border-radius: var(--radius-sm);\n  border: 1px solid var(--color-border);\n  background: var(--color-bg-tertiary);\n  color: var(--color-text);\n  cursor: pointer;\n}\n.dc-btn:hover { border-color: var(--color-border-hover); }\n.dc-btn[aria-pressed=\"true\"], .dc-btn--on { color: var(--color-accent); border-color: color-mix(in srgb, var(--color-accent) 50%, var(--color-border)); background: var(--color-accent-soft); }\n.dc-btn:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }\n\n/* \u2550\u2550\u2550 Hover \u2014 the kit's own reveal, so a chart point or a number can ANSWER a pointer\n     without the author writing a line of CSS. Pure CSS, no script.\n\n     The reveal is opacity+visibility rather than `display`, because that is the one pair\n     that behaves identically in HTML and inside an <svg> \u2014 an SVG element has no box to\n     un-display. Wrap the hovered thing in `.dc-hit`, put a `.dc-tip` inside it:\n\n       <span class=\"dc-hit\">%14,2<span class=\"dc-tip\">3.204 / 22.560</span></span>\n\n     In an <svg> the hit is a <g> and the tip is a <g class=\"dc-tip\"> the author places at\n     the point \u2014 the kit paints its surface and type, the author owns the coordinates,\n     since nothing else can know them:\n\n       <g class=\"dc-hit\"><circle class=\"dc-f1\" cx=\"80\" cy=\"40\" r=\"9\"/>\n         <g class=\"dc-tip\" transform=\"translate(80,40)\">\n           <rect class=\"dc-tip-box\" x=\"-46\" y=\"-34\" width=\"92\" height=\"23\" rx=\"5\"/>\n           <text class=\"dc-tip-text\" x=\"0\" y=\"-18\" text-anchor=\"middle\">DP1 \u00b7 %3,39</text>\n         </g></g>\n\n     A tip on the top row would clip at the frame's edge \u2014 `.dc-tip--below` flips it under.\n     Give the `.dc-hit` a `tabindex=\"0\"` and the tip also shows on keyboard focus, so the\n     number is never mouse-only. \u2550\u2550\u2550 */\n\n.dc-hit { position: relative; }\n.dc-hit:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }\n\n.dc-tip {\n  opacity: 0;\n  visibility: hidden;\n  /* Never steal the hover from the mark that reveals it. */\n  pointer-events: none;\n  transition: opacity 90ms ease-out;\n}\n.dc-hit:hover > .dc-tip,\n.dc-hit:focus-visible > .dc-tip,\n.dc-hit:focus-within > .dc-tip { opacity: 1; visibility: visible; }\n\n/* The HTML bubble. `position` does not apply inside an <svg>, so the SVG form uses\n   .dc-tip-box / .dc-tip-text below and positions itself with a transform instead. */\nspan.dc-tip, div.dc-tip {\n  position: absolute;\n  bottom: calc(100% + 6px);\n  left: 50%;\n  transform: translateX(-50%);\n  z-index: 3;\n  padding: 5px 9px;\n  border-radius: var(--radius-sm);\n  border: 1px solid var(--color-border);\n  background: var(--color-bg-elevated);\n  color: var(--color-text);\n  box-shadow: var(--shadow-md);\n  font-size: 0.857rem;\n  line-height: 1.4;\n  white-space: nowrap;\n}\nspan.dc-tip--below, div.dc-tip--below { bottom: auto; top: calc(100% + 6px); }\n\n.dc-tip-box { fill: var(--color-bg-elevated); stroke: var(--color-border); }\n.dc-tip-text { fill: var(--color-text); font-size: 11px; font-family: var(--font-family); }\n\n/* Free feedback on the two things a pointer lands on most \u2014 no class to remember. */\n.dc-table tbody tr:hover td { background: var(--color-bg-tertiary); }\n.dc-bar:hover .dc-bar-track { background: var(--color-border); }\n\n/* \u2550\u2550\u2550 Media \u2550\u2550\u2550 */\n\n.dc-img { max-width: 100%; border-radius: var(--radius-md); display: block; }\n.dc-figcaption { font-size: 0.857rem; color: var(--color-text-tertiary); margin-top: 5px; }\n\n/* \u2550\u2550\u2550 Chart colors \u2014 the ONLY palette. Never a hardcoded hex: these follow the\n     theme and the user's brand override. Use on SVG (fill/stroke) or a div. \u2550\u2550\u2550 */\n\n.dc-f1 { fill: var(--chart-1); } .dc-f2 { fill: var(--chart-2); } .dc-f3 { fill: var(--chart-3); } .dc-f4 { fill: var(--chart-4); }\n.dc-f5 { fill: var(--chart-5); } .dc-f6 { fill: var(--chart-6); } .dc-f7 { fill: var(--chart-7); } .dc-f8 { fill: var(--chart-8); }\n.dc-s1 { stroke: var(--chart-1); } .dc-s2 { stroke: var(--chart-2); } .dc-s3 { stroke: var(--chart-3); } .dc-s4 { stroke: var(--chart-4); }\n.dc-s5 { stroke: var(--chart-5); } .dc-s6 { stroke: var(--chart-6); } .dc-s7 { stroke: var(--chart-7); } .dc-s8 { stroke: var(--chart-8); }\n.dc-bg1 { background: var(--chart-1); } .dc-bg2 { background: var(--chart-2); } .dc-bg3 { background: var(--chart-3); } .dc-bg4 { background: var(--chart-4); }\n.dc-bg5 { background: var(--chart-5); } .dc-bg6 { background: var(--chart-6); } .dc-bg7 { background: var(--chart-7); } .dc-bg8 { background: var(--chart-8); }\n.dc-svg { width: 100%; height: auto; display: block; overflow: visible; }\n.dc-axis { stroke: var(--color-border); stroke-width: 1; }\n.dc-gridline { stroke: var(--color-border); stroke-width: 1; opacity: 0.55; }\n/* SVG text scales with the viewBox \u2014 a 320-wide viewBox stretched to 960px renders this\n   at ~30px, not 10px. Prefer .dc-axis-row BELOW the svg for labels; reach for this only\n   when a label must sit at a coordinate, and then size the viewBox near the real render\n   width (~900) so one user unit is about one pixel. */\n.dc-axis-text { fill: var(--color-text-tertiary); font-size: 10px; font-family: var(--font-family); }\n/* Axis labels as HTML, outside the svg \u2014 never scaled, always legible. */\n.dc-axis-row { display: flex; justify-content: space-between; font-size: 0.786rem; color: var(--color-text-tertiary); margin-top: 4px; }\n.dc-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 0.857rem; color: var(--color-text-secondary); }\n.dc-legend-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-right: 5px; vertical-align: -1px; }\n\n/* \u2550\u2550\u2550 Honesty helpers \u2014 the same words the native renders use \u2550\u2550\u2550 */\n\n.dc-low-sample { opacity: 0.45; }\n.dc-empty { color: var(--color-text-tertiary); font-size: 0.929rem; padding: 24px 0; text-align: center; }\n\n/* \u2550\u2550\u2550 Slides \u2014 a presentation, only in the fullscreen overlay.\n     Inline in the transcript a slide is just a padded section (a viewport-height\n     slide would make the auto-height measurement chase the frame it is setting);\n     in fullscreen the host sets data-dc-mode=\"full\" and they become real pages. \u2550\u2550\u2550 */\n\n/* Block inline, for the same reason every other prose container is (see .dc-doc). It\n   becomes a flex column only in fullscreen, where `justify-content: center` needs one and\n   a slide is a composed page rather than a paragraph. */\n.dc-slide { padding: 20px 0; }\nhtml[data-dc-mode=\"full\"] .dc-slides { scroll-snap-type: y mandatory; }\nhtml[data-dc-mode=\"full\"] .dc-slide {\n  display: flex;\n  flex-direction: column;\n  gap: 16px;\n  min-height: calc(100vh - 40px);\n  justify-content: center;\n  scroll-snap-align: start;\n  padding: 40px 0;\n}\nhtml[data-dc-mode=\"full\"] .dc-slide .dc-h1 { font-size: 2.857rem; }\nhtml[data-dc-mode=\"full\"] .dc-slide .dc-h2 { font-size: 1.857rem; }\nhtml[data-dc-mode=\"full\"] .dc-slide .dc-value { font-size: 3.714rem; }\n/* Fullscreen reads a notch larger \u2014 derived from the same root, not a second constant, so\n   the zoom control still moves both modes together. */\nhtml[data-dc-mode=\"full\"] { font-size: calc(var(--chat-text, 14px) * 1.07); }\n\n/* \u2550\u2550\u2550 Narrow panes \u2014 the block's width is the PANE's, and the pane is not a window.\n     A `dc-grid--4` of stat tiles at 380px gives each column ~80px, and a 2rem `.dc-value`\n     does not fit in 80px: it clips mid-digit (\"190.313\" rendered as \"190.31\" \u2014 owner\n     screenshot 2026-09-02). Wrapping the number instead would be worse, so the COLUMNS\n     give way. The container is the body, so this tracks the real pane width including the\n     slide-over, not the window's. \u2550\u2550\u2550 */\n\n@container (max-width: 640px) {\n  .dc-grid--4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n}\n@container (max-width: 520px) {\n  .dc-grid--3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n}\n@container (max-width: 340px) {\n  .dc-grid--2, .dc-grid--3, .dc-grid--4 { grid-template-columns: minmax(0, 1fr); }\n}\n\n/* \u2550\u2550\u2550 THE DOCUMENT RHYTHM \u2014 deliberately the LAST thing in this stylesheet \u2550\u2550\u2550\n\n   These replace the `gap` the prose containers used to get from being flex columns (see\n   .dc-doc for why they no longer are). They live here, at the bottom, for a reason that\n   cost a round to find: `.dc-doc > * + *` and `.dc-p` have the SAME specificity (0,1,0),\n   so whichever is written later wins \u2014 and almost every text class in this kit sets\n   `margin: 0`. Declared next to their container, these rules were silently overridden and\n   the whole document collapsed to zero spacing. Last means last. \u2550\u2550\u2550 */\n\n.dc-doc > * + * { margin-top: 14px; }\n.dc-doc--tight > * + * { margin-top: 8px; }\n.dc-doc--airy > * + * { margin-top: 22px; }\n.dc-stack > * + * { margin-top: 10px; }\n.dc-card > * + * { margin-top: 8px; }\n.dc-option > * + * { margin-top: 8px; }\n.dc-stat > * + * { margin-top: 3px; }\n\n/* \u2500\u2500 A TILE'S PARTS ARE LINES, whatever element the author reached for \u2500\u2500\n   The rhythm above spaces children with `margin-top`, which does nothing to an INLINE box \u2014\n   so a stat tile written with `<span>`s ran its value, label and note together as one\n   unreadable line: \"124/124verify:chat-htmlyeni check: \u2026\" (owner screenshot, 2026-09-02).\n   Same root as the flex-column sentence bug at the top of this file, arrived at from the\n   other side: there, block children were wrongly made flex items; here, inline children\n   were never made blocks.\n\n   These class names only ever mean \"this line of the tile/card\", so blockifying them cannot\n   break a legitimate use. `.dc-value` is deliberately NOT in that list \u2014 a figure is also\n   written mid-sentence \u2014 so it is blocked only where it HEADS a tile. */\n.dc-stat-label, .dc-stat-note,\n.dc-card-title, .dc-card-sub,\n.dc-tl-when, .dc-caption, .dc-figcaption { display: block; }\n.dc-stat > .dc-value, .dc-card > .dc-value { display: block; }\n.dc-step-body > * + * { margin-top: 2px; }\n.dc-tl-body > * + * { margin-top: 2px; }\n.dc-slide > * + * { margin-top: 16px; }\n/* Fullscreen slides go back to being a flex column (for vertical centring), where `gap`\n   does the spacing \u2014 so the margin would double it. */\nhtml[data-dc-mode=\"full\"] .dc-slide > * + * { margin-top: 0; }\n\n@media (prefers-reduced-motion: reduce) {\n  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }\n}\n";

/**
 * The tokens resolved into the srcdoc. A superset of the Lab's list: this surface has
 * headings (display face), elevated cards (`--radius-xl`, `--shadow-lg`) and prose.
 */
export const CHAT_KIT_TOKENS: readonly string[] = [
  '--chart-1', '--chart-2', '--chart-3', '--chart-4',
  '--chart-5', '--chart-6', '--chart-7', '--chart-8',
  '--color-bg', '--color-bg-secondary', '--color-bg-tertiary', '--color-bg-elevated',
  '--color-border', '--color-border-hover',
  '--color-text', '--color-text-secondary', '--color-text-tertiary',
  '--color-accent', '--color-accent-soft', '--color-accent-text',
  // The highlighter pen `.dc-mark` inks itself with — without these the stroke resolves
  // to nothing inside the frame and a marked phrase loses its mark entirely.
  '--color-highlight', '--color-highlight-edge',
  '--color-success', '--color-success-subtle',
  '--color-error', '--color-error-subtle',
  '--color-warning',
  '--font-family', '--font-family-display', '--font-mono',
  // The app's body TRACKING. Without it a block is set at 0 while the column around it
  // is set at -0.26px — 8.6px over a 33-character line, which is most of what was left
  // of the face mismatch after the webfont started travelling (F5, measured).
  '--letter-spacing-body',
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl',
  '--shadow-sm', '--shadow-md', '--shadow-lg',
];

/**
 * The transcript's reading size and rhythm. Listed apart from `CHAT_KIT_TOKENS` because
 * they resolve somewhere else: every token above is declared on `:root`, but these two live
 * on `.chat-pane` (ChatPane.css) — reading them off `documentElement` returns nothing, and
 * the kit falls back to the 14px/1.55 it is not supposed to use any more.
 */
export const CHAT_READING_TOKENS: readonly string[] = ['--chat-text', '--chat-line-height'];

/**
 * Read the current computed value of every chat-kit token off the live document.
 *
 * `scope` is the element the READING tokens are resolved from — any node inside the chat
 * pane. Omit it and those two are simply absent, which is the correct answer for a host
 * that has no chat pane (a Meeting Room embed): the kit's px fallbacks stand in.
 */
export function resolveChatKitTokens(scope?: Element | null): Record<string, string> {
  const tokens = resolveTokens(CHAT_KIT_TOKENS);
  if (!scope) return tokens;
  const styles = getComputedStyle(scope);
  for (const token of CHAT_READING_TOKENS) {
    const value = styles.getPropertyValue(token).trim();
    if (value) tokens[token] = value;
  }
  return tokens;
}

/** The message key the bridge posts under. Namespaced so an unrelated `postMessage`
 *  (a dev-tool, an extension) can never be read as a height. */
export const HEIGHT_MESSAGE_KEY = '__dreamHtmlHeight';

/**
 * The key the HOST asks under — the return leg, and the reason a block can no longer be
 * stuck at 40px forever.
 *
 * The bridge used to be fire-and-forget: one report, deduped against the last value, with
 * nothing on either side checking it arrived. It only had to be missed ONCE — the host's
 * `message` listener attaching a beat after the frame's document had already parsed and
 * spoken — and the block was frozen at its floor for the rest of the session, because the
 * body never changes size again and a deduped bridge has nothing more to say. Delivery you
 * cannot retry is delivery you cannot trust.
 */
export const HEIGHT_REQUEST_KEY = '__dreamHtmlMeasure';

/**
 * The EXPORT leg: the host asks (`SNAPSHOT_REQUEST_KEY`), the frame answers with its own
 * body markup and current size (`SNAPSHOT_MESSAGE_KEY`).
 *
 * WHY THE FRAME AND NOT THE HOST. The host still has the html it injected, but that is the
 * BEFORE picture: the block's own inline script may have filled a number in, and the reader
 * may have switched a `dc-tab` or opened a detail. Exporting the injected string would hand
 * back a file of something the user is not looking at. Only the frame can see what is
 * actually on screen — and the sandbox is precisely why nothing else can.
 *
 * WHY IT LEAKS NOTHING. The frame returns markup DERIVED FROM WHAT THE HOST GAVE IT, plus
 * whatever its own script computed from that same markup. It has no same-origin handle, no
 * network (CSP `default-src 'none'`), and no other source of data — there is nothing in
 * that document the host did not put there. The bridge's honest bound is unchanged: it
 * carries the block's own content, never the app's.
 */
export const SNAPSHOT_REQUEST_KEY = '__dreamHtmlSnapshotPlease';
export const SNAPSHOT_MESSAGE_KEY = '__dreamHtmlSnapshot';

/** Refuse a snapshot larger than this. A runaway body should fail the export with a
 *  message, not wedge the host serializing a 50MB string into a data: URL. */
export const MAX_SNAPSHOT_CHARS = 2_000_000;

/** Floor and ceiling for a reported height. The floor keeps a still-empty document from
 *  collapsing to a 0px sliver; the ceiling is the backstop against a runaway layout (a
 *  `height: 100%` child chasing the frame the measurement is setting) turning into an
 *  endlessly growing iframe. Both are clamps, not errors — the content still renders. */
export const MIN_HTML_HEIGHT = 40;
export const MAX_HTML_HEIGHT = 20000;

/**
 * The height a block occupies BEFORE its first measurement lands — and, not coincidentally,
 * the floor of the placeholder that held the slot while the markup was still streaming.
 *
 * One number for both, because they are the same box a fraction of a second apart. Mounting
 * the frame at `MIN_HTML_HEIGHT` instead (the old behaviour) made every block arrive as a
 * 40px sliver that then jumped to its real height: the placeholder collapsed, the card
 * snapped open, and everything below it moved twice. Starting where the placeholder ended
 * means the frame only ever GROWS from here, and the `transition: height` in HtmlView.css
 * animates that growth.
 *
 * Deliberately NOT the measured floor: a genuinely tiny block is still allowed to settle at
 * `MIN_HTML_HEIGHT` once it has actually reported a size.
 */
export const HTML_PENDING_HEIGHT = 96;

/**
 * The one channel out of the sandbox: the body's own height, as a number, to the parent —
 * volunteered when it changes, and re-sent on demand when the host says it never heard it.
 *
 * It measures `document.body` (not `documentElement`) on purpose. The html element is
 * stretched to the iframe's own height by the viewport, so measuring it would report back
 * the height we just set — a loop that only ever grows. The body's border box is the
 * content, and the kit pins `html, body { height: auto }` so it stays that way.
 *
 * IT RIDES IN THE HEAD, and starts on `DOMContentLoaded`. Appended after the body it was at
 * the mercy of the markup it was measuring: one author writing `<\/script>` inside their own
 * inline script leaves that element unclosed, and everything below it — this — becomes
 * script text that never runs. A head script has already run before the body is parsed, and
 * `DOMContentLoaded` fires even when the parser had to close an unclosed element at EOF.
 *
 * THE HOST MAY ASK AGAIN, and the answer to a request is FORCED past the dedupe. That is
 * the difference between a report and a delivery: the body does not change size after it
 * settles, so a deduped bridge would answer every retry with silence, and a single missed
 * message would leave the frame at its 40px floor permanently.
 *
 * `'*'` as the target origin is correct here and not a shortcut: a sandboxed frame without
 * `allow-same-origin` has the opaque origin "null", so it cannot name the parent's origin,
 * and the parent cannot verify one either. The host therefore authenticates by SOURCE —
 * `event.source === iframe.contentWindow` — which an unrelated frame cannot forge, and this
 * side answers only its own parent. The payload is a single number, so there is nothing
 * here to leak in the first place.
 */
export const HEIGHT_BRIDGE = `(function () {
  var last = -1;
  function report(force) {
    if (!document.body) return;
    var h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h === last && !force) return;
    last = h;
    parent.postMessage({ ${HEIGHT_MESSAGE_KEY}: h }, '*');
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent || !event.data) return;
    if (event.data.${HEIGHT_REQUEST_KEY} === true) report(true);
    if (event.data.${SNAPSHOT_REQUEST_KEY} === true) {
      // The body AS IT STANDS — after the author's script ran, after the reader clicked.
      var b = document.body;
      var r = b ? b.getBoundingClientRect() : null;
      parent.postMessage({ ${SNAPSHOT_MESSAGE_KEY}: {
        html: b ? b.innerHTML : '',
        width: r ? Math.ceil(r.width) : 0,
        height: r ? Math.ceil(r.height) : 0,
      } }, '*');
    }
  });
  function start() {
    if (window.ResizeObserver) new ResizeObserver(function () { report(false); }).observe(document.body);
    document.addEventListener('click', function () { setTimeout(function () { report(false); }, 0); }, true);
    report(true);
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
  // A late web font or an image finishing decode changes the height after the observer's
  // first callback, so the load event is a second chance rather than a duplicate.
  window.addEventListener('load', function () { report(false); });
})();`;

/**
 * The kit's OWN behaviour, so an author does not have to write it: clicking a `.dc-tab`
 * opens the matching `.dc-panel`.
 *
 * WHY THE HOST OWNS THIS (owner screenshot, 2026-09-02). The briefing tells the agent
 * "`dc-tabs` … need none" — no script — and the kit's tabs were CSS-only in a very
 * particular sense: they needed a hidden `<input type="radio">` per panel, and the tab had
 * to be a `<label for>`. Write the obvious thing instead — a `<button class="dc-tab">` —
 * and there were no radios to check, so every `.dc-panel` stayed `display: none`. The
 * reader got a tab bar over an empty box with two panels of real content inside it.
 *
 * Two ways out of that: teach every agent an unusual pattern, or make the obvious markup
 * work. This is the second. It costs ~20 lines in the head, the radio form keeps working
 * untouched (a tab that HAS a radio just checks it and lets the CSS do the rest), and the
 * kit's "a panel is never invisible by default" rule covers the case where neither is
 * present.
 *
 * It stays inside the block: one delegated listener, no network, no parent access, no
 * `postMessage`. Everything it touches is markup the agent already wrote — the same
 * boundary the author's own inline script has. It is also inlined into an EXPORTED file
 * (`buildStandaloneHtml`), because a tabbed block that stopped switching the moment it left
 * the app would not be "exactly what the block rendered".
 *
 * `data-panel="<id>"` is honoured when the author wrote one; otherwise position decides,
 * which is the forgiving default — tab 3 opens panel 3.
 */
export const KIT_BEHAVIOUR = `(function () {
  document.addEventListener('click', function (event) {
    var target = event.target;
    var tab = target && target.closest ? target.closest('.dc-tab') : null;
    if (!tab) return;
    var tabs = tab.closest('.dc-tabs');
    var list = tab.closest('.dc-tablist');
    if (!tabs || !list) return;
    var all = [].slice.call(list.querySelectorAll('.dc-tab'));
    var i = all.indexOf(tab);
    if (i < 0) return;
    // The radio form: let the CSS keep owning it, so scripting-off behaviour is identical.
    var radios = [].slice.call(tabs.querySelectorAll('input[type="radio"]'));
    if (radios[i]) { radios[i].checked = true; return; }
    var panels = [].slice.call(tabs.querySelectorAll('.dc-panels > .dc-panel'));
    var named = tab.getAttribute('data-panel');
    var wanted = named ? tabs.querySelector('.dc-panels > .dc-panel#' + named) : null;
    all.forEach(function (t, n) { t.classList.toggle('dc-tab--on', n === i); });
    panels.forEach(function (panel, n) {
      panel.classList.toggle('dc-panel--on', wanted ? panel === wanted : n === i);
    });
  });
})();`;

export interface ChatSrcdocInput {
  html: string;
  tokens: Record<string, string>;
  scheme?: 'light' | 'dark';
  /** The vault's `_dream_context/overrides/chat-html-kit.css`, when it has one. */
  overrideCss?: string;
  /**
   * "card" inline in the transcript, "full" in the presentation overlay. Only `.dc-slide`
   * reads it. The bridge is injected in both: in fullscreen the host ignores the height
   * (it owns it), but the export bar in that header needs the bridge's snapshot leg.
   */
  mode?: 'card' | 'full';
  /**
   * The app's locale, onto the srcdoc's `<html lang>`. Not cosmetic: `text-transform:
   * uppercase` is LOCALE-SENSITIVE, and without a lang the frame casts Turkish with the
   * English rules — `.dc-label` turned "değiştiriyor" into "DEĞIŞTIRIYOR", dotless, which
   * is a different word (owner screenshot 2026-09-02). Also what a screen reader picks its
   * voice from.
   */
  lang?: string;
}

/** The complete srcdoc for a `dream-html` block. */
export function buildChatSrcdoc(input: ChatSrcdocInput): string {
  const { html, tokens, scheme = 'light', overrideCss, mode = 'card', lang } = input;
  const doc = buildSandboxSrcdoc({
    html,
    css: CHAT_HTML_KIT_CSS,
    tokens,
    scheme,
    overrideCss,
    // BOTH modes now. The bridge's height leg still only matters inline (the fullscreen
    // host owns the height, and its listener returns early), but its SNAPSHOT leg is what
    // the export bar talks to — and that bar lives in the fullscreen header.
    headScript: `${HEIGHT_BRIDGE}
${KIT_BEHAVIOUR}`,
  });
  // The mode rides on <html> so the kit's `html[data-dc-mode="full"]` slide rules can see
  // it, and the locale rides beside it (see ChatSrcdocInput.lang). Written here rather than
  // in the shared builder: both are this surface's concepts.
  const langAttr = lang ? ` lang="${lang.replace(/[^a-zA-Z0-9-]/g, '')}"` : '';
  return doc.replace('<!doctype html><html>', `<!doctype html><html${langAttr} data-dc-mode="${mode}">`);
}

/** The kit classes that MEAN "this is a title". Deliberately narrow: a placeholder that
 *  echoed every `dc-p` would be the half-drawn layout this design rejected, in text form. */
const OUTLINE_CLASS_RE = /\bdc-(?:h[123]|card-title|option-title|stat-label|tab)\b/;
/** Any opening tag carrying a class attribute. Matching the OPENING tag only — and stepping
 *  the scan past just that tag — is load-bearing: a regex that also demanded the matching
 *  close tag would swallow the wrapper `<div class="dc-doc">…</div>` whole on its first
 *  match and never see a single title inside it. */
const OUTLINE_OPEN_RE = /<([a-z][a-z0-9]*)\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>/gi;
/** How many title lines a placeholder shows before it stops growing. Past this it is no
 *  longer a hint that something is being drawn, it is a second copy of the answer. */
const OUTLINE_MAX = 6;
const OUTLINE_MAX_CHARS = 80;
const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'",
};

/** A title element's text, or null while it is still being written. */
function outlineText(partial: string, tag: string, from: number): string | null {
  const close = partial.toLowerCase().indexOf(`</${tag.toLowerCase()}`, from);
  // Not closed yet — so not shown. The whole argument against drawing partial markup,
  // applied to its placeholder: half a heading is noise, not progress.
  if (close === -1) return null;
  const text = partial.slice(from, close)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_m, e: string) => ENTITIES[e] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > OUTLINE_MAX_CHARS ? `${text.slice(0, OUTLINE_MAX_CHARS - 1)}…` : text;
}

/**
 * The titles already written into a still-streaming `dream-html` body, in order.
 *
 * This is what turns dead air into legible work. A 2KB block is ~600 tokens, so the reader
 * spends 10-20 seconds watching a placeholder; one that merely pulses says only "wait",
 * while one that fills in "Two ways to ship this" and then "Behind a flag" says WHAT is
 * being drawn — without ever showing a half-drawn layout, which was the reason the live
 * progressive iframe was rejected in favour of this.
 *
 * Returns plain text. The caller renders it as TEXT through React, never as innerHTML: this
 * is unsanitized agent markup, and the iframe sandbox that makes the real block safe is not
 * in play for a placeholder living in the host document.
 */
export function htmlOutline(partial: string): string[] {
  if (!partial) return [];
  const out: string[] = [];
  OUTLINE_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OUTLINE_OPEN_RE.exec(partial)) !== null) {
    if (!OUTLINE_CLASS_RE.test(m[2])) continue;
    const text = outlineText(partial, m[1], OUTLINE_OPEN_RE.lastIndex);
    if (text) out.push(text);
    if (out.length >= OUTLINE_MAX) break;
  }
  return out;
}

/** The frame's own picture of itself, or null when the payload is not one. */
export interface HtmlSnapshot { html: string; width: number; height: number }

export function readSnapshotMessage(data: unknown): HtmlSnapshot | null {
  if (!data || typeof data !== 'object') return null;
  const raw = (data as Record<string, unknown>)[SNAPSHOT_MESSAGE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const { html, width, height } = raw as Record<string, unknown>;
  if (typeof html !== 'string' || html.length > MAX_SNAPSHOT_CHARS) return null;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { html, width: Math.ceil(width), height: Math.ceil(height) };
}

/** A height off the wire, or null when it is not a number we should act on. */
export function readHeightMessage(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const raw = (data as Record<string, unknown>)[HEIGHT_MESSAGE_KEY];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(MAX_HTML_HEIGHT, Math.max(MIN_HTML_HEIGHT, Math.ceil(raw)));
}
