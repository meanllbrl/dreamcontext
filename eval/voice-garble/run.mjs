#!/usr/bin/env node
/**
 * Local eval of the voice garble guard on REAL takes (task sesli-giris-bozuk…, AC10).
 *
 *   node eval/voice-garble/run.mjs <dir-of-takes> [--lexicon-root <brain>] [--out RESULTS.md]
 *
 * <dir> holds `<stamp>.wav` + `<stamp>.json` pairs as the app's old take store kept them. The
 * audio is the owner's voice: it is READ from that directory and never copied into the repo.
 *
 * It starts its own `whisper-server -nlp` on a free port (never the app's :47113), then for each
 * take, oldest first:
 *   • OLD: one `json` pass with the language the old app used (its recorded `language`, with the
 *     old sticky memory replayed), as the app answered before this change;
 *   • NEW: the real ladder (`transcribeWithRetry` from src/, bundled with esbuild), with the take
 *     store in a scratch HOME so the language context builds up the way it would live.
 * It prints and writes per take: verdict, passes, ms, and the text that would be sent.
 */

import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!dir || !existsSync(dir)) {
  console.error('usage: node eval/voice-garble/run.mjs <dir-of-takes> [--lexicon-root <brain>] [--out RESULTS.md]');
  process.exit(2);
}
const lexiconRoot = opt('--lexicon-root');
const outFile = opt('--out') ?? join(here, 'RESULTS.md');

const stamps = [...new Set(readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4)))]
  .filter((s) => existsSync(join(dir, `${s}.json`))).sort();
console.log(`found ${stamps.length} takes in ${dir}`);
if (!stamps.length) process.exit(1);

