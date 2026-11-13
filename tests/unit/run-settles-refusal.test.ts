/**
 * A child whose command a permission check refused leaves the owner a run card with that exact
 * command, so one command holds two waits: the refusal ("Allow") and the card ("Run"). His run of
 * the card is that refused call done by him: the refusal of the SAME command closes with it, so
 * the agenda and the Super stop saying the job waits for his permission (13 Nov, a release job:
 * "bastım ama hiçbir şey olmadı alo"). Any other refusal stays. And an owner card he already acted
 * on (its result on its way) no longer counts as waiting on him in the bar and the agenda.
 * Fictional commands (synthetic-fixtures).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/run-settles-refusal-home-`);
});

import { _resetChatRegistry, getChat, ownerWaitAnswered, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { refusalWait, refusalWaitId, refusalsSettledByRun, runReceiptCommand, type OwnerWait } from '../../src/lib/super/owner-wait.js';
import { buildRunReport } from '../../dashboard/src/components/sleepy/chat/runReport.js';
import { needsOwner } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import type { SuperQueueItem } from '../../dashboard/src/lib/superTypes.js';

const CMD = 'bash /tmp/acme-release/verify_tagged.sh';
const report = (command = CMD) => buildRunReport(command, { code: 0, tail: 'verified 20/20', seconds: 4 }, { includeOutput: true });
const refused = (command: string, tool = 'Bash'): OwnerWait => refusalWait(tool, command, 4000, { source: 'classifier' } as never);
const RUN_WAIT: OwnerWait = { kind: 'run', id: 'verify', line: 'run the check', key: CMD };

beforeEach(() => { _resetChatRegistry(); });

describe('a run of the card settles the refusal of the same command', () => {
  it('reads the command from the real run report', () => {
    expect(runReceiptCommand(report())).toBe(CMD);
    expect(runReceiptCommand('I did it in my terminal')).toBe('');
  });

  it('only the refusal of that exact shell command', () => {
    const same = refused(CMD);
    const other = refused('bash /tmp/acme-release/other.sh');
    const edit = refused(JSON.stringify({ file_path: '/tmp/x', content: CMD }), 'Write');
    expect(refusalsSettledByRun(report(), [RUN_WAIT, same, other, edit])).toEqual([same]);
    // A refusal whose input was cut (not whole) can not be proven the same call: it stays.
    const cut = { ...same, refusal: { ...same.refusal!, whole: false } };
    expect(refusalsSettledByRun(report(), [cut])).toEqual([]);
    // His own words are no run report: they answer every wait by the old rule, not this one.
    expect(refusalsSettledByRun('done', [same])).toEqual([]);
  });

  it('through the registry: the server-delivered receipt closes the card AND the refusal, by id', () => {
    const h = registerChat({ sessionId: 'c1', conversationId: null, vault: 'acme', mode: 'basic' });
    h.userSent('go');
    expect(getChat('c1')).toBeTruthy();
    h.userSent(report(), { server: true, ownerReceipt: { kind: 'run', id: 'verify' } });
    // Not held in this process (a woken child): both are remembered as answered, so the record's
    // items close when it is read again.
    expect(ownerWaitAnswered('c1', 'run', 'verify')).toBe(true);
    expect(ownerWaitAnswered('c1', 'refusal', refusalWaitId('Bash', CMD))).toBe(true);
    expect(ownerWaitAnswered('c1', 'refusal', refusalWaitId('Bash', 'bash /tmp/acme-release/other.sh'))).toBe(false);
  });
});

describe('an owner card he already acted on waits on him no more (bar, agenda)', () => {
  const item = (over: Partial<SuperQueueItem>): SuperQueueItem => ({
    id: 'q', sessionId: 'c1', kind: 'owner', state: 'escalated', createdAt: 1,
    card: { cardRef: 'a'.repeat(32), postingSession: 'c1', vault: 'acme', postingConversationId: 'c1', spec: { type: 'run', id: 'verify', command: CMD } as never, childRecordId: 'main', childId: 'c1', deliverTo: 'c1' },
    ...over,
  } as SuperQueueItem);
  it('open with no result: his; with a result on its way (sent, waking, held): not his', () => {
    expect(needsOwner(item({}))).toBe(true);
    for (const delivery of ['sent', 'waking', 'held:cap', 'held:no_window', 'held:phone'] as const) {
      expect(needsOwner(item({ delivery }))).toBe(false);
    }
  });
});
