/**
 * Installing local dictation from the app (owner, 2026-09-27: "dikte için model indirtsin setup
 * kısmında"). The engine half runs Homebrew and is not exercised here; the decisions and the
 * model download are.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startDictationInstall, dictationState, dictationInstallSettled, resetDictationInstall,
  DEFAULT_MODEL_FILE, DEFAULT_MODEL_URL,
} from '../../src/lib/voice/dictationInstall.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  resetDictationInstall();
  dir = mkdtempSync(join(tmpdir(), 'dc-dictation-'));
  const bin = join(dir, 'whisper-server');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  // The engine is "installed" (the override), the model is not — yet.
  env = { DREAMCONTEXT_WHISPER_BIN: bin, DREAMCONTEXT_WHISPER_MODEL: join(dir, 'models', DEFAULT_MODEL_FILE) };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function body(bytes: number, declared = bytes) {
  const fetched: string[] = [];
  const fetchImpl = (async (url: string) => {
    fetched.push(String(url));
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-length': String(declared) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, fetched };
}

describe('dictation install', () => {
  it('does NOTHING when engine and model are already here — no download', async () => {
    const model = join(dir, 'have.bin');
    writeFileSync(model, Buffer.alloc(2_000_000));
    const { fetchImpl, fetched } = body(10);
    const s = startDictationInstall({ env: { ...env, DREAMCONTEXT_WHISPER_MODEL: model }, fetchImpl });
    await dictationInstallSettled();
    expect(s.installed).toBe(true);
    expect(s.phase).toBe('done');
    expect(fetched).toEqual([]);
  });

  it('downloads large-v3-turbo into the model home and renames it only when whole', async () => {
    const { fetchImpl, fetched } = body(4096);
    const started = startDictationInstall({ env, fetchImpl, modelHome: join(dir, 'models'), minBytes: 1024 });
    expect(started.phase).toBe('model');
    await dictationInstallSettled();
    expect(fetched).toEqual([DEFAULT_MODEL_URL]);
    const path = join(dir, 'models', DEFAULT_MODEL_FILE);
    expect(statSync(path).size).toBe(4096);
    expect(existsSync(`${path}.part`)).toBe(false);
    const s = dictationState(env);
    expect(s.installed).toBe(true);
    expect(s.phase).toBe('done');
    expect(s.received).toBe(4096);
  });

  it('a short body is an ERROR and leaves no model behind — a truncated file must never be found', async () => {
    const { fetchImpl } = body(100, 4096);
    startDictationInstall({ env, fetchImpl, modelHome: join(dir, 'models'), minBytes: 1024 });
    await dictationInstallSettled();
    const s = dictationState(env);
    expect(s.phase).toBe('error');
    expect(s.installed).toBe(false);
    expect(existsSync(join(dir, 'models', DEFAULT_MODEL_FILE))).toBe(false);
    expect(existsSync(join(dir, 'models', `${DEFAULT_MODEL_FILE}.part`))).toBe(false);
  });

  it('a second request JOINS the running install instead of starting another download', async () => {
    const { fetchImpl, fetched } = body(4096);
    startDictationInstall({ env, fetchImpl, modelHome: join(dir, 'models'), minBytes: 1024 });
    startDictationInstall({ env, fetchImpl, modelHome: join(dir, 'models'), minBytes: 1024 });
    await dictationInstallSettled();
    expect(fetched).toHaveLength(1);
  });
});
