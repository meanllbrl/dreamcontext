/**
 * "Anlayamadım, tekrar eder misin?" — the one sentence the phone SAYS when a take could not be
 * understood and nothing was sent (owner, 2026-10-24).
 *
 * Rendered by the Mac's own `say`: free, offline, no key, and never the Super Agent's TTS (a
 * paid generation for a fixed sentence). Cached per language at `~/.dreamcontext/voice-cues/
 * <code>.wav` and pre-rendered when the model is warmed, so the first garbled take does not
 * wait on it. The language is a normalized code from the fixed table (`languageContext.ts`);
 * `say` is spawned with an argument list, never a shell.
 */

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeLanguage } from './languageContext.js';

/** The sentence per language. A language without one is spoken in English. */
const PHRASES: Readonly<Record<string, string>> = {
  tr: 'Anlayamadım, tekrar eder misin?',
  en: "I didn't catch that. Could you say it again?",
};

export type SayRunner = (args: string[]) => Promise<string>;

const defaultRun: SayRunner = (args) => new Promise((resolve, reject) => {
  execFile('/usr/bin/say', args, { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

export function cueDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'voice-cues');
}

/** The cue's language: the code when it has a sentence, else English. */
export function cueLanguage(lang: unknown): 'tr' | 'en' | string {
  const code = normalizeLanguage(lang);
  return code && PHRASES[code] ? code : 'en';
}

/** A `say` voice for `code`, from `say -v ?` ("Yelda  tr_TR  # …"); null = the default voice. */
async function voiceFor(code: string, run: SayRunner): Promise<string | null> {
  if (code === 'en') return null;
  try {
    const list = await run(['-v', '?']);
    for (const line of list.split('\n')) {
      const m = /^(.+?)\s{2,}([a-z]{2,3})_[A-Z0-9]{2,3}\s/.exec(line);
      if (m && m[2] === code) return m[1].trim();
    }
  } catch { /* no voice list: default voice */ }
  return null;
}

const inFlight = new Map<string, Promise<Buffer | null>>();

/**
 * The cue as WAV bytes, rendering it once if it is not cached. Single-flight per language: a
 * second request while one renders awaits the same promise. A failed render is NOT cached.
 */
export function cueAudio(lang: unknown, opts: { home?: string; run?: SayRunner } = {}): Promise<Buffer | null> {
  const code = cueLanguage(lang);
  const dir = cueDir(opts.home);
  const file = join(dir, `${code}.wav`);
  if (existsSync(file)) {
    try { return Promise.resolve(readFileSync(file)); } catch { /* re-render below */ }
  }
  const key = `${dir}|${code}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = opts.run ?? defaultRun;
  const job = (async (): Promise<Buffer | null> => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const tmp = `${file}.tmp`;
      const voice = await voiceFor(code, run);
      await run([
        ...(voice ? ['-v', voice] : []),
        '-o', tmp, '--file-format=WAVE', '--data-format=LEI16@22050',
        PHRASES[code],
      ]);
      renameSync(tmp, file);
      return readFileSync(file);
    } catch {
      rmSync(`${file}.tmp`, { force: true });
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

/** Start rendering the cue for `lang` without waiting (the warm-up path). macOS only. */
export function prerenderCue(lang: unknown): void {
  if (process.platform !== 'darwin') return;
  void cueAudio(lang);
}
