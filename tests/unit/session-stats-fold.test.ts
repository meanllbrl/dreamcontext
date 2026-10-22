/**
 * session-stats / session-model through the incremental transcript fold (task: the desktop app
 * stays light on an 8GB MacBook Air, plan S2/S3, AC2).
 *
 * The poll route used to readFileSync + JSON.parse a whole 20–53 MB transcript every 5 s per
 * live pane. It now folds the file incrementally (src/lib/jsonl-fold.ts). The whole-text forms
 * stay as the oracles: on every fixture, and again after an appended turn, the fold must give
 * exactly what `sessionStatsFromText` / `latestTranscriptModel` give over the same text.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  foldedSessionStats, foldedTranscriptModel, latestTranscriptModel, sessionStatsFromText,
} from '../../src/server/routes/agent-terminal.js';
import { resetJsonlFoldsForTests } from '../../src/lib/jsonl-fold.js';

const dir = mkdtempSync(join(tmpdir(), 'dc-stats-fold-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { resetJsonlFoldsForTests(); });

type Row = Record<string, unknown>;
const usage = (i: number, o: number, cw = 0, cr = 0) => ({
  input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
});
const asst = (id: string | undefined, model: string | undefined, u: Row, extra: Row = {}): Row => ({
  type: 'assistant', ...extra, message: { ...(id ? { id } : {}), ...(model !== undefined ? { model } : {}), usage: u },
});

/** Fixture 1: content-block repeats of one message id, a sidechain, a mid-session model switch,
 *  a `<synthetic>` reply, user lines without usage. */
function fixtureBlocks(): Row[] {
  return [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    asst('m1', 'claude-opus-4-8', usage(100, 200, 1000, 0)),
    asst('m1', 'claude-opus-4-8', usage(100, 200, 1000, 0)),
    asst('s1', 'claude-haiku-4-5-20251001', usage(50, 60), { isSidechain: true }),
    { type: 'assistant', message: { model: '<synthetic>', content: 'Please run /login' } },
    asst('m2', 'claude-sonnet-5', usage(10, 20, 0, 5000)),
    asst('m3', undefined, usage(1, 2, 3, 4)),
  ];
}

/** Fixture 2: unkeyed usage lines (no message id), a sidechain-only tail, legacy pricing. */
function fixtureUnkeyed(): Row[] {
  return [
    asst(undefined, 'claude-opus-4-1-20250805', usage(1000, 1000)),
    asst(undefined, 'claude-opus-4-1-20250805', usage(1000, 1000)),
    asst('m9', 'claude-opus-4-1-20250805', usage(5, 5, 5, 5)),
    asst('sc', 'claude-haiku-4-5-20251001', usage(7, 7), { isSidechain: true }),
  ];
}

/** Fixture 3: a long session (thousands of turns, a few hundred KB) with a 1M-window model. */
function fixtureLong(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 3000; i++) {
    rows.push({ type: 'user', message: { role: 'user', content: `q${i}` } });
    rows.push(asst(`m${i}`, i < 1500 ? 'claude-opus-5' : 'claude-fable-5', usage(i, i * 2, i * 3, 250_000 + i)));
  }
  return rows;
}

const toText = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function write(name: string, rows: Row[]): string {
  const p = join(dir, name);
  writeFileSync(p, toText(rows));
  return p;
}

async function expectParity(path: string): Promise<void> {
  const raw = readFileSync(path, 'utf-8');
  expect(await foldedSessionStats(path)).toEqual(sessionStatsFromText(raw));
  expect(await foldedTranscriptModel(path)).toEqual(latestTranscriptModel(raw));
}

describe('transcript fold parity', () => {
  const fixtures: Array<[string, () => Row[]]> = [['blocks', fixtureBlocks], ['unkeyed', fixtureUnkeyed], ['long', fixtureLong]];
  for (const [name, make] of fixtures) {
    it(`${name}: fold === sessionStatsFromText / latestTranscriptModel, also after an appended turn`, async () => {
      const path = write(`${name}.jsonl`, make());
      await expectParity(path);
      appendFileSync(path, toText([
        { type: 'user', message: { role: 'user', content: 'again' } },
        asst(`${name}-new`, 'claude-haiku-4-5-20251001', usage(11, 22, 33, 44)),
      ]));
      await expectParity(path);
      // And a repeat with nothing new.
      await expectParity(path);
    });
  }

  it('a missing transcript reads as empty stats and no model', async () => {
    const missing = join(dir, 'missing.jsonl');
    expect(await foldedSessionStats(missing)).toEqual({ contextTokens: null, contextLimit: null, costUsd: null });
    expect(await foldedTranscriptModel(missing)).toBeNull();
  });
});

describe('transcript fold cost on a 50 MB transcript (AC2)', () => {
  it('repeat call ≤ 5 ms, after one appended turn ≤ 20 ms', async () => {
    const path = join(dir, 'big.jsonl');
    // ~50 MB: realistic-width assistant lines carrying a large content payload.
    const filler = 'x'.repeat(8_000);
    const chunk: string[] = [];
    for (let i = 0; i < 6_200; i++) {
      chunk.push(JSON.stringify({ ...asst(`m${i}`, 'claude-opus-5', usage(i, i, i, i)), content: filler }));
    }
    writeFileSync(path, chunk.join('\n') + '\n');
    await foldedSessionStats(path); // the one full fold

    const time = async (): Promise<number> => {
      const t0 = performance.now();
      await foldedSessionStats(path);
      return performance.now() - t0;
    };
    // Best of the attempts, the shape of 9b96383d: a fold that re-reads the 50 MB is slow on
    // EVERY attempt (hundreds of ms), while a repeat call is a stat and a 1-byte read that a
    // loaded machine (20 isolated runs at load ~46: 5 of 20 medians over 5 ms, worst 16 ms)
    // can deschedule past the bound once or twice. The bounds themselves are unchanged.
    const repeats: number[] = [];
    for (let i = 0; i < 5; i++) repeats.push(await time());
    expect(Math.min(...repeats)).toBeLessThanOrEqual(5);

    // Each attempt appends one more turn, so every timed call folds exactly one appended turn.
    const appended: number[] = [];
    for (let i = 0; i < 3; i++) {
      appendFileSync(path, JSON.stringify(asst(`appended${i}`, 'claude-opus-5', usage(1, 1, 1, 1))) + '\n');
      appended.push(await time());
    }
    expect(Math.min(...appended)).toBeLessThanOrEqual(20);
  });
});
