import { describe, it, expect, vi } from 'vitest';
import {
  extractRecallQueries,
  SYSTEM_PROMPT,
  type ClaudeExecutor,
} from '../../src/lib/recall-query-extractor.js';

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

describe('recall-query-extractor', () => {
  it('returns parsed queries from valid Haiku response', () => {
    const executor: ClaudeExecutor = () => jsonBlock({
      queries: [
        { q: 'auth token refresh', types: ['knowledge'] },
        { q: 'session management', types: ['feature', 'task'] },
      ],
      skip: false,
    });

    const result = extractRecallQueries('How does the auth token refresh work?', { executor });

    expect(result.skip).toBe(false);
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0].q).toBe('auth token refresh');
    expect(result.queries[0].types).toEqual(['knowledge']);
    expect(result.queries[1].q).toBe('session management');
    expect(result.queries[1].types).toEqual(['feature', 'task']);
  });

  it('returns skip=true when Haiku says skip', () => {
    const executor: ClaudeExecutor = () => jsonBlock({ queries: [], skip: true });

    const result = extractRecallQueries('ok', { executor });

    expect(result.skip).toBe(true);
    expect(result.queries).toEqual([]);
  });

  it('returns fallback on invalid JSON', () => {
    const executor: ClaudeExecutor = () => 'this is not json at all';

    const result = extractRecallQueries('tell me about the architecture', { executor });

    expect(result.skip).toBe(false);
    expect(result.queries).toEqual([]);
  });

  it('returns fallback when executor throws', () => {
    const executor: ClaudeExecutor = () => { throw new Error('command not found'); };

    const result = extractRecallQueries('what is the database schema?', { executor });

    expect(result.skip).toBe(false);
    expect(result.queries).toEqual([]);
  });

  it('passes prompt and system prompt to executor', () => {
    const executor = vi.fn<ClaudeExecutor>().mockReturnValue(jsonBlock({ queries: [], skip: true }));

    extractRecallQueries('my test prompt', { executor });

    expect(executor).toHaveBeenCalledWith('my test prompt', SYSTEM_PROMPT);
  });

  it('filters invalid corpus types', () => {
    const executor: ClaudeExecutor = () => jsonBlock({
      queries: [
        { q: 'deployment pipeline', types: ['knowledge', 'invalid', 'bogus'] },
        { q: 'api routes', types: ['feature'] },
      ],
      skip: false,
    });

    const result = extractRecallQueries('how do we deploy?', { executor });

    expect(result.queries).toHaveLength(2);
    expect(result.queries[0].types).toEqual(['knowledge']);
    expect(result.queries[1].types).toEqual(['feature']);
  });

  it('omits types when all entries are invalid', () => {
    const executor: ClaudeExecutor = () => jsonBlock({
      queries: [{ q: 'search terms', types: ['fake', 'nope'] }],
      skip: false,
    });

    const result = extractRecallQueries('some query', { executor });

    expect(result.queries).toHaveLength(1);
    expect(result.queries[0].q).toBe('search terms');
    expect(result.queries[0].types).toBeUndefined();
  });

  it('skips entries with empty q strings', () => {
    const executor: ClaudeExecutor = () => jsonBlock({
      queries: [
        { q: '', types: ['knowledge'] },
        { q: '  ', types: ['feature'] },
        { q: 'valid query' },
      ],
      skip: false,
    });

    const result = extractRecallQueries('test', { executor });

    expect(result.queries).toHaveLength(1);
    expect(result.queries[0].q).toBe('valid query');
  });

  it('handles raw JSON without code block wrapper', () => {
    const executor: ClaudeExecutor = () => JSON.stringify({
      queries: [{ q: 'raw json test' }],
      skip: false,
    });

    const result = extractRecallQueries('test', { executor });

    expect(result.queries).toHaveLength(1);
    expect(result.queries[0].q).toBe('raw json test');
  });
});
