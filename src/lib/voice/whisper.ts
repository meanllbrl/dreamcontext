/**
 * Local transcription through whisper.cpp, kept WARM.
 *
 * ── WHY THIS EXISTS, AGAINST THE ORIGINAL PLAN ──────────────────────────────────────────
 * The plan dropped local whisper after costing it: it saved about a dollar a month, which is
 * not a reason to run a subprocess. Two measurements later that trade has inverted, and both
 * halves came from the owner's own machine rather than a spreadsheet:
 *
 *   • ACCURACY. OpenRouter has no ASR model at all — transcription is an omni CHAT model
 *     doing its best, and on Turkish speech carrying English project jargon it is visibly
 *     worse than the whisper the owner already runs. It also VARIES between identical calls,
 *     which a transcriber must not.
 *   • COST AND LATENCY. `openai/gpt-audio` costs ~$0.0015 per take and answers in ~1.0-1.5s.
 *     A warm `whisper-server` on the same machine answers in ~0.88s, for nothing, and the
 *     audio never leaves the laptop.
 *
 * ── WHY A SERVER AND NOT `whisper-cli` PER TAKE ─────────────────────────────────────────
 * Measured: the CLI takes ~2.2s a take, of which more than a second is loading the model
 * from disk EVERY time — slower than the cloud it is replacing. The server loads once and
 * stays loaded, which is the entire difference between "faster than cloud" and "slower".
 *
 * ── AND WHY IT IS ALWAYS OPTIONAL ───────────────────────────────────────────────────────
 * whisper.cpp is not a dependency of this package and never will be: a 1.5 GB model download
 * is not something a CLI install may do. Everything here answers `null` when it cannot help,
 * and the route falls back to OpenRouter — so a machine with whisper gets the better path and
 * a machine without keeps working exactly as before.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir, cpus } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { claimOwnedPort } from '../../server/owned-ports.js';
import { normalizeLanguage } from './languageContext.js';
import type { WhisperSegment } from './garble.js';

/** Binaries that speak whisper.cpp's server protocol, in the order they are looked for. */
const SERVER_BINARIES = ['whisper-server'];

/**
 * Where models are kept, and which are preferred.
 *
 * `large-v3-turbo` first because it is BOTH better and faster than `medium` on Apple silicon
 * — there is no trade to make. The list ends at `base` rather than `tiny`: below `base` the
 * Turkish output stops being worth the round trip at all, and falling through to the cloud is
 * the better answer.
 */
const MODEL_DIRS = [
  join(homedir(), '.cache', 'whisper.cpp', 'models'),
  join(homedir(), '.cache', 'openwhispr', 'whisper-models'),
  join(homedir(), 'Library', 'Application Support', 'whisper.cpp', 'models'),
  // Handy (a local dictation app) keeps the same ggml files; a model it already downloaded
  // is 1.6 GB this machine does not have to fetch again.
  join(homedir(), 'Library', 'Application Support', 'com.pais.handy', 'models'),
  '/opt/homebrew/share/whisper.cpp/models',
  '/usr/local/share/whisper.cpp/models',
];

const MODEL_PREFERENCE = [
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3.bin',
  'ggml-medium.bin',
  'ggml-small.bin',
  'ggml-base.bin',
];

export interface WhisperInstall {
  /** Absolute path to the server binary. */
  bin: string;
  /** Absolute path to the ggml model file. */
  model: string;
  /** The model's short name, for Settings to show. */
  modelName: string;
}

/** `which`, without a shell, against the CALLER's environment — so a test can say "this
 *  machine has no whisper" and be believed. Returns null rather than throwing. */
