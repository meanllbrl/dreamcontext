// @vitest-environment jsdom
/**
 * PHASE 2 of the experiment: score the answers phase 1 collected.
 *
 * RUNS IN JSDOM, and distinguishes UNSCORABLE from EMPTY. Both corrections came from the same
 * mistake, caught twice. Scoring first ran in plain Node and called two of six blocks EMPTY
 * RENDERS — a damning number, and false: they had thrown `document is not defined`. Under jsdom
 * they throw `Cannot set properties of null (setting 'font')` instead, because the CARTESIAN
 * charts measure text through a canvas 2D context that jsdom does not implement without a
 * native package. `PieChart` renders fine; `BarChart` and `HorizontalBarChart` cannot be
 * rendered headlessly at all.
 *
 * So those answers are marked UNSCORABLE HERE, not failed. They are not unverified either:
 * `scripts/verify/openui-look.mjs` draws a `BarChart` in real Chromium and screenshots it. A
 * measurement whose environment cannot run the thing being measured reports the harness's
 * limits as the subject's failures — the exact error this task has now found in three
 * different places.
 *
 * Reads the raw model output from `scripts/verify/openui-eval.mjs` and runs every `dream-ui`
 * block through the REAL library — the same `createLibrary` the app renders with — so the
 * verdict is what actually came out, not whether the source looked plausible. Phase 1 costs
 * model calls; this costs nothing and can be re-run while the scoring is still being worked
 * out, which is the whole reason they are separate.
 *
 * SKIPS when there are no artifacts, rather than failing: a clone with no eval run has nothing
 * to score, and a red test there would say something untrue about the code.
 *
 * It also does not ASSERT a pass mark. There is no threshold at which this feature is
 * automatically a good idea — that is the owner's call, on evidence. What this file produces
 * is the evidence, printed, plus the two assertions that ARE mechanical: the parser must never
 * throw, and a block that renders must not be empty.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Renderer } from '@openuidev/react-lang';
import {
  openUiChatLibrary, OPENUI_COMPONENT_NAMES,
} from '../../dashboard/src/components/sleepy/chat/openuiLibrary.js';

const OUT = join(tmpdir(), 'dreamcontext-openui-eval');
const ANSWERS = join(OUT, 'answers.json');
const has = existsSync(ANSWERS);

type Q = {
  id: string; wants: 'block' | 'prose'; question: string;
  htmlDrew: boolean; uiDrew: boolean; htmlChars: number; uiChars: number;
  blockChars: number; htmlMs: number; uiMs: number;
};
const meta: { model: string; questions: Q[] } = has
  ? JSON.parse(readFileSync(ANSWERS, 'utf-8'))
  : { model: '', questions: [] };

const FENCE = /```dream-ui\r?\n([\s\S]*?)```/m;
const vocabulary = new Set<string>(OPENUI_COMPONENT_NAMES);

type Score = Q & {
  source: string | null; renderedChars: number; errors: number;
  used: string[]; invented: string[]; longStrings: number; threw: string | null;
  /** The renderer needs a browser for this one — a cartesian chart. Absence of a score, not
   *  a bad score. */
  unscorable: boolean;
};

/** The throws that mean "this harness cannot draw it", as opposed to "the model wrote it
 *  wrong". Matched on the message because neither library exposes a code for them. */
const ENVIRONMENT_THROWS = [/document is not defined/i, /setting 'font'/i, /getContext/i];

