// The Haiku recall mode is retired. Vaults and shells that still say `haiku` must keep
// recalling (hybrid), never fall to `off`, never crash.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  RECALL_MODES,
  DEFAULT_RECALL_MODE,
  normalizeRecallMode,
  isAcceptedRecallModeInput,
} from '../../src/lib/recall-mode.js';
import { readSleepState, resolveRecallMode } from '../../src/cli/commands/sleep.js';

let root: string;
let savedEnv: string | undefined;

function writeSleepJson(body: Record<string, unknown>): void {
  writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify(body));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-recall-mode-legacy-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  savedEnv = process.env.DREAMCONTEXT_RECALL_MODE;
  delete process.env.DREAMCONTEXT_RECALL_MODE;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.DREAMCONTEXT_RECALL_MODE;
  else process.env.DREAMCONTEXT_RECALL_MODE = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('recall modes', () => {
  it('are hybrid / raw / off, and hybrid is the default', () => {
    expect([...RECALL_MODES]).toEqual(['hybrid', 'raw', 'off']);
    expect(DEFAULT_RECALL_MODE).toBe('hybrid');
  });
});

describe('normalizeRecallMode', () => {
  it.each(['hybrid', 'raw', 'off'] as const)('keeps %s', (mode) => {
    expect(normalizeRecallMode(mode)).toBe(mode);
  });

  it.each([['haiku'], [undefined], [null], [''], ['bm42'], [42], [{}]])(
    'maps %j to hybrid — never off',
    (value) => {
      expect(normalizeRecallMode(value)).toBe('hybrid');
    },
  );
});

describe('isAcceptedRecallModeInput (what PATCH /api/sleep takes)', () => {
  it('accepts the live modes and the retired haiku, nothing else', () => {
    for (const ok of ['hybrid', 'raw', 'off', 'haiku']) expect(isAcceptedRecallModeInput(ok)).toBe(true);
    for (const bad of ['bm42', '', 42, null, undefined]) expect(isAcceptedRecallModeInput(bad)).toBe(false);
  });
});

describe('persisted state', () => {
  it('a vault with recall_mode "haiku" on disk reads and resolves as hybrid', () => {
    writeSleepJson({ debt: 3, recall_mode: 'haiku' });
    expect(readSleepState(root).recall_mode).toBe('hybrid');
    expect(resolveRecallMode(root)).toBe('hybrid');
  });

  it('a vault with no recall_mode resolves as hybrid', () => {
    writeSleepJson({ debt: 3 });
    expect(resolveRecallMode(root)).toBe('hybrid');
  });

  it('a vault with no sleep state at all resolves as hybrid', () => {
    expect(resolveRecallMode(root)).toBe('hybrid');
  });

  it('a garbage persisted value resolves as hybrid, not off', () => {
    writeSleepJson({ recall_mode: 'bm42' });
    expect(resolveRecallMode(root)).toBe('hybrid');
  });

  it('a persisted raw or off is left alone', () => {
    writeSleepJson({ recall_mode: 'raw' });
    expect(resolveRecallMode(root)).toBe('raw');
    writeSleepJson({ recall_mode: 'off' });
    expect(resolveRecallMode(root)).toBe('off');
  });
});

describe('DREAMCONTEXT_RECALL_MODE', () => {
  it('haiku in the environment resolves as hybrid even over a persisted raw', () => {
    writeSleepJson({ recall_mode: 'raw' });
    process.env.DREAMCONTEXT_RECALL_MODE = 'haiku';
    expect(resolveRecallMode(root)).toBe('hybrid');
  });

  it('a live mode in the environment wins over the persisted one', () => {
    writeSleepJson({ recall_mode: 'hybrid' });
    process.env.DREAMCONTEXT_RECALL_MODE = 'raw';
    expect(resolveRecallMode(root)).toBe('raw');
  });

  it('an unknown value in the environment is ignored (the persisted mode stands)', () => {
    writeSleepJson({ recall_mode: 'raw' });
    process.env.DREAMCONTEXT_RECALL_MODE = 'bm42';
    expect(resolveRecallMode(root)).toBe('raw');
  });
});
