/**
 * THE EXPERIMENT. Can the model actually write this grammar?
 *
 * Every other wave measured OUR code. This one measures the thing the whole flag exists to
 * find out, and it is the one question none of the engineering could answer: OpenUI's pitch is
 * built on models tuned for openui-lang, and ours has never seen it — it gets a system prompt
 * and nothing else. A grammar the model writes wrongly is worse than no feature, because the
 * failure is SILENT: a program can parse cleanly and resolve to nothing at all.
 *
 * Method. The same questions go to the same model twice, once under each briefing. The
 * `dream-ui` answers are then run through the REAL library — the same `createLibrary` the app
 * renders with — and scored on what actually came out, not on whether the text looked
 * plausible. The `dream-html` answers are the control: they establish that the question was
 * one a block SHOULD answer, so a mode that drew nothing can be told apart from a question
 * that deserved prose.
 *
 * Not scored here, deliberately: whether the result reads well. That is the owner's call and
 * no harness can stand in for it. What this produces is the evidence they judge on.
 *
 * TWO PHASES, on purpose. This file is PHASE 1: it only asks the model and writes the raw
 * answers to disk. Scoring lives in `tests/unit/openui-eval-score.test.ts`, which reads those
 * files and runs them through the real library.
 *
 * The split is not tidiness. Phase 1 costs real model calls and takes minutes; phase 2 is free
 * and is the part that changes while you are working out what to measure. Rerunning the
 * scoring against answers already on disk is what makes the measurement honest to iterate on —
 * and it keeps a five-minute blocking subprocess out of the TS loader, which closes its dev
 * server underneath one (observed, 2026-09-05).
 *
 * Usage: node scripts/verify/openui-eval.mjs [--model <id>] [--only <n>]
 *   then: npx vitest run tests/unit/openui-eval-score.test.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = join(tmpdir(), 'dreamcontext-openui-eval');
mkdirSync(OUT, { recursive: true });

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const MODEL = arg('--model', 'claude-sonnet-5');
const ONLY = Number(arg('--only', '0'));

/**
 * Eight questions, chosen to span what this surface is actually asked and to include the two
 * cases where drawing is WRONG. `wants: 'block'` means a good answer draws; `wants: 'prose'`
 * means a good answer does not, and drawing anyway is the failure.
 */
const QUESTIONS = [
  { id: 'architecture', wants: 'block', q: 'Bir sohbet uygulamasında mesaj gönderme akışını kısaca anlat: composer, kuyruk, sunucu, model, transcript.' },
  { id: 'tradeoff', wants: 'block', q: 'Postgres mi MongoDB mi? Bir analitik ürünü için iki seçeneği karşılaştır ve birini öner.' },
  { id: 'numbers', wants: 'block', q: 'Şu aylık kayıtları göster ve yorumla: Ocak 120, Şubat 190, Mart 240, Nisan 210, Mayıs 305.' },
  { id: 'plan', wants: 'block', q: 'Bir mobil uygulamayı App Store\'a çıkarmak için sırayla ne yapılır? Adımları ver.' },
  { id: 'share', wants: 'block', q: 'Trafik kaynaklarımız: organik 45, reklam 30, referans 15, direkt 10. Payları göster.' },
  { id: 'table', wants: 'block', q: 'Üç JavaScript framework\'ünü bundle boyutu, öğrenme eğrisi ve topluluk büyüklüğü ile karşılaştır.' },
  { id: 'short', wants: 'prose', q: 'TypeScript\'te `unknown` ile `any` arasındaki fark nedir? Tek cümleyle söyle.' },
  { id: 'yesno', wants: 'prose', q: 'Bir React bileşeninde hook\'u if içine koyabilir miyim?' },
];

const FENCE = (name) => new RegExp('```' + name + '\\r?\\n([\\s\\S]*?)```', 'm');

function ask(question, briefPath) {
  const started = Date.now();
  const r = spawnSync('claude', ['-p', question, '--append-system-prompt-file', briefPath, '--model', MODEL], {
    encoding: 'utf-8', maxBuffer: 1 << 26, timeout: 300_000,
  });
  return { text: (r.stdout || '') + (r.stderr || ''), ms: Date.now() - started };
}

const main = () => {
  const meta = { model: MODEL, at: new Date().toISOString(), questions: [] };
  for (const [i, item] of QUESTIONS.entries()) {
    if (ONLY && i + 1 !== ONLY) continue;
    process.stdout.write(`[${i + 1}/${QUESTIONS.length}] ${item.id} (${item.wants}) … `);

    const html = ask(item.q, '/tmp/brief-html.md');
    const ui = ask(item.q, '/tmp/brief-openui.md');
    writeFileSync(join(OUT, `${item.id}.html.md`), html.text);
    writeFileSync(join(OUT, `${item.id}.ui.md`), ui.text);

    const htmlBlock = FENCE('dream-html').exec(html.text)?.[1] ?? null;
    const uiBlock = FENCE('dream-ui').exec(ui.text)?.[1] ?? null;
    meta.questions.push({
      id: item.id, wants: item.wants, question: item.q,
      htmlDrew: !!htmlBlock, uiDrew: !!uiBlock,
      htmlChars: html.text.length, uiChars: ui.text.length,
      blockChars: uiBlock?.length ?? 0, htmlMs: html.ms, uiMs: ui.ms,
    });
    process.stdout.write(`html:${htmlBlock ? 'block' : 'prose'} ui:${uiBlock ? 'block' : 'prose'}\n`);
  }
  writeFileSync(join(OUT, 'answers.json'), JSON.stringify(meta, null, 2));
  console.log(`\nPhase 1 done — ${meta.questions.length} question(s) in ${OUT}`);
  console.log('Now score them: npx vitest run tests/unit/openui-eval-score.test.ts');
};

main();
