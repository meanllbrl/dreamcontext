/**
 * D3's drift guard (plan uye-gecmis-is, pattern mirror-with-drift-test): every place the server or
 * the bridge writes a user frame into a chat process is listed here with the text it writes and
 * that text's class under `classifyUserEntry`. A new write site, or a server text that
 * `isServerContinuationText` does not match, fails this test: classify the new text (a server
 * text continues the open job; anything a person typed asks) and add it below.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isServerContinuationText, SERVER_CONTINUATION_OPENINGS } from '../../src/lib/usage-readers.js';
import { classifyUserEntry, hookQueryOf } from '../../src/lib/agents/work-trace.js';
import { CARD_RECEIPT_OPENINGS, recallQuery, recallTurn } from '../../src/lib/agents/team-roster.js';
import { AUTH_CONTINUE_TEXT, LIMIT_CONTINUE_TEXT } from '../../src/server/routes/agent-chat.js';
import { RESET_CONTINUE_TEXT } from '../../src/lib/resume-at-reset.js';
import { CODEX_LIMIT_CONTINUE_TEXT, toolSwitchFor } from '../../src/lib/tool-switch.js';
import { ALLOW_TURN_HEAD, REWRITE_TURN_HEAD, OWED_PREFIX } from '../../src/lib/super/inbox.js';
import { REASK_TEXT, RESUME_TEXT } from '../../src/lib/super/outbox.js';
import { CARD_OVERFLOW_TEXT } from '../../src/lib/assistant/chat-registry.js';
import { buildInterruptedReport } from '../../src/lib/run-report.js';
import { SUPER_ANSWER_PREFIX } from '../../src/lib/super/answer.js';
import { feedbackTurn } from '../../src/server/card-feedback.js';
import { undeliveredNote } from '../../src/lib/super/undelivered.js';

const ROOT = join(__dirname, '..', '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
const mid = (text: string) => classifyUserEntry({ text, steer: false }, { openJob: { lastAsk: 'another ask', repliedSinceLastAsk: true }, first: false, segmentWorked: true });

/** Every text the server or the bridge writes on its own: each continues the open job. */
const SERVER_TEXTS: Array<[string, string]> = [
  ['reset continue', RESET_CONTINUE_TEXT],
  ['Claude limit continue', LIMIT_CONTINUE_TEXT],
  ['sign-in continue', AUTH_CONTINUE_TEXT],
  ['Codex limit continue', CODEX_LIMIT_CONTINUE_TEXT],
  ...(['claude', 'codex', 'antigravity'] as const).map((t): [string, string] => [`${t} limitContinueText`, toolSwitchFor(t).limitContinueText]),
  ['Allow turn', `${ALLOW_TURN_HEAD} \`npm test\` to run. It ran:`],
  ['rewrite turn', `${REWRITE_TURN_HEAD} stopped it.`],
  ['re-ask after relaunch', REASK_TEXT],
  ['resume after relaunch', RESUME_TEXT],
  ['card overflow', CARD_OVERFLOW_TEXT({ kind: 'question', id: 'c1' } as Parameters<typeof CARD_OVERFLOW_TEXT>[0])],
  ['interrupted run report', buildInterruptedReport('npm test')],
  ['Super answer', `${SUPER_ANSWER_PREFIX} item=q1 yes`],
  ['Super owed', `${OWED_PREFIX} item=q1`],
  ['Super recap', '[super recap] item=r1 children=2'],
  ['Super handover', '[super handover] item=h1 children=1'],
  ['Super fresh', '[super fresh] item=f1 children=0'],
  ['secret receipt', '[secret submitted · FIRECRAWL_KEY → .env]'],
  ['checklist receipt', 'Checklist: asc-key\n- [x] Open Users and Access'],
  ['MCP connected receipt', 'MCP connected: posthog\nposthog was already set up'],
  ['MCP skipped receipt', 'MCP skipped: posthog'],
  ['ran in chat receipt', '[ran in chat]\n$ firebase login\nexit 0'],
  ['bridge Stop hook turn', 'Stop hook feedback:\n[goal]: keep going'],
  ['card feedback note', feedbackTurn([undeliveredNote(['a drawing'])])!],
  ['undelivered note alone', undeliveredNote(['a drawing'])!],
];

