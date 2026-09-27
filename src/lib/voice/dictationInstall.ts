/**
 * Installing local dictation from inside the app — the engine and the model, decided here.
 *
 * Dictation is local and only local (owner, 2026-09-27: "dikte sadece yerel olsun"), so a
 * machine without whisper.cpp has no dictation at all until it is installed. The owner's
 * instruction for that gap: "sistem nasıl indireceğine karar veriyor, dikte için model
 * indirtsin setup kısmında" — setup does the install, and it picks the route itself:
 *
 *   1. ENGINE. `whisper-server` already found (PATH or a package manager's bin dir) → nothing
 *      to do. Otherwise Homebrew installs `whisper-cpp`. No Homebrew → a plain error naming it:
 *      building whisper.cpp from source is not something a settings button should attempt.
 *   2. MODEL. Any usable ggml model already on disk (whisper.cpp's dirs, Handy's) is used as
 *      is. Otherwise `large-v3-turbo` — the model Handy runs, better AND faster than `medium`
 *      on Apple silicon — is downloaded once into whisper.cpp's own model dir, through a
 *      `.part` file renamed only when every byte the server promised has arrived.
 *
 * ONE install at a time, process-wide; a second request joins the running one. The state is
 * polled by the UI (`GET /api/agent/voice/dictation`), so a Settings card and the setup
 * wizard open at the same time show the same progress.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { findModel, findServerBin, MODEL_HOME, modelName, warmWhisper } from './whisper.js';

/** The model a fresh machine gets. Hugging Face's canonical whisper.cpp mirror. */
export const DEFAULT_MODEL_FILE = 'ggml-large-v3-turbo.bin';
export const DEFAULT_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL_FILE}`;
/** Below this, a "model" is an error page or a truncated file, not 1.6 GB of weights. */
const MIN_MODEL_BYTES = 500_000_000;
/** A cold `brew install whisper-cpp` pulls a few bottles; this is generous on purpose. */
const BREW_TIMEOUT_MS = 15 * 60_000;

const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

export type InstallPhase = 'idle' | 'engine' | 'model' | 'done' | 'error';

export interface DictationState {
  /** Both halves present: a take can be transcribed right now. */
  installed: boolean;
  engine: boolean;
  /** The model's short name when one is on disk (`large-v3-turbo`). */
  model: string | null;
  /** Whether Homebrew is here — without it the engine cannot be installed from the app. */
  brew: boolean;
  phase: InstallPhase;
  /** Model download progress, bytes. `total` is 0 until the server says how big it is. */
  received: number;
  total: number;
  error: string | null;
}

interface Job { phase: InstallPhase; received: number; total: number; error: string | null }

let job: Job = { phase: 'idle', received: 0, total: 0, error: null };
let running: Promise<void> | null = null;

function brewPath(): string | null {
  return BREW_PATHS.find((p) => existsSync(p)) ?? null;
}

/** What is installed and what the install is doing — read fresh every call. */
export function dictationState(env: NodeJS.ProcessEnv = process.env): DictationState {
  const engine = !!findServerBin(env);
  const model = findModel(env);
  return {
    installed: engine && !!model,
    engine,
    model: model ? modelName(model) : null,
    brew: !!brewPath(),
    ...job,
  };
}

/**
 * Start the install, or join the one already running. Returns the state right after the
 * decision, so the caller can render "installing" without waiting for a poll.
 */
export interface InstallOptions {
  fetchImpl?: typeof fetch;
  /** Where a downloaded model goes (tests point it at a temp dir). */
  modelHome?: string;
  env?: NodeJS.ProcessEnv;
  /** The smallest body accepted as a model (tests use a small fixture). */
  minBytes?: number;
}

export function startDictationInstall(opts: InstallOptions = {}): DictationState {
  const env = opts.env ?? process.env;
  if (!running) {
    const now = dictationState(env);
    if (now.installed) {
      job = { phase: 'done', received: 0, total: 0, error: null };
      return dictationState(env);
    }
    job = { phase: now.engine ? 'model' : 'engine', received: 0, total: 0, error: null };
    running = install({ fetchImpl: opts.fetchImpl ?? fetch, modelHome: opts.modelHome ?? MODEL_HOME, env, minBytes: opts.minBytes ?? MIN_MODEL_BYTES })
      .then(() => { job = { ...job, phase: 'done', error: null }; if (!opts.env) warmWhisper(); })
      .catch((err: unknown) => {
        job = { ...job, phase: 'error', error: err instanceof Error ? err.message : String(err) };
        console.error('[voice:install]', job.error);
      })
      .finally(() => { running = null; });
  }
  return dictationState(env);
}

/** Wait for the running install, if any. Test seam; the app polls instead. */
export function dictationInstallSettled(): Promise<void> {
  return running ?? Promise.resolve();
}

type Resolved = Required<Pick<InstallOptions, 'fetchImpl' | 'modelHome' | 'env' | 'minBytes'>>;

async function install(o: Resolved): Promise<void> {
  if (!findServerBin(o.env)) {
    job = { ...job, phase: 'engine' };
    await brewInstall();
    if (!findServerBin(o.env)) throw new Error('Homebrew finished, but whisper-server is still not on this machine.');
  }
  if (!findModel(o.env)) {
    job = { ...job, phase: 'model', received: 0, total: 0 };
    await downloadModel(o);
  }
}

function brewInstall(): Promise<void> {
  const brew = brewPath();
  if (!brew) {
    return Promise.reject(new Error('Dictation needs whisper.cpp, and installing it needs Homebrew (https://brew.sh). Install Homebrew, then try again.'));
  }
  return new Promise((resolve, reject) => {
    // Fixed argv, absolute binary, no shell: nothing here is built from input.
    const child = spawn(brew, ['install', 'whisper-cpp'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        // The app's server runs with the bare system PATH; brew needs its own bin to find itself.
        PATH: `${dirname(brew)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_INSTALL_CLEANUP: '1',
        HOMEBREW_NO_ENV_HINTS: '1',
        NONINTERACTIVE: '1',
      },
    });
    let tail = '';
    child.stderr?.on('data', (d: Buffer) => { tail = (tail + d.toString()).slice(-600); });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, BREW_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`brew install whisper-cpp failed (exit ${code}). ${tail.trim().split('\n').slice(-2).join(' ')}`.trim()));
    });
  });
}

async function downloadModel(o: Resolved): Promise<void> {
  mkdirSync(o.modelHome, { recursive: true });
  const dest = join(o.modelHome, DEFAULT_MODEL_FILE);
  const part = `${dest}.part`;
  const res = await o.fetchImpl(DEFAULT_MODEL_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`The speech model could not be downloaded (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length') ?? 0);
  job = { ...job, total, received: 0 };
  const counted = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  counted.on('data', (chunk: Buffer) => { job = { ...job, received: job.received + chunk.length }; });
  try {
    await pipeline(counted, createWriteStream(part));
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
  // Renamed only when complete: a model file that exists is a model that is whole, because
  // `findModel` would happily hand a truncated one to whisper-server.
  if ((total && job.received !== total) || job.received < o.minBytes) {
    rmSync(part, { force: true });
    throw new Error(`The speech model download was incomplete (${job.received} of ${total || '?'} bytes). Try again.`);
  }
  renameSync(part, dest);
}

/** Test seam: forget the job. Not called by the app. */
export function resetDictationInstall(): void {
  job = { phase: 'idle', received: 0, total: 0, error: null };
  running = null;
}
