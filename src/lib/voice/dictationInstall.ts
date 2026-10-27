/**
 * Dictation's engine CHOICE, and installing the local one from inside the app.
 *
 * ── NOTHING HAPPENS UNTIL THE OWNER CHOOSES (owner, 2026-10-27) ──────────────────────────
 * Setup used to install whisper.cpp and download `large-v3-turbo` the moment the voice step
 * opened, and the app then loaded it at every launch — which took dreamcontext down on 8 GB
 * MacBook Airs. Now `startDictationInstall` requires a choice:
 *
 *   • `cloud` — OpenRouter's transcription endpoint with the voice key. Nothing is installed.
 *   • `local` + a size — the size Settings recommends from this machine's memory and chip
 *     (`whisperModels.ts`), or any other the owner picks; one that cannot fit is refused.
 *
 * For `local`:
 *   1. ENGINE. `whisper-server` already found (PATH or a package manager's bin dir) → nothing
 *      to do. Otherwise Homebrew installs `whisper-cpp`. No Homebrew → a plain error naming it:
 *      building whisper.cpp from source is not something a settings button should attempt.
 *   2. MODEL. The chosen size's file, if it is already on disk (whisper.cpp's dirs, Handy's), is
 *      used as is. Otherwise it is downloaded once into whisper.cpp's own model dir, through a
 *      `.part` file renamed only when every byte the server promised has arrived. Nothing is
 *      ever deleted: a `large-v3-turbo` from before stays on disk and stays selectable.
 *
 * Installing never LOADS the model; the first take does (`whisper.ts`).
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
import { homedir } from 'node:os';
import {
  findModel, findServerBin, findWhisper, locateModelFile, localBlocked, stopWhisperServer,
  clearLoadFailure, MODEL_HOME, type WhisperInstall,
} from './whisper.js';
import {
  WHISPER_MODELS, MODEL_URL_BASE, modelSpec, recommendModel, fitsMachine, machineInfo,
  isWhisperModelId, type MachineInfo, type WhisperModelId,
} from './whisperModels.js';
import { readVoiceConfig, writeVoiceConfig, voiceApiKey, type DictationEngine } from './config.js';

export function modelUrl(file: string): string {
  return `${MODEL_URL_BASE}/${file}`;
}

/** Below this share of the expected size, a "model" is an error page or a truncated file. */
const MIN_MODEL_SHARE = 0.9;
/** A cold `brew install whisper-cpp` pulls a few bottles; this is generous on purpose. */
const BREW_TIMEOUT_MS = 15 * 60_000;

const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

export type InstallPhase = 'idle' | 'engine' | 'model' | 'done' | 'error';

export interface DictationChoice {
  engine: DictationEngine;
  /** The local size; null for `cloud`. */
  model: WhisperModelId | null;
}

export interface ModelOption {
  id: WhisperModelId;
  downloadMB: number;
  ramMB: number;
  /** Already on this machine — choosing it downloads nothing. */
  onDisk: boolean;
  /** This machine can carry it (`fitsMachine`); one that cannot is refused. */
  fits: boolean;
}

export interface DictationState {
  /** A take can be transcribed right now, by the chosen (or legacy) engine. */
  installed: boolean;
  /** What the owner chose; null = not chosen yet (the picker is shown). */
  choice: DictationChoice | null;
  /** whisper-server is on this machine. */
  engine: boolean;
  /** The local model that a take would use (`small`), when there is one. */
  model: string | null;
  /** The local model is there but must not be loaded: too big for this Mac, or it failed. */
  blocked: 'too_big' | 'load_failed' | null;
  /** An OpenRouter key is set (never the key itself). */
  key: boolean;
  machine: { memGB: number; chip: string };
  recommended: WhisperModelId;
  models: ModelOption[];
  /** Whether Homebrew is here — without it the engine cannot be installed from the app. */
  brew: boolean;
  phase: InstallPhase;
  /** Model download progress, bytes. `total` is 0 until the server says how big it is. */
  received: number;
  total: number;
  error: string | null;
}