describe('server texts continue (D3 rule 3)', () => {
  for (const [name, text] of SERVER_TEXTS) {
    it(`${name} is a server continuation, and the hook does not query on it`, () => {
      expect(isServerContinuationText(text)).toBe(true);
      expect(mid(text)).toBe('continuation');
      expect(hookQueryOf(text)).toBeNull();
    });
  }
  it('every mirrored opening stands for a text above', () => {
    for (const o of SERVER_CONTINUATION_OPENINGS) expect(SERVER_TEXTS.some(([, t]) => t.trimStart().startsWith(o)), o).toBe(true);
  });
  it('a card receipt runs no recall, and every mirrored receipt opening is a server text', () => {
    for (const o of CARD_RECEIPT_OPENINGS) expect((SERVER_CONTINUATION_OPENINGS as readonly string[]).includes(o), o).toBe(true);
    for (const t of ['MCP connected: posthog\nposthog was already set up for this project, so dreamcontext restarted this chat with it: the tools are loaded now. Carry on with the task.', 'MCP skipped: kestrel-db\nThe owner chose to continue without: kestrel-db.', '[secret submitted · Lumen API key]']) {
      expect(recallQuery(t)).toBeNull();
      expect(recallTurn(t)).toBeNull();
    }
    expect(recallQuery('connect the MCP for kestrel and fix the price row')).not.toBeNull();
  });
  it('a person\'s words are never a server text', () => {
    for (const t of ['fix the kestrel price row', '/tmp/shot.png why red?', '[Reply to message ref=ab12] yes', '[About agenda line 3] move it']) {
      expect(isServerContinuationText(t)).toBe(false);
      expect(mid(t)).toBe('ask');
    }
  });
});

/**
 * Every user-frame write site, by file. The count is the guard: a new site changes it. Each
 * entry names what that site writes and its class.
 */
const SITES: Array<{ file: string; re: RegExp; count: number; writes: string }> = [
  { file: 'src/server/routes/agent-chat.ts', re: /type: 'user'/g, count: 13, writes:
    'telegram injector (his words: ask) · crew server turn (sendServerTurn texts above: continuation) · owner receipt (card receipts: continuation) · '
    + 'undelivered card feedback (continuation) · spawn opening prompt (first: ask) · socket turn (his words: ask; a server-written one per its text) · '
    + 'handoff writeUserTurn (/clear: none; continue prompt: the new transcript\'s first: ask) · turn-end card feedback (continuation) · '
    + 'account-switch resend (resubmit of the last ask: continuation) · window send (ask) · MCP grant receipt (continuation) · /effort (none by outcome)' },
  { file: 'src/lib/t3-bridge/stdio.ts', re: /handle\(\{ type: 'user'/g, count: 2, writes: 'the bridge\'s queued turn (the text it was given) · Stop hook feedback (continuation)' },
  { file: 'src/server/routes/handoff-rotation.ts', re: /input\.writeUserTurn\(/g, count: 2, writes: '/clear (none) · the handoff continue prompt (first entry of the new transcript: ask)' },
  { file: 'src/lib/t3-bridge/replace-session.ts', re: /handoffContinuePrompt\(/g, count: 1, writes: 'the bridge pane\'s continue prompt (first entry of the new thread: ask)' },
];

const SERVER_TURN_CALLERS: Array<{ file: string; count: number; writes: string }> = [
  { file: 'src/server/routes/super.ts', count: 1, writes: 'a Super request or reply to a live member (its batch text: ask or continuation)' },
  { file: 'src/lib/assistant/chat-registry.ts', count: 1, writes: 'CARD_OVERFLOW_TEXT (continuation)' },
  { file: 'src/lib/super/inbox.ts', count: 2, writes: 'the Super\'s notes (owed, answer: continuation) · the Allow turn (continuation)' },
  { file: 'src/lib/super/answer.ts', count: 1, writes: 'SUPER_ANSWER_PREFIX (continuation)' },
];

describe('the write sites are all listed (pattern mirror-with-drift-test)', () => {
  for (const s of SITES) {
    it(`${s.file}: ${s.count} site(s)`, () => {
      expect(count(src(s.file), s.re), `a user-frame write site was added or removed in ${s.file}: classify what it writes (${s.writes}) and update this list`).toBe(s.count);
    });
  }
  for (const s of SERVER_TURN_CALLERS) {
    it(`${s.file}: ${s.count} sendServerTurn caller(s)`, () => {
      expect(count(src(s.file), /\.sendServerTurn\(/g), `a sendServerTurn caller changed in ${s.file}: its text must match isServerContinuationText`).toBe(s.count);
    });
  }
  it('the outbox writes server texts from two places', () => {
    const n = ['src/lib/super/inbox.ts', 'src/lib/super/answer.ts'].reduce((k, f) => k + count(src(f), /addToOutbox\(.*server: true/g), 0);
    expect(n).toBe(2);
    const outbox = src('src/lib/super/outbox.ts');
    // The relaunch writers keep their texts (REASK_TEXT, RESUME_TEXT, checked above).
    expect(count(outbox, /export const (REASK|RESUME)_TEXT/g)).toBe(2);
  });
});
