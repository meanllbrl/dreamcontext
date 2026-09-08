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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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
 * What is installed on this machine, or null.
 *
 * Deliberately not cached across calls: Settings shows this, and a model the owner downloads
 * while the app is open should be found without a restart. It is a handful of `existsSync`
 * calls, once per Settings render and once per take.
 */
export function findWhisper(env: NodeJS.ProcessEnv = process.env): WhisperInstall | null {
  const binOverride = env.DREAMCONTEXT_WHISPER_BIN;
  const bin = binOverride && existsSync(binOverride)
    ? binOverride
    : SERVER_BINARIES.map((b) => which(b, env)).find((p): p is string => !!p) ?? null;
  if (!bin) return null;

  const modelOverride = env.DREAMCONTEXT_WHISPER_MODEL;
  if (modelOverride && existsSync(modelOverride)) {
    return { bin, model: modelOverride, modelName: modelName(modelOverride) };
  }
  for (const name of MODEL_PREFERENCE) {
    for (const dir of MODEL_DIRS) {
      const path = join(dir, name);
      try {
        if (existsSync(path) && statSync(path).size > 1_000_000) {
          return { bin, model: path, modelName: modelName(path) };
        }
      } catch { /* unreadable — try the next one */ }
    }
  }
  return null;
}

/** `…/ggml-large-v3-turbo.bin` → `large-v3-turbo`. */
export function modelName(path: string): string {
  return path.split('/').pop()!.replace(/^ggml-/, '').replace(/\.bin$/, '');
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
 *  bound to loopback by whisper-server's own default. */
const PORT = 47_113;

/** Give up on a model that will not load. A cold `large-v3-turbo` takes ~5s on first start. */
const READY_TIMEOUT_MS = 60_000;

/** One take's budget. Past this the cloud is faster than waiting. */
const INFERENCE_TIMEOUT_MS = 15_000;

/**
 * STICKY LANGUAGE DETECTION, and why it is worth the machinery.
 *
 * Measured on the owner's machine, same model, same take: `language=auto` costs ~1.75s and a
 * pinned language ~0.88s. Detection is a whole extra pass, and it runs on EVERY take, so the
 * mode's headline latency was doubled by a hint nobody asked for.
 *
 * So the first take detects, and the ones after it reuse what was detected. The window is
 * short and refreshed by use: switch language between two sentences and the second one is
 * transcribed as the first's language — a bounded, recoverable wrong, against a permanent
 * second on every take. An empty transcript drops the memory immediately, because that is
 * what a wrongly-pinned language most often produces.
 */
const DETECTED_TTL_MS = 10 * 60 * 1000;
let detected: { language: string; at: number } | null = null;

/** Forget the detected language — a wrong pin must not outlive the take that revealed it. */
export function forgetDetectedLanguage(): void { detected = null; }

/** What to send as `language` for this take: the pin, the memory, or `auto` to detect. */
export function languageFor(pinned: string | undefined, now: number = Date.now()): string {
  const explicit = (pinned || '').trim();
  if (explicit && explicit !== 'auto') return explicit;
  if (detected && now - detected.at < DETECTED_TTL_MS) return detected.language;
  return 'auto';
}

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
function ensureServer(install: WhisperInstall): Running {
  if (running && running.child.exitCode === null && !running.child.killed) return running;

  const child = spawn(install.bin, ['-m', install.model, '--port', String(PORT)], {
    stdio: 'ignore',
    detached: false,
  });
  child.on('exit', () => { if (running?.child === child) running = null; });
  child.on('error', () => { if (running?.child === child) running = null; });

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
 * of that gap is a 1.5 GB model being read off disk. The composer calls this when J.A.R.V.I.S
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
  forgetDetectedLanguage();
  if (!running) return;
  try { running.child.kill(); } catch { /* already gone */ }
  running = null;
}

process.once('exit', stopWhisperServer);

/**
 * Transcribe a WAV locally, or return null so the caller can fall back to the cloud.
 *
 * `null` covers every "not here, not ready, not working" case on purpose: this path is an
 * optimisation, and an optimisation that can fail loudly is worse than no optimisation.
 */
export async function transcribeLocal(
  wav: Buffer,
  opts: { language?: string; install?: WhisperInstall | null; lexicon?: string } = {},
): Promise<{ text: string; ms: number; model: string } | null> {
  const install = opts.install !== undefined ? opts.install : findWhisper();
  if (!install) return null;

  const started = Date.now();
  const server = ensureServer(install);
  if (!(await server.ready)) {
    stopWhisperServer();
    return null;
  }

  const language = languageFor(opts.language);
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'take.wav');
    // `verbose_json` only while DETECTING: it is the response that names the language it
    // chose, and naming it is what lets the next take skip the detection pass entirely.
    form.append('response_format', language === 'auto' ? 'verbose_json' : 'json');
    form.append('temperature', '0');
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
    if (opts.lexicon && language !== 'auto') form.append('prompt', primerFrom(opts.lexicon));
    // `auto` IS SENT EXPLICITLY, and that is the opposite of the cloud path's rule. Omitting
    // the field here does not mean "detect" — whisper.cpp's default is ENGLISH, and a Turkish
    // take then comes back transliterated and shouting: "DREAM-JON TEXT TASKINI GUNCELLE"
    // where `language=auto` gives "Dremontext Taskını güncelle". Measured, twice, because the
    // first reading looked like the model was simply bad.
    form.append('language', language);

    const res = await fetch(`http://127.0.0.1:${server.port}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { text?: unknown; language?: unknown };
    const text = typeof body?.text === 'string' ? cleanWhisperText(body.text) : '';
    // whisper answers with the language's NAME ("turkish"), and accepts that same name back
    // as a pin — verified against the server, so there is no mapping table to drift.
    if (language === 'auto' && typeof body?.language === 'string' && body.language && text) {
      detected = { language: body.language, at: Date.now() };
    }
    if (!text) forgetDetectedLanguage();
    return { text, ms: Date.now() - started, model: install.modelName };
  } catch {
    return null;
  }
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
 * It pads with a leading space and wraps at its own segment length, so a two-line answer
 * arrives with a newline in the middle of a sentence. Its silence markers ([BLANK_AUDIO],
 * (music), *sighs*) are removed too: they are a description of the audio, and the composer
 * would submit one to a tool-enabled agent as if it had been spoken.
 */
export function cleanWhisperText(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:music|laughter|applause|silence|sighs?|inaudible)[^)]*\)/gi, ' ')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
