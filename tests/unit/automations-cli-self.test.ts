import { describe, it, expect, afterEach, vi } from 'vitest';
import { refuseOtherAgent } from '../../src/cli/commands/automations.js';
import { AGENT_SELF_ENV } from '../../src/lib/automations/types.js';

/**
 * The CLI's second layer behind a scoped run's permission rules: while
 * `AGENT_SELF_ENV` is set, `post`/`learn`/`propose` only act for that slug.
 * The integration suite proves it end to end through the built CLI; this pins
 * the decision itself, including the empty-value case, without a build.
 */
describe('refuseOtherAgent', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('lets anything through when the variable is unset (a human at a terminal)', () => {
    expect(refuseOtherAgent('any-agent', 'post', {})).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('lets the agent act for its own slug', () => {
    expect(refuseOtherAgent('self-agent', 'learn', { [AGENT_SELF_ENV]: 'self-agent' })).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses another slug, naming both, and sets a failing exit code', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(refuseOtherAgent('other-agent', 'propose', { [AGENT_SELF_ENV]: 'self-agent' })).toBe(true);
    expect(process.exitCode).toBe(1);
    const printed = [...spy.mock.calls, ...log.mock.calls].flat().join('\n');
    expect(printed).toContain('"self-agent"');
    expect(printed).toContain('propose for itself, not for "other-agent"');
  });

  it('treats an empty value as set, and refuses', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(refuseOtherAgent('other-agent', 'post', { [AGENT_SELF_ENV]: '' })).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('compares exactly: a near-miss slug is another agent', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(refuseOtherAgent('self-agent ', 'post', { [AGENT_SELF_ENV]: 'self-agent' })).toBe(true);
  });
});