// ── The code under test, bundled from src/ ─────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'dc-voice-eval-'));
// Bundled INSIDE the repo (its gitignored tmp/), so the bundle's packages resolve from node_modules.
const bundle = join(repo, 'tmp', `voice-eval-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `export { transcribeWithRetry } from './src/server/routes/agent-voice.ts';
export { keepTake } from './src/lib/voice/voiceLog.ts';
export { buildVoiceLexicon } from './src/lib/voice/lexicon.ts';
export { findWhisper, primerFrom, cleanWhisperText } from './src/lib/voice/whisper.ts';`,
    resolveDir: repo, loader: 'ts', sourcefile: 'entry.ts',
  },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle, logLevel: 'error',
});

const install = (await import(bundle)).findWhisper();
if (!install) { console.error('no whisper-server + model on this machine'); process.exit(1); }
// A scratch HOME (after the model was found under the real one): the take store, and so the
// language context, starts empty and builds up take by take.
process.env.HOME = join(scratch, 'home');

// ── Our own server, -nlp, on a free port ──────────────────────────────────────────────
const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const threads = Math.max(2, Math.min(8, (await import('node:os')).cpus().length - 1));
const child = spawn(install.bin, ['-m', install.model, '--port', String(port), '-t', String(threads), '-nlp'], { stdio: 'ignore' });
const stop = () => { try { child.kill(); } catch { /* gone */ } };
process.on('exit', stop);
for (const t0 = Date.now(); ;) {
  try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { /* loading */ }
  if (Date.now() - t0 > 120_000) { console.error('whisper-server did not start'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 300));
}

// The app talks to :47113; route the bundle's calls to OUR server instead. Its own spawn of
// `whisper-server` is pointed at a no-op so nothing ever binds :47113 from here.
const noop = join(scratch, 'noop.sh');
writeFileSync(noop, '#!/bin/sh\nsleep 600\n', { mode: 0o755 });
process.env.DREAMCONTEXT_WHISPER_BIN = noop;
process.env.DREAMCONTEXT_WHISPER_MODEL = install.model;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(String(url).replace('127.0.0.1:47113', `127.0.0.1:${port}`), init);

const { transcribeWithRetry, keepTake, buildVoiceLexicon, primerFrom, cleanWhisperText } = await import(bundle);
const lexicon = lexiconRoot ? buildVoiceLexicon(lexiconRoot) : undefined;

/** The OLD app: one `json` pass, `auto` unless its sticky memory held a language. */
let sticky = null;
async function oldPass(wav) {
  const language = sticky && Date.now() - sticky.at < 600_000 ? sticky.language : 'auto';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'take.wav');
  form.append('response_format', language === 'auto' ? 'verbose_json' : 'json');
  form.append('temperature', '0');
  form.append('beam_size', '5');
  form.append('best_of', '5');
  if (lexicon && language !== 'auto') form.append('prompt', primerFrom(lexicon));
  form.append('language', language);
  const t = Date.now();
  const body = await (await realFetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form })).json();
  const text = cleanWhisperText(String(body.text ?? ''));
  if (language === 'auto' && body.language && text) sticky = { language: body.language, at: Date.now() };
  if (!text) sticky = null;
  return { text, ms: Date.now() - t, language };
}

/** A pinned `json` pass with the same language the ladder's pass 1 used: the overhead baseline. */
async function jsonPass(wav, language) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'take.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('beam_size', '5');
  form.append('best_of', '5');
  if (lexicon && language !== 'auto') form.append('prompt', primerFrom(lexicon));
  form.append('language', language);
  const t = Date.now();
  await (await realFetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form })).json();
  return Date.now() - t;
}

// One warm-up so the first take does not pay the model's first decode.
await oldPass(readFileSync(join(dir, `${stamps[0]}.wav`)));
sticky = null;

const rows = [];
for (const stamp of stamps) {
  const wav = readFileSync(join(dir, `${stamp}.wav`));
  const recorded = JSON.parse(readFileSync(join(dir, `${stamp}.json`), 'utf-8'));
  const old = await oldPass(wav);
  const r = await transcribeWithRetry(wav, { cfg: {}, conv: 'eval', ui: 'tr', lexicon });
  const pass1 = r.attempts[0];
  const baseline = await jsonPass(wav, pass1.forced ? pass1.language : 'auto');
  const sent = r.verdict === 'garbled' ? null : r.winner.pass.text;
  keepTake(wav, {
    kind: 'stt', contextRoot: '/eval', conv: 'eval', quality: r.verdict, passes: r.passes,
    language: r.winner.pass.language, primary: r.context.primary, chars: r.winner.pass.text.length,
  });
  const row = {
    stamp, seconds: Number(((wav.length - 44) / 32000).toFixed(1)),
    recordedText: recorded.text, recordedMs: recorded.ms,
    oldText: old.text, oldMs: old.ms,
    verdict: r.verdict, passes: r.passes, ms: r.ms, baselineMs: baseline,
    pass1: `${pass1.forced ? 'pin' : 'auto'}:${pass1.language ?? '?'} ${pass1.verdict} ${pass1.logprob}`,
    pass2: r.attempts[1] ? `${r.attempts[1].forced ? 'pin' : 'auto'}:${r.attempts[1].language ?? '?'} ${r.attempts[1].verdict} ${r.attempts[1].logprob}` : '',
    sent,
  };
  rows.push(row);
  console.log(`${stamp}  ${row.verdict.padEnd(7)} passes=${row.passes} ${row.ms}ms (json ${baseline}ms)  ${sent === null ? '— NOT SENT —' : JSON.stringify(sent).slice(0, 90)}`);
}
stop();

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const clean1 = rows.filter((r) => r.passes === 1 && r.verdict === 'clean');
const overhead = median(clean1.map((r) => r.ms - r.baselineMs));
const retried = rows.filter((r) => r.passes === 2);
const foreign = rows.filter((r) => r.sent && /[þðæ]/.test(r.sent));
const lines = [
  '# Voice garble guard — local eval on real takes',
  '',
  `Run ${new Date().toISOString()} · ${rows.length} takes · model ${install.modelName} · whisper-server -nlp · lexicon ${lexiconRoot ? 'yes' : 'no'} · UI language tr.`,
  'The audio is the owner\'s and is never committed; this file holds only the numbers and the texts.',
  '',
  '| take | s | old (app before) | new verdict | passes | new ms | json ms | pass 1 | pass 2 | sent |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.stamp} | ${r.seconds} | ${(r.oldText || '').replace(/\|/g, '/').slice(0, 60)} (${r.oldMs} ms) | ${r.verdict} | ${r.passes} | ${r.ms} | ${r.baselineMs} | ${r.pass1} | ${r.pass2} | ${r.sent === null ? '**not sent** (Anlayamadım)' : r.sent.replace(/\|/g, '/').slice(0, 80)} |`),
  '',
  `- Texts sent containing þ, ð or æ: **${foreign.length}**`,
  `- Not sent (garbled): ${rows.filter((r) => r.sent === null).map((r) => r.stamp).join(', ') || 'none'}`,
  `- Median overhead on clean one-pass takes (ladder − json, same language): **${overhead} ms** over ${clean1.length} takes`,
  `- Retried takes: ${retried.map((r) => `${r.stamp} +${r.ms - r.baselineMs} ms`).join(', ') || 'none'}`,
  `- First take after a pause: pass 1 was ${rows[0].pass1.split(' ')[0]} (context empty at the start of the run).`,
];
writeFileSync(outFile, `${lines.join('\n')}\n`);
console.log(`\n${lines.slice(-5).join('\n')}\nwrote ${outFile}`);
rmSync(scratch, { recursive: true, force: true });
rmSync(bundle, { force: true });
process.exit(0);