function which(bin: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync('/usr/bin/which', [bin], { encoding: 'utf-8', env }).trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Where a package manager puts `whisper-server` when it is not on PATH.
 *
 * The desktop app starts this server from launchd/Finder with the bare system PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so `which` never sees Homebrew. Measured 2026-09-27 on
 * the owner's machine: `brew install whisper-cpp` and a large-v3-turbo model were both there,
 * and every take still went to the cloud, without the project's vocabulary — the dictation
 * the owner called unusable next to the same model running locally in Handy.
 */
const SERVER_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')];

/**
 * The server binary: the explicit override ALONE when one is set (a test or the owner saying
 * "this one" is believed, including when it says "none"), else PATH, else the known dirs.
 */
export function findServerBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const binOverride = env.DREAMCONTEXT_WHISPER_BIN;
  if (binOverride) return existsSync(binOverride) ? binOverride : null;
  for (const name of SERVER_BINARIES) {
    const onPath = which(name, env);
    if (onPath) return onPath;
    for (const dir of SERVER_BIN_DIRS) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/**
 * What is installed on this machine, or null.
 *
 * Deliberately not cached across calls: Settings shows this, and a model the owner downloads
 * while the app is open should be found without a restart. It is a handful of `existsSync`
 * calls, once per Settings render and once per take.
 */
export function findWhisper(env: NodeJS.ProcessEnv = process.env): WhisperInstall | null {
  const bin = findServerBin(env);
  if (!bin) return null;

  const model = findModel(env);
  return model ? { bin, model, modelName: modelName(model) } : null;
}

/** The best installed ggml model, or null — the override, then the preference order. */
export function findModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const modelOverride = env.DREAMCONTEXT_WHISPER_MODEL;
  if (modelOverride) return existsSync(modelOverride) ? modelOverride : null;
  for (const name of MODEL_PREFERENCE) {
    for (const dir of MODEL_DIRS) {
      const path = join(dir, name);
      try {
        if (existsSync(path) && statSync(path).size > 1_000_000) return path;
      } catch { /* unreadable — try the next one */ }
    }
  }
  return null;
}

/** Where a model this app downloads goes: the first dir, whisper.cpp's own convention. */
export const MODEL_HOME = MODEL_DIRS[0];

/** `…/ggml-large-v3-turbo.bin` → `large-v3-turbo`. */
export function modelName(path: string): string {
  return path.split(process.platform === 'win32' ? /[\\/]/ : '/').pop()!.replace(/^ggml-/, '').replace(/\.bin$/, '');
}

// ─── The warm server ──────────────────────────────────────────────────────────────────

interface Running {
  child: ChildProcess;
  port: number;
  ready: Promise<boolean>;
  install: WhisperInstall;
}

let running: Running | null = null;

/** Port chosen once and reused. High and fixed so a stray process is identifiable in `lsof`;
 *  bound to loopback by whisper-server's own default. `DREAMCONTEXT_WHISPER_PORT` moves it, for a
 *  verify run whose stand-in must not collide with the owner's real server on this one. */
const PORT = (() => {
  const v = Number(process.env.DREAMCONTEXT_WHISPER_PORT);
  return Number.isInteger(v) && v >= 1024 && v <= 65_535 ? v : 47_113;
})();

/** Give up on a model that will not load. A cold `large-v3-turbo` takes ~5s on first start. */
const READY_TIMEOUT_MS = 60_000;

/** One take's budget. Past this the cloud is faster than waiting. */
const INFERENCE_TIMEOUT_MS = 15_000;

/**
 * One take's budget, scaled with its length. {@link INFERENCE_TIMEOUT_MS} was set for a laptop
 * push-to-talk take of a few seconds; the hands-free phone sends up to two minutes, and a fixed
 * 15 s would time out a long message, after which the composer's retries queue behind the run
 * the server did not stop. 0.4 s per second of audio (16 kHz mono 16-bit = 32 000 bytes/s; a
 * higher-rate take only buys more time) on top of the fixed budget.
 */
export function inferenceTimeoutMs(wavBytes: number): number {
  return Math.max(INFERENCE_TIMEOUT_MS, INFERENCE_TIMEOUT_MS + Math.round((wavBytes / 32_000) * 400));
}

/** Decoder search width. See the call site for why the server's own default is not used. */
export const BEAM_SIZE = 5;
export const BEST_OF = 5;

/**
 * NO STICKY LANGUAGE ANY MORE (task sesli-giris-bozuk…, 2026-10-24).
 *
 * This module used to remember the language `auto` detected and pin it for ten minutes. On the
 * owner's phone that memory pinned an Icelandic MISdetection, and the next take came back in
 * Icelandic spelling too. The caller now decides the language from context
 * (`languageContext.ts`) and passes it in; this module only transcribes what it is told.
 */

async function waitForReady(port: number, deadline: number): Promise<boolean> {
  for (;;) {
    if (Date.now() > deadline) return false;
    try {
      // Any answer at all means the HTTP server is up; whisper-server 404s on `/`.
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * Start the server if it is not already up, and return it.
 *
 * The child is detached from stdio and killed with the process. A crash simply leaves
 * `running` null, so the NEXT take starts a fresh one — one retry per take, never a loop.
 */
/** The server's argument list. Exported for the test that pins `-nlp` in it. */
export function serverArgs(install: WhisperInstall, port: number, threads: number): string[] {
  return ['-m', install.model, '--port', String(port), '-t', String(threads), '-nlp'];
}

function ensureServer(install: WhisperInstall): Running {
  if (running && running.child.exitCode === null && !running.child.killed) return running;

  // `-t` is whisper-server's thread count and its default is FOUR, whatever the machine has.
  // Beam search multiplies the decode work, so the threads are what keep the added search
  // inside the latency budget. One reserved core: this runs while the owner is using the app.
  const threads = Math.max(2, Math.min(8, (cpus()?.length ?? 4) - 1));
  // `-nlp`: no language-probability map. The server otherwise computes it on EVERY
  // `verbose_json` request (+650-800 ms measured 2026-10-24); with it off, verbose costs the
  // same as plain json and still carries each segment's `avg_logprob` and `no_speech_prob`,
  // which `garble.ts` reads. The probability itself is useless (0.97-0.99 on misdetections).
  const child = spawn(install.bin, serverArgs(install, PORT, threads), {
    stdio: 'ignore',
    detached: false,
  });
  // Its port is ours while the child lives: no web card may load it.
  const release = claimOwnedPort(PORT);
  child.on('exit', () => { release(); if (running?.child === child) running = null; });
  child.on('error', () => { release(); if (running?.child === child) running = null; });

  const started: Running = {
    child,
    port: PORT,
    install,
    ready: waitForReady(PORT, Date.now() + READY_TIMEOUT_MS),
  };
  running = started;
  return started;
}

/**
 * Start the model loading NOW, without a take waiting on it.
 *
 * The first take of a session paid ~3.3s against ~0.85s for the ones after it, and almost all
 * of that gap is a 1.5 GB model being read off disk. The composer calls this when assistant
 * mode opens, which is typically seconds before the first press.
 */
export function warmWhisper(): { model: string } | null {
  const install = findWhisper();
  if (!install) return null;
  ensureServer(install);
  return { model: install.modelName };
}

/** Stop the warm server. Called when the engine is switched off in Settings, and on exit. */
export function stopWhisperServer(): void {
  if (!running) return;
  try { running.child.kill(); } catch { /* already gone */ }
  running = null;
}

process.once('exit', stopWhisperServer);

/** One pass's answer: the text, and what `garble.ts` needs to judge it. */
export interface LocalTranscript {
  text: string;
  ms: number;
  model: string;
  /** The language the pass was decoded in: the pin, or the detected one (normalized), or null. */
  language: string | null;
  /** True when the language was pinned rather than detected. */
  forced: boolean;
  segments: WhisperSegment[];
}

/**
 * Transcribe a WAV locally, or return null so the caller can report a failure.
 *
 * `null` covers every "not here, not ready, not working" case on purpose: this path is an
 * optimisation, and an optimisation that can fail loudly is worse than no optimisation.
 *
 * `language` is a normalized code (`languageContext.ts`) or `auto`; anything else is `auto`.
 * `primer: false` and `temperature` are the loop retry's: the same language, no prompt to copy,
 * a little sampling to break the loop.
 */
export async function transcribeLocal(
  wav: Buffer,
  opts: { language?: string; install?: WhisperInstall | null; lexicon?: string; primer?: boolean; temperature?: number } = {},
): Promise<LocalTranscript | null> {
  const install = opts.install !== undefined ? opts.install : findWhisper();
  if (!install) return null;

  const started = Date.now();
  const server = ensureServer(install);
  if (!(await server.ready)) {
    stopWhisperServer();
    return null;
  }

  const pinned = normalizeLanguage(opts.language);
  const language = pinned ?? 'auto';
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'take.wav');
    // `verbose_json` on EVERY pass: its segments carry the decoding confidence the garble
    // score reads, and with the server's `-nlp` it costs the same as plain json.
    form.append('response_format', 'verbose_json');
    form.append('temperature', String(opts.temperature ?? 0));
    // ── BEAM SEARCH, because greedy is whisper-server's default and it is not what the owner
    // runs by hand ────────────────────────────────────────────────────────────────────────
    // `whisper-server --help` reports `--beam-size [-1]`, i.e. greedy decoding with
    // `--best-of 2`. That is the cheap setting, and on short Turkish takes carrying English
    // project jargon it is the one that mis-hears a proper noun and then commits to it —
    // precisely the gap the owner measured between this app and their own whisper.cpp
    // invocation, with the SAME model. Five is whisper's own reference default; on
    // `large-v3-turbo` over a Metal backend it costs a fraction of a second on a take of a
    // few seconds, which is well inside a push-to-talk budget that already allows 15.
    form.append('beam_size', String(BEAM_SIZE));
    form.append('best_of', String(BEST_OF));
    // The project vocabulary as whisper's INITIAL PROMPT — the trick the cloud path cannot
    // use, and here it costs nothing (0.95s against 0.86s) while pulling "Dremontext" towards
    // "Dreamcontext" at the source.
    //
    // TWO RULES, BOTH LEARNED THE HARD WAY IN ONE MEASUREMENT:
    //   • NEVER while detecting. The vocabulary is mostly English product names, so priming
    //     with it made whisper decide a Turkish take was English and return
    //     "DREAM JON TEXT TASKINI GUNCELLE" — the prompt has to wait until the language is
    //     known.
    //   • It must be a PUNCTUATED SENTENCE. Whisper copies the prompt's style, so a bare list
    //     of tokens came back as transcripts with no commas and no capitals — and this app
    //     then splits speech on exactly that punctuation.
    if (opts.lexicon && pinned && opts.primer !== false) form.append('prompt', primerFrom(opts.lexicon));
    // `auto` IS SENT EXPLICITLY, and that is the opposite of the cloud path's rule. Omitting
    // the field here does not mean "detect" — whisper.cpp's default is ENGLISH, and a Turkish
    // take then comes back transliterated and shouting: "DREAM-JON TEXT TASKINI GUNCELLE"
    // where `language=auto` gives "Dremontext Taskını güncelle". Measured, twice, because the
    // first reading looked like the model was simply bad. A pin is the table's code, which
    // whisper.cpp accepts as readily as its name.
    form.append('language', language);

    const res = await fetch(`http://127.0.0.1:${server.port}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(inferenceTimeoutMs(wav.length)),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { text?: unknown; language?: unknown; segments?: unknown };
    const text = typeof body?.text === 'string' ? cleanWhisperText(body.text) : '';
    const segments: WhisperSegment[] = Array.isArray(body?.segments)
      ? body.segments.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object').map((s) => ({
        start: num(s.start), end: num(s.end), avg_logprob: num(s.avg_logprob), no_speech_prob: num(s.no_speech_prob),
      }))
      : [];
    return {
      text,
      ms: Date.now() - started,
      model: install.modelName,
      language: pinned ?? normalizeLanguage(body?.language),
      forced: !!pinned,
      segments,
    };
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * The lexicon as a sentence whisper can imitate.
 *
 * Style is contagious in an initial prompt: hand it `dreamcontext sleep task insight` and the
 * transcript comes back unpunctuated and uncapitalised, which is a real loss here because the
 * speech chunker breaks on punctuation. Hand it a sentence and it keeps writing sentences.
 */
export function primerFrom(lexicon: string, limit = 700): string {
  const terms = lexicon.split(/\s+/).filter(Boolean).join(', ').slice(0, limit).replace(/,\s*$/, '');
  return terms ? `Bu konuşmada şu terimler geçebilir: ${terms}.` : '';
}

/**
 * Tidy whisper.cpp's output.
 *
 * It pads with a leading space and joins its segments with a newline. Its silence markers
 * ([BLANK_AUDIO], (music), *sighs*) are removed too: they are a description of the audio, and
 * the composer would submit one to a tool-enabled agent as if it had been spoken.
 *
 * ── THE NEWLINE IS DROPPED, NOT TURNED INTO A SPACE ─────────────────────────────────────
 * A segment can end in the MIDDLE of a word. Measured 2026-10-13 on the owner's own Handy
 * recording, same server and model: `' …ayarlardan yapab'` + `'iliyoruz.'`. A segment that
 * starts a new word carries its own leading space (whisper's tokens do), so the newline is
 * pure joinery. Turning it into a space wrote "yapab iliyoruz", "hızlı ca", "aksiy onları" into
 * the composer: on long Turkish words, several broken words per take.
 */
export function cleanWhisperText(raw: string): string {
  return raw
    .replace(/\r?\n/g, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:music|laughter|applause|silence|sighs?|inaudible)[^)]*\)/gi, ' ')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
