/**
 * Class blind-ack (sahip-karti-yerinde K6, criterion 6: a receipt is "never acked by a window
 * alone"). The window answers the server's `run_report` hub verb `{ok:true}` ONLY when the chat
 * took the report; a dead socket answers `{ok:false, error:'offline'}`, so the server keeps the
 * report held and delivers it on the next mount.
 *
 * `runHubCommand` lives inside the chat session's closure (a live WebSocket), so the verb's one
 * line is pinned by source and the rule it applies is exercised through `postToSession`, the
 * function it calls. Fictional session (synthetic-fixtures pattern).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { postToSession } from '../../dashboard/src/components/sleepy/chat/postToSession.js';
import type { ChatSession } from '../../dashboard/src/components/sleepy/chatSession.js';

const SRC = readFileSync(new URL('../../dashboard/src/components/sleepy/chatSession.ts', import.meta.url), 'utf-8');
const REPORT = '[ran in chat]\n$ node scripts/verify/look-export.mjs\nexit 0';

/** The run_report branch's answer, as the window computes it. */
const answerFor = (session: ChatSession) => (postToSession(session, REPORT) ? { ok: true } : { ok: false, error: 'offline' });

describe('the run_report hub verb acks only what the chat took', () => {
  it('maps the post to its answer, never a bare {ok:true}', () => {
    const branch = SRC.slice(SRC.indexOf("cmd.verb === 'run_report'"), SRC.indexOf("cmd.verb === 'html_snapshot'"));
    expect(branch).toMatch(/result = postToSession\(session, text\) \? \{ ok: true \} : \{ ok: false, error: 'offline' \};/);
    expect(branch).not.toMatch(/postToSession\(session, text\); result = \{ ok: true \}/);
  });

  it('send is declared as the boolean it returns', () => {
    expect(SRC).toMatch(/\n  send: \(text: string\) => boolean;/);
  });

  it('an offline post answers {ok:false, error:"offline"}', () => {
    const offline = { busy: false, send: () => false, steer: () => false, enqueue: () => {} } as unknown as ChatSession;
    expect(answerFor(offline)).toEqual({ ok: false, error: 'offline' });
  });

  it('a post the socket took answers {ok:true}', () => {
    const live = { busy: false, send: () => true, steer: () => false, enqueue: () => {} } as unknown as ChatSession;
    expect(answerFor(live)).toEqual({ ok: true });
  });
});
