import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * `announceTurn` — the banner for what a RESUMED turn said (an answered question, a
 * thread reply). A scheduled run has its own completion banner; a resume had none, so
 * the post the owner was waiting for landed in the channel in silence.
 */

const notifyViaBundle = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../src/lib/automations/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/automations/notifier.js')>()),
  notifyViaBundle,
}));

const { announceTurn, appendThreadEntry, newThreadEntryId, markThreadRead } =
  await import('../../src/lib/automations/threads.js');
const { createAutomation, automationsDir } = await import('../../src/lib/automations/store.js');

const RUN = '2026-09-27T06:30:00.000Z';
let projectRoot: string;
let contextRoot: string;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-announce-home-'));
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-announce-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  createAutomation(contextRoot, { slug: 'social', title: 'Social', days: 'daily', at: '09:30', prompt: 'go' });
  notifyViaBundle.mockReset();
  notifyViaBundle.mockReturnValue(true);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('announceTurn', () => {
  it("banners the agent's newest post after the marker, with the automation's title", () => {
    const since = newThreadEntryId();
    appendThreadEntry(contextRoot, 'social', { runId: RUN, kind: 'agent', via: 'cli', text: 'Plan approved.' });
    appendThreadEntry(contextRoot, 'social', { runId: RUN, kind: 'agent', via: 'cli', text: 'Cover v2 is ready — look first.' });
    expect(announceTurn(contextRoot, 'social', since, 'final message', home)).toBe(true);
    expect(notifyViaBundle).toHaveBeenCalledTimes(1);
    expect(notifyViaBundle.mock.calls[0][0]).toBe('Social');
    expect(notifyViaBundle.mock.calls[0][1]).toBe('Cover v2 is ready — look first.');
  });

  it('reads as a question when the turn ended by asking again', () => {
    const since = newThreadEntryId();
    appendThreadEntry(contextRoot, 'social', { runId: RUN, kind: 'system', event: 'asked', via: 'runner', text: 'Publish it?' });
    announceTurn(contextRoot, 'social', since, null, home);
    expect(notifyViaBundle.mock.calls[0][0]).toBe('Social — needs your answer');
    expect(notifyViaBundle.mock.calls[0][1]).toBe('Publish it?');
  });

  it("links the banner to the agent's thread when the project is a registered vault", () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'Sosyal Medya', path: projectRoot }] }));
    const since = newThreadEntryId();
    appendThreadEntry(contextRoot, 'social', { runId: RUN, kind: 'agent', via: 'cli', text: 'Cover is ready.' });
    announceTurn(contextRoot, 'social', since, null, home);
    expect(notifyViaBundle.mock.calls[0][3]).toMatchObject({ link: 'dreamcontext://project/Sosyal%20Medya/automation/social' });
  });

  it('carries no link for an unregistered project', () => {
    const since = newThreadEntryId();
    appendThreadEntry(contextRoot, 'social', { runId: RUN, kind: 'agent', via: 'cli', text: 'Cover is ready.' });
    announceTurn(contextRoot, 'social', since, null, home);
    expect(notifyViaBundle.mock.calls[0][3]).toMatchObject({ link: null });
  });

  it('ignores posts from before the marker and falls back to the final message', () => {
    appendThreadEntry(contextRoot, 'social', { runId: RUN, kind: 'agent', via: 'cli', text: 'old news' });
    const since = newThreadEntryId(Date.now() + 5);
    announceTurn(contextRoot, 'social', since, 'the turn said this', home);
    expect(notifyViaBundle.mock.calls[0][1]).toBe('the turn said this');
  });

  it('stays silent when the owner already read past the post', () => {
    const since = newThreadEntryId();
    const post = appendThreadEntry(contextRoot, 'social', { runId: RUN, kind: 'agent', via: 'cli', text: 'seen it' });
    markThreadRead(contextRoot, 'social', post.id, home);
    expect(announceTurn(contextRoot, 'social', since, null, home)).toBe(false);
    expect(notifyViaBundle).not.toHaveBeenCalled();
  });

  it('stays silent when the automation has notify: false', () => {
    const path = join(automationsDir(contextRoot), 'social.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace(/^notify: true$/m, 'notify: false'));
    const since = newThreadEntryId();
    appendThreadEntry(contextRoot, 'social', { runId: RUN, kind: 'agent', via: 'cli', text: 'quiet' });
    expect(announceTurn(contextRoot, 'social', since, null, home)).toBe(false);
    expect(notifyViaBundle).not.toHaveBeenCalled();
  });
});