interface Job {
  phase: InstallPhase; received: number; total: number; error: string | null;
  /** The size being installed. It becomes the CHOICE only once it is whole on disk, so the
   *  model already in use keeps dictating through the download, and a failed download
   *  leaves it in place. */
  pending: WhisperModelId | null;
}

const IDLE: Job = { phase: 'idle', received: 0, total: 0, error: null, pending: null };
let job: Job = { ...IDLE };
let running: Promise<void> | null = null;

function brewPath(): string | null {
  return BREW_PATHS.find((p) => existsSync(p)) ?? null;
}

export interface StateOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  machine?: MachineInfo;
}

/** The stored choice, or null. A `local` with no valid size is not a choice. */
export function readDictationChoice(home: string = homedir()): DictationChoice | null {
  const cfg = readVoiceConfig(home);
  if (cfg.dictationEngine === 'cloud') return { engine: 'cloud', model: null };
  if (cfg.dictationEngine === 'local' && cfg.dictationModel) return { engine: 'local', model: cfg.dictationModel };
  return null;
}

/**
 * Which engine a take goes to right now.
 *
 *   `cloud`  — chosen; ready when a key is set.
 *   `local`  — chosen with a size, or NOT chosen on a machine that already has a model that fits
 *              (an install from before the choice existed keeps working, and is still loaded only
 *              on the first take). `install` null = the chosen file or the engine is missing.
 *   `none`   — nothing chosen and nothing usable here: the picker has to be answered first.
 */
export type DictationRoute =
  | { engine: 'cloud'; ready: boolean }
  | { engine: 'local'; install: WhisperInstall | null; blocked: 'too_big' | 'load_failed' | null }
  | { engine: 'none' };

export function resolveDictation(o: StateOptions = {}): DictationRoute {
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const machine = o.machine ?? machineInfo();
  const choice = readDictationChoice(home);
  if (choice?.engine === 'cloud') return { engine: 'cloud', ready: !!voiceApiKey(home) };
  const install = findWhisper(env, { model: choice?.model ?? null, machine });
  if (!choice && !install) return { engine: 'none' };
  return { engine: 'local', install, blocked: install ? localBlocked(install, machine) : null };
}

/** What is chosen, installed, and what the install is doing — read fresh every call. */
export function dictationState(opts: StateOptions = {}): DictationState {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const machine = opts.machine ?? machineInfo();
  const route = resolveDictation({ env, home, machine });
  const engine = !!findServerBin(env);
  const installed = route.engine === 'cloud'
    ? route.ready
    : route.engine === 'local' && !!route.install && route.blocked === null;
  return {
    installed,
    choice: readDictationChoice(home),
    engine,
    model: route.engine === 'local' && route.install ? route.install.modelName : null,
    blocked: route.engine === 'local' ? route.blocked : null,
    key: !!voiceApiKey(home),
    machine: { memGB: Math.round(machine.memBytes / 1024 ** 3), chip: machine.cpuModel },
    recommended: recommendModel(machine),
    models: WHISPER_MODELS.map((m) => ({
      id: m.id,
      downloadMB: m.downloadMB,
      ramMB: m.ramMB,
      onDisk: !!locateModelFile(m.file),
      fits: fitsMachine(m.ramMB, machine),
    })),
    brew: !!brewPath(),
    ...job,
  };
}

export interface InstallOptions extends StateOptions {
  fetchImpl?: typeof fetch;
  /** Where a downloaded model goes (tests point it at a temp dir). */
  modelHome?: string;
  /** The smallest body accepted as a model (tests use a small fixture). */
  minBytes?: number;
}

/** Why a request carried no usable choice — the route answers 400 with it. */
export class ChoiceRequired extends Error {}

/** A choice made while a download runs — the route answers 409; the UI says to wait. */
export class InstallRunning extends Error {}

