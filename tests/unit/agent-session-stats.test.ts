/**
 * Unit tests for the agent-terminal route's session-stats math:
 *   - `priceForModel` — current-generation list prices per tier, legacy-Opus detection,
 *     Fable/Mythos priced at their own tier (not the old Opus placeholder)
 *   - `computeSessionStats` — cost is summed per unique `message.id` (Claude Code writes
 *     one JSONL line per content block, all repeating the same usage), sidechain turns
 *     count toward cost but never toward the context-window footprint, and the
 *     1M-context limit heuristic still applies.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priceForModel, computeSessionStats } from '../../src/server/routes/agent-terminal.js';

const line = (
  usage: Record<string, number>,
  over: { id?: string; model?: string; isSidechain?: boolean } = {},
): string =>
  JSON.stringify({
    ...(over.isSidechain !== undefined ? { isSidechain: over.isSidechain } : {}),
    message: {
      id: over.id ?? 'msg_default',
      ...(over.model !== undefined ? { model: over.model } : {}),
      usage,
    },
  });

const writeTranscript = (lines: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-stats-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
};

describe('priceForModel — tier resolution', () => {
  it('prices current Opus at $5/$25 (not the legacy $15/$75)', () => {
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'opus']) {
      expect(priceForModel(id)).toMatchObject({ in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    }
  });

  it('prices legacy Opus (4.1 / 4.0 / 3) at $15/$75', () => {
    for (const id of ['claude-opus-4-1-20250805', 'claude-opus-4-1', 'claude-opus-4-20250514', 'claude-3-opus-20240229']) {
      expect(priceForModel(id)).toMatchObject({ in: 15, out: 75 });
    }
  });

  it('prices Fable/Mythos at $10/$50', () => {
    expect(priceForModel('claude-fable-5')).toMatchObject({ in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1 });
    expect(priceForModel('claude-mythos-5')).toMatchObject({ in: 10, out: 50 });
  });

  it('prices Sonnet at $3/$15 and Haiku at $1/$5', () => {
    expect(priceForModel('claude-sonnet-5')).toMatchObject({ in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 });
    expect(priceForModel('claude-haiku-4-5-20251001')).toMatchObject({ in: 1, out: 5 });
  });

  it('defaults unknown models to the current Opus tier', () => {
    expect(priceForModel('')).toMatchObject({ in: 5, out: 25 });
    expect(priceForModel('some-future-model')).toMatchObject({ in: 5, out: 25 });
  });
});

describe('computeSessionStats — per-message dedupe', () => {
  it('counts a message once no matter how many content-block lines repeat its usage', () => {
    const usage = { input_tokens: 100, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const path = writeTranscript([
      line(usage, { id: 'msg_1', model: 'claude-opus-4-8' }),
      line(usage, { id: 'msg_1', model: 'claude-opus-4-8' }),
      line(usage, { id: 'msg_1', model: 'claude-opus-4-8' }),
    ]);
    const stats = computeSessionStats(path);
    // 100 * $5/M + 1000 * $25/M = 0.0005 + 0.025
    expect(stats.costUsd).toBeCloseTo(0.0255, 6);
    expect(stats.contextTokens).toBe(1100);
  });

  it('sums distinct messages, each at its own model rate', () => {
    const path = writeTranscript([
      line({ input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, { id: 'a', model: 'claude-opus-4-8' }),
      line({ input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, { id: 'b', model: 'claude-haiku-4-5-20251001' }),
    ]);
    expect(computeSessionStats(path).costUsd).toBeCloseTo(6, 6); // $5 + $1
  });

  it('applies cache-write and cache-read rates', () => {
    const path = writeTranscript([
      line({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }, { id: 'a', model: 'claude-opus-4-8' }),
    ]);
    expect(computeSessionStats(path).costUsd).toBeCloseTo(6.75, 6); // $6.25 + $0.50
  });
});

describe('computeSessionStats — sidechain handling', () => {
  it('bills sidechain turns but keeps the context footprint on the main chain', () => {
    const path = writeTranscript([
      line({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }, { id: 'main', model: 'claude-opus-4-8' }),
      line({ input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, { id: 'side', model: 'claude-opus-4-8', isSidechain: true }),
    ]);
    const stats = computeSessionStats(path);
    expect(stats.contextTokens).toBe(100); // the main turn, not the later sidechain
    expect(stats.costUsd).toBeGreaterThan(5); // the sidechain's $5 of input is still billed
  });
});

describe('computeSessionStats — context limit heuristic', () => {
  it('defaults to 200K and bumps to 1M for [1m] model ids or oversized footprints', () => {
    const small = writeTranscript([
      line({ input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, { id: 'a', model: 'claude-opus-4-8' }),
    ]);
    expect(computeSessionStats(small).contextLimit).toBe(200_000);

    const oneM = writeTranscript([
      line({ input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, { id: 'a', model: 'claude-opus-4-8[1m]' }),
    ]);
    expect(computeSessionStats(oneM).contextLimit).toBe(1_000_000);

    const big = writeTranscript([
      line({ input_tokens: 250_000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, { id: 'a', model: 'claude-opus-4-8' }),
    ]);
    expect(computeSessionStats(big).contextLimit).toBe(1_000_000);
  });
});

describe('computeSessionStats — degenerate inputs', () => {
  it('returns nulls for a missing file or a transcript with no usage', () => {
    expect(computeSessionStats('/nonexistent/nope.jsonl').costUsd).toBeNull();
    const empty = writeTranscript(['{"type":"summary"}', 'not json']);
    expect(computeSessionStats(empty).contextTokens).toBeNull();
  });
});
