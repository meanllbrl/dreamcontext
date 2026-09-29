import { describe, it, expect } from 'vitest';
import {
  INJECTED_TURN_ORIGINS, isInjectedUserRecord, humanTurnText, isSystemNoiseMessage,
} from '../../src/lib/transcript-records.js';
import { isSystemNoiseMessage as reExported } from '../../src/cli/commands/transcript.js';

function userRec(content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', message: { role: 'user', content }, ...extra };
}

describe('isInjectedUserRecord', () => {
  it('flags isMeta records (skill loaders, peer hand-backs)', () => {
    expect(isInjectedUserRecord(userRec('Base directory for this skill: /x', { isMeta: true }))).toBe(true);
  });

  it('flags promptSource "system" records (task notifications)', () => {
    expect(isInjectedUserRecord(userRec('<task-notification>…', { promptSource: 'system' }))).toBe(true);
  });

  it.each([...INJECTED_TURN_ORIGINS])('flags turnOrigin "%s"', (origin) => {
    expect(isInjectedUserRecord(userRec('x', { turnOrigin: origin }))).toBe(true);
  });

  it('does not flag a typed or SDK-sent human turn', () => {
    expect(isInjectedUserRecord(userRec('fix it', { promptSource: 'typed' }))).toBe(false);
    expect(isInjectedUserRecord(userRec('fix it', { promptSource: 'sdk', turnOrigin: 'sdk' }))).toBe(false);
  });

  it('does not flag a record that carries no provenance fields (older transcripts)', () => {
    expect(isInjectedUserRecord(userRec('fix it'))).toBe(false);
  });

  it('ignores a non-boolean isMeta', () => {
    expect(isInjectedUserRecord(userRec('fix it', { isMeta: 'true' }))).toBe(false);
  });
});

describe('humanTurnText', () => {
  it('returns trimmed string content of a human turn', () => {
    expect(humanTurnText(userRec('  no, use the staging endpoint  '))).toBe('no, use the staging endpoint');
  });

  it('joins text blocks and bare strings, ignoring tool_result blocks', () => {
    const rec = userRec([
      { type: 'text', text: 'first' },
      { type: 'tool_result', content: 'No open tabs' },
      'second',
    ]);
    expect(humanTurnText(rec)).toBe('first second');
  });

  it('returns null for a tool_result-only record', () => {
    expect(humanTurnText(userRec([{ type: 'tool_result', content: 'error: failed' }]))).toBeNull();
  });

  it('returns null for injected records even when the text looks human', () => {
    const peer = userRec('Another Claude session sent a message: actually, use X instead of Y', {
      isMeta: true, promptSource: 'system', turnOrigin: 'peer',
    });
    expect(humanTurnText(peer)).toBeNull();
    expect(humanTurnText(userRec('Continue the sleep cycle', { turnOrigin: 'scheduled' }))).toBeNull();
  });

  it('falls back to the text-shape noise filter on records without provenance fields', () => {
    expect(humanTurnText(userRec('<task-notification><task-id>a</task-id></task-notification>'))).toBeNull();
  });

  it('returns null for assistant records and empty text', () => {
    expect(humanTurnText({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })).toBeNull();
    expect(humanTurnText(userRec('   '))).toBeNull();
  });

  it('accepts the flat record shape (role and content at top level)', () => {
    expect(humanTurnText({ role: 'user', content: 'flat shape' })).toBe('flat shape');
  });

  it('never throws on odd shapes', () => {
    expect(humanTurnText({})).toBeNull();
    expect(humanTurnText({ message: null })).toBeNull();
    expect(humanTurnText(userRec(42))).toBeNull();
    expect(humanTurnText(userRec([null, 7, { type: 'text', text: 3 }]))).toBeNull();
  });
});

describe('isSystemNoiseMessage (moved here, still re-exported from transcript.ts)', () => {
  it('is the same function through both import paths', () => {
    expect(reExported).toBe(isSystemNoiseMessage);
  });
});