/** Parse `{ engine, model }` from a request body, or throw {@link ChoiceRequired}. */
export function parseDictationChoice(body: unknown): DictationChoice {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.engine === 'cloud') return { engine: 'cloud', model: null };
  if (b.engine === 'local' && isWhisperModelId(b.model)) return { engine: 'local', model: b.model };
  throw new ChoiceRequired('Choose where dictation runs: on this Mac (with a model size) or in the cloud.');
}

/**
 * Store the owner's choice and, for `local`, install what it needs. Returns the state right
 * after the decision, so the caller can render "installing" without waiting for a poll. Never
 * loads a model. While a download runs, a new choice is REFUSED ({@link InstallRunning}) rather
 * than silently dropped.
 */
export function startDictationInstall(choice: DictationChoice, opts: InstallOptions = {}): DictationState {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const machine = opts.machine ?? machineInfo();
  const stateOpts = { env, home, machine };
  if (running) {
    throw new InstallRunning(`A ${job.pending ?? 'speech'} model is still downloading. Choose again once it finishes.`);
  }

  const spec = choice.engine === 'local' ? modelSpec(choice.model) : null;
  if (choice.engine === 'local' && spec && !fitsMachine(spec.ramMB, machine)) {
    job = {
      ...IDLE,
      phase: 'error',
      error: `${spec.id} needs about ${(spec.ramMB / 1024).toFixed(1)} GB of memory, which this Mac (${Math.round(machine.memBytes / 1024 ** 3)} GB) cannot spare. Choose ${recommendModel(machine)} or the cloud.`,
    };
    return dictationState(stateOpts);
  }

  const commit = (): void => {
    writeVoiceConfig({ dictationEngine: choice.engine, dictationModel: choice.model ?? null }, home);
    // A different choice: whatever is loaded is the old one, and an old failure is not this one's.
    stopWhisperServer();
    clearLoadFailure();
  };

  // Nothing to fetch (the cloud, or the chosen size already here): the choice is stored now.
  if (choice.engine === 'cloud' || !spec || findWhisper(env, { model: choice.model, machine })) {
    commit();
    job = { ...IDLE, phase: 'done' };
    return dictationState(stateOpts);
  }
  job = { ...IDLE, phase: findServerBin(env) ? 'model' : 'engine', pending: spec.id };
  running = install({
    fetchImpl: opts.fetchImpl ?? fetch,
    modelHome: opts.modelHome ?? MODEL_HOME,
    env,
    file: spec.file,
    minBytes: opts.minBytes ?? Math.round(spec.downloadMB * 1e6 * MIN_MODEL_SHARE),
  })
    .then(() => { commit(); job = { ...job, phase: 'done', error: null, pending: null }; })
    .catch((err: unknown) => {
      job = { ...job, phase: 'error', error: err instanceof Error ? err.message : String(err), pending: null };
      console.error('[voice:install]', job.error);
    })
    .finally(() => { running = null; });
  return dictationState(stateOpts);
}

/** Wait for the running install, if any. Test seam; the app polls instead. */
export function dictationInstallSettled(): Promise<void> {
  return running ?? Promise.resolve();
}

type Resolved = Required<Pick<InstallOptions, 'fetchImpl' | 'modelHome' | 'env' | 'minBytes'>> & { file: string };

async function install(o: Resolved): Promise<void> {
  if (!findServerBin(o.env)) {
    job = { ...job, phase: 'engine' };
    await brewInstall();
    if (!findServerBin(o.env)) throw new Error('Homebrew finished, but whisper-server is still not on this machine.');
  }
  const id = WHISPER_MODELS.find((m) => m.file === o.file)?.id ?? null;
  if (!findModel(o.env, { model: id })) {
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
  const dest = join(o.modelHome, o.file);
  const part = `${dest}.part`;
  const res = await o.fetchImpl(modelUrl(o.file), { redirect: 'follow' });
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
  job = { ...IDLE };
  running = null;
}