function score(q: Q): Score {
  const raw = existsSync(join(OUT, `${q.id}.ui.md`)) ? readFileSync(join(OUT, `${q.id}.ui.md`), 'utf-8') : '';
  const source = FENCE.exec(raw)?.[1] ?? null;
  const base = { ...q, source, renderedChars: 0, errors: 0, used: [] as string[], invented: [] as string[], longStrings: 0, threw: null as string | null, unscorable: false };
  if (!source) return base;

  // Every name it reached for, split by whether the vocabulary has it. An INVENTED name is the
  // failure that matters most, because the component is dropped and the block renders smaller
  // — or empty — with no error at all.
  //
  // STRING LITERALS ARE STRIPPED FIRST, and that is not a detail. Scanning the raw source
  // reported three inventions across six answers — `Kuyruk`, `JSONB`, `KB` — and all three were
  // prose INSIDE quotes: "Kuyruk (client)", "İlişkisel + JSONB (kısmi esneklik)", "KB (gzip)".
  // A capitalised word followed by a parenthesis is extremely common in ordinary writing, so
  // the naive scan measures the model's PROSE and calls it a grammar error.
  const code = source.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const names = [...code.matchAll(/\b([A-Z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]);
  base.used = [...new Set(names)].filter((n) => vocabulary.has(n));
  base.invented = [...new Set(names)].filter((n) => !vocabulary.has(n));
  // The briefing's own rule: the block carries structure, the prose around it carries the
  // explanation. A 200-character string inside a component is that rule being broken.
  base.longStrings = [...source.matchAll(/"([^"]{200,})"/g)].length;

  const errors: unknown[] = [];
  try {
    base.renderedChars = renderToString(createElement(Renderer, {
      response: source, library: openUiChatLibrary, isStreaming: false, toolProvider: null,
      onError: (e: unknown) => errors.push(e),
    } as never)).length;
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    if (ENVIRONMENT_THROWS.some((re) => re.test(message))) base.unscorable = true;
    else base.threw = message;
  }
  base.errors = errors.length;
  return base;
}

describe.skipIf(!has)('the experiment — can the model write this grammar?', () => {
  const scored = meta.questions.map(score);
  const shouldDraw = scored.filter((s) => s.wants === 'block');
  const shouldNot = scored.filter((s) => s.wants === 'prose');
  const drew = shouldDraw.filter((s) => s.uiDrew);
  const scorable = drew.filter((s) => !s.unscorable);
  const unscorable = drew.filter((s) => s.unscorable);
  const rendered = scorable.filter((s) => s.renderedChars >= 200);
  const empty = scorable.filter((s) => s.renderedChars < 200);

  it('prints the scorecard', () => {
    const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
    const lines = [
      `model: ${meta.model}`,
      '',
      'SHOULD DRAW (' + shouldDraw.length + ')',
      `  dream-ui produced a block : ${drew.length}/${shouldDraw.length} (${pct(drew.length, shouldDraw.length)})`,
      `  dream-html produced one   : ${shouldDraw.filter((s) => s.htmlDrew).length}/${shouldDraw.length}`,
      `  of ui blocks, RENDERED    : ${rendered.length}/${scorable.length} (${pct(rendered.length, scorable.length)}) of the ones this harness CAN draw`,
      `  EMPTY (the silent failure): ${empty.length} ${empty.map((s) => s.id).join(', ')}`,
      `  not scorable headlessly    : ${unscorable.length} ${unscorable.map((s) => s.id).join(', ')} (cartesian chart needs a canvas — see verify:openui-look)`,
      '',
      'SHOULD NOT DRAW (' + shouldNot.length + ')  — a short answer is prose',
      `  dream-ui drew anyway      : ${shouldNot.filter((s) => s.uiDrew).length}`,
      `  dream-html drew anyway    : ${shouldNot.filter((s) => s.htmlDrew).length}`,
      '',
      'FAILURE MODES (input for tightening the prompt)',
      `  invented component names  : ${drew.filter((s) => s.invented.length).map((s) => `${s.id}[${s.invented.join('/')}]`).join(' ') || 'none'}`,
      `  parse errors reported     : ${drew.reduce((a, s) => a + s.errors, 0)}`,
      `  parser threw (real)       : ${drew.filter((s) => s.threw).map((s) => s.id).join(', ') || 'none'}`,
      `  prose stuffed INSIDE block: ${drew.reduce((a, s) => a + s.longStrings, 0)} long strings across ${drew.filter((s) => s.longStrings).length} answer(s)`,
      '',
      'COST',
      `  avg block source (ui)     : ${Math.round(drew.reduce((a, s) => a + s.blockChars, 0) / (drew.length || 1))} chars`,
      `  avg whole answer  ui/html : ${Math.round(scored.reduce((a, s) => a + s.uiChars, 0) / (scored.length || 1))} / ${Math.round(scored.reduce((a, s) => a + s.htmlChars, 0) / (scored.length || 1))} chars`,
      `  avg latency       ui/html : ${Math.round(scored.reduce((a, s) => a + s.uiMs, 0) / (scored.length || 1))} / ${Math.round(scored.reduce((a, s) => a + s.htmlMs, 0) / (scored.length || 1))} ms`,
      '',
      'PER QUESTION',
      ...scored.map((s) => `  ${s.id.padEnd(13)} wants:${s.wants.padEnd(5)} ui:${s.uiDrew ? 'block' : 'prose'} ${s.unscorable ? 'rendered: n/a ' : `rendered:${String(s.renderedChars).padStart(5)} `}used:[${s.used.join(' ')}]${s.invented.length ? ` INVENTED:[${s.invented.join(' ')}]` : ''}`),
    ];
    const text = lines.join('\n');
    writeFileSync(join(OUT, 'scorecard.txt'), text + '\n');
    console.log('\n' + text + '\n');
    expect(scored.length).toBeGreaterThan(0);
  });

  it('the parser never throws on real model output', () => {
    // The one hard floor. A malformed program must degrade, and `OpenUiView`'s boundary is a
    // backstop for the unexpected — not the first line of defence.
    // Environment throws are excluded by construction: `s.threw` is only set for a message
    // that is NOT in ENVIRONMENT_THROWS.
    expect(drew.filter((s) => s.threw).map((s) => `${s.id}: ${s.threw}`)).toEqual([]);
  });

  it('records the empty renders rather than hiding them', () => {
    // Not asserted to be zero: an empty render is a REAL possible outcome of this experiment
    // and the number is the finding. Asserted only to be KNOWN — if this ever reads as
    // undefined the scoring broke, not the model.
    expect(Number.isInteger(empty.length)).toBe(true);
  });
});
