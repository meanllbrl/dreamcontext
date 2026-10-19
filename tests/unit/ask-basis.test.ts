/**
 * The ask basis matches only the owner's real messages (C4, D1).
 *
 * A quote that sleep files a task on must be something a human TYPED in a
 * session being consolidated. Each non-human source gets its own refusal test:
 * a tool result, hook context (an attachment record and a reminder inlined into
 * a turn), a sub-agent notification, skill-loader text and `tasks show` output
 * (the fenced task packet, inside a turn and as a tool result).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  basisSessions,
  ownerTurns,
  quoteIsAbout,
  quoteProblem,
  stripInjected,
  verifyAskQuote,
  verifyDefectEvidence,
  verifyProposalQuote,
  type BasisSession,
} from '../../src/lib/ask-basis.js';
import type { SessionRecord } from '../../src/lib/sleep-consolidation.js';
import { handoffContinuePrompt, LIMIT_CONTINUE_TEXT } from '../../src/lib/app-prompts.js';
import { INITIALIZER_KICKOFF_PROMPT } from '../../src/lib/onboarding/copy.js';

// The dashboard's prompt builders, rendered for real (their module reaches the API client).
vi.mock('../../dashboard/src/api/client', () => ({ api: { post: vi.fn() }, getActiveVault: () => 'test-vault' }));
const { developKickoffPrompt, trainKickoffPrompt, initializerKickoffPrompt } = await import('../../dashboard/src/lib/agentPrompt');
const { DELEGATE_MODES } = await import('../../dashboard/src/lib/delegateModes');

const ASK = 'please add a retry button to the export dialog';

const human = (text: string) => ({ type: 'user', promptSource: 'sdk', message: { role: 'user', content: text } });
const humanBlocks = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResult = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
});
const hookAttachment = (text: string) => ({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text] } });
const notification = (text: string) => ({
  type: 'user',
  promptSource: 'system',
  turnOrigin: 'task_notification',
  message: { role: 'user', content: `<task-notification><summary>${text}</summary></task-notification>` },
});
const legacyNotification = (text: string) => human(`<task-notification><result>${text}</result></task-notification>`);
const skillLoader = (text: string) => ({
  type: 'user',
  isMeta: true,
  message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: /skills/x\n\n${text}` }] },
});
const legacySkillLoader = (text: string) => human(`Base directory for this skill: /skills/x\n\n${text}`);
const packet = (text: string) => `--- TASK CONTEXT n0nce42 ---\n## This task: Export\n${text}\n--- END OF TASK CONTEXT n0nce42 ---`;
// A compaction's summary: user-role, model-written, none of isMeta/promptSource/turnOrigin.
const compactSummary = (text: string) => ({
  type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
  message: { role: 'user', content: `This session is being continued from a previous conversation. Summary: ${text}` },
});
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const sidechain = (text: string) => ({ ...human(text), isSidechain: true });

let dir: string;
let n = 0;
function session(...records: object[]): BasisSession {
  const path = join(dir, `s${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { id: `sess-${n}`, path };
}

beforeEach(() => {
  dir = join(tmpdir(), `dc-ask-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('verifyAskQuote — only words a human typed', () => {
  it('accepts the owner\'s own turn, punctuation and case aside', () => {
    const s = session(human('Hmm. Please add a retry button to the export dialog, it keeps failing!'));
    const m = verifyAskQuote([s], 'Please add a Retry button to the export-dialog');
    expect(m.ok).toBe(true);
    expect(m.session).toBe(s.id);
  });

  it('accepts a typed turn in the block-array shape', () => {
    expect(verifyAskQuote([session(humanBlocks(ASK))], ASK).ok).toBe(true);
  });

  it('refuses a quote found only in a tool result', () => {
    const m = verifyAskQuote([session(human('run the tests'), toolResult(`TODO: ${ASK}`))], ASK);
    expect(m.ok).toBe(false);
    expect(m.foundIn).toContain('tool result');
  });

  it('refuses a quote found only in hook context (attachment record)', () => {
    const m = verifyAskQuote([session(human('go on'), hookAttachment(`Memory recall: ${ASK}`))], ASK);
    expect(m.ok).toBe(false);
    expect(m.foundIn).toContain('hook context');
  });

  it('refuses a quote found only in hook context inlined into a turn', () => {
    const m = verifyAskQuote([session(human(`go on\n<system-reminder>${ASK}</system-reminder>`))], ASK);
    expect(m.ok).toBe(false);
    expect(m.foundIn).toContain('task data or injected block inside a turn');
  });

  it('refuses a quote found only in a sub-agent notification (stamped and legacy shapes)', () => {
    const stamped = verifyAskQuote([session(notification(ASK))], ASK);
    expect(stamped.ok).toBe(false);
    expect(stamped.foundIn).toContain('injected message');
    const legacy = verifyAskQuote([session(legacyNotification(ASK))], ASK);
    expect(legacy.ok).toBe(false);
    expect(legacy.foundIn).toContain('sub-agent notification or skill-loader text');
  });

  it('refuses a quote found only in skill-loader text (stamped and legacy shapes)', () => {
    const stamped = verifyAskQuote([session(skillLoader(ASK))], ASK);
    expect(stamped.ok).toBe(false);
    expect(stamped.foundIn).toContain('injected message');
    const legacy = verifyAskQuote([session(legacySkillLoader(ASK))], ASK);
    expect(legacy.ok).toBe(false);
    expect(legacy.foundIn).toContain('sub-agent notification or skill-loader text');
  });

  it('refuses a quote found only in `tasks show` output (fenced packet in a turn, or a tool result)', () => {
    const inTurn = verifyAskQuote([session(human(`Develop this.\n\n${packet(`Why: ${ASK}`)}`))], ASK);
    expect(inTurn.ok).toBe(false);
    expect(inTurn.foundIn).toContain('task data or injected block inside a turn');
    const asTool = verifyAskQuote([session(human('show it'), toolResult(packet(ASK)))], ASK);
    expect(asTool.ok).toBe(false);
    expect(asTool.foundIn).toContain('tool result');
  });

  it('refuses a quote found only in a compaction summary (the model wrote it)', () => {
    const m = verifyAskQuote([session(human('go on'), compactSummary(`The user asked: ${ASK}.`))], ASK);
    expect(m.ok).toBe(false);
    expect(m.foundIn).toContain('injected message');
    // Either flag alone is enough.
    const displayOnly = { ...compactSummary(ASK), isCompactSummary: undefined };
    expect(verifyAskQuote([session(displayOnly)], ASK).ok).toBe(false);
  });

  it('matches whole words only: "fix the readme" is not inside "prefix the readme"', () => {
    const s = session(human('please prefix the readme headings with the version'));
    expect(verifyAskQuote([s], 'fix the readme headings').ok).toBe(false);
    expect(verifyAskQuote([s], 'prefix the readme headings').ok).toBe(true);
  });

  it('refuses the assistant\'s words and a sub-agent transcript\'s turns', () => {
    const m = verifyAskQuote([session(assistant(`Shall I ${ASK}?`), sidechain(ASK))], ASK);
    expect(m.ok).toBe(false);
    expect(m.foundIn).toEqual(expect.arrayContaining(['assistant text', 'sub-agent transcript']));
  });

  it('still accepts the owner\'s words that sit OUTSIDE an injected block', () => {
    const m = verifyAskQuote([session(human(`${ASK}\n${packet('unrelated card text')}`))], ASK);
    expect(m.ok).toBe(true);
  });

  it('refuses words found nowhere, and says when no transcript was searched', () => {
    expect(verifyAskQuote([session(human('something else entirely'))], ASK).foundIn).toEqual([]);
    expect(verifyAskQuote([], ASK).searched).toBe(0);
  });
});

describe('verifyDefectEvidence — a tool result or an owner turn', () => {
  const ERR = 'TypeError: Cannot read properties of undefined (reading \'slug\')';
  it('accepts the failing output from a tool result', () => {
    expect(verifyDefectEvidence([session(human('run it'), toolResult(`at x\n${ERR}\n  at y`))], ERR).ok).toBe(true);
  });
  it('refuses evidence that only the assistant claimed', () => {
    const m = verifyDefectEvidence([session(assistant(`I think: ${ERR}`))], ERR);
    expect(m.ok).toBe(false);
    expect(m.foundIn).toContain('assistant text');
  });
});

describe('verifyProposalQuote — where a proposal came from', () => {
  it('accepts a line from the assistant or the owner, never hook context', () => {
    expect(verifyProposalQuote([session(assistant('we should cache the board query later'))], 'cache the board query later').ok).toBe(true);
    expect(verifyProposalQuote([session(hookAttachment('cache the board query later'))], 'cache the board query later').ok).toBe(false);
  });
});

describe('quoteIsAbout — the ask must be about this task', () => {
  it('needs a shared content word; function words do not count', () => {
    expect(quoteIsAbout(ASK, 'Export dialog gets a retry button')).toBe(true);
    expect(quoteIsAbout('can you make the board remember my last filter', 'Update the README after the release')).toBe(false);
    expect(quoteIsAbout('please do this for me now', 'Please do the release notes for me')).toBe(false);
    expect(quoteIsAbout('görevleri tek tıkla reddedebileyim', 'Görevler ekranında tek tık ret')).toBe(true);
  });
});

describe('quoteProblem, stripInjected, basisSessions', () => {
  it('a quote must be several real words', () => {
    expect(quoteProblem('yes do it')).toMatch(/at least/);
    expect(quoteProblem(ASK)).toBeNull();
  });
  it('strips reminders, hook tags, pasted content, shell output and the task fence', () => {
    const t = stripInjected([
      'keep me',
      '<system-reminder>a</system-reminder>',
      '<user-prompt-submit-hook>b</user-prompt-submit-hook>',
      '<pasted_content id="1">c</pasted_content>',
      '<bash-stdout>d</bash-stdout>',
      packet('e'),
    ].join('\n'));
    expect(t.replace(/\s+/g, ' ').trim()).toBe('keep me');
  });
  it('skips spawned sessions and missing transcripts', () => {
    const real = session(human(ASK));
    const rec = (id: string, path: string | null, spawned = false): SessionRecord => ({
      session_id: id, transcript_path: path, stopped_at: null, last_assistant_message: null,
      change_count: null, tool_count: null, score: null, task_slugs: [],
      ...(spawned ? { spawn: { by: 'develop', via: 'env' } } : {}),
    } as SessionRecord);
    const out = basisSessions([rec('a', real.path), rec('b', real.path, true), rec('c', join(dir, 'gone.jsonl')), rec('d', null)]);
    expect(out.map((s) => s.id)).toEqual(['a']);
  });
});

/**
 * F10 (2026-10-19), on the owner's real brain: a 7-day backfill counted 1000 "owner corrections"
 * and grouped 14, practically none of them the owner's words. Three leaks, each closed here, and
 * each fixture SYNTHETIC (a fictional project, "Larkspur Ledger"; no real transcript text).
 */
const OWNER = 'please add a retry button to the export dialog';
const REPORT = 'such a widget cannot grant a refund without the ledger owner';

/** A: the raw API request copy Claude Code writes beside the real records (no uuid, role user). */
const apiBlob = (...texts: string[]) => ({
  type: 'api-request-blob', hash: 'h0c1', sessionId: 'sess-blob',
  message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_9', content: 'all 12 ledger tests passed' },
    ...texts.map((text) => ({ type: 'text', text })),
  ] },
});
const handBack = (id: string) => `<system-reminder id="${id}">\nAnother Claude session sent a message while you were working:\n`
  + `<agent-message from="a8de3241">\n[Subagent hand-back] The text below is the final report of a subagent. ${REPORT}.\n</agent-message>\n</system-reminder>`;

describe('A: only a `type: "user"` record can be a human turn', () => {
  it('a raw API request copy is never one, even when it carries the queued owner text', () => {
    const s = session(apiBlob(handBack('8fc0e187'), OWNER));
    expect(ownerTurns(s.path)).toEqual([]);
    const m = verifyAskQuote([s], REPORT);
    expect(m.ok).toBe(false);
    expect(m.foundIn).toContain('raw API request copy');
    expect(verifyAskQuote([s], OWNER).ok).toBe(false);
  });

  it('the owner\'s own turn next to it still counts, and its quote is found', () => {
    const s = session(apiBlob(handBack('8fc0e187'), OWNER), human(OWNER));
    expect(ownerTurns(s.path).map((t) => t.text)).toEqual([OWNER]);
    expect(verifyAskQuote([s], OWNER).ok).toBe(true);
    expect(verifyAskQuote([s], REPORT).ok).toBe(false);
  });

  it('any other record type that carries a user message is not a turn either', () => {
    const s = session({ type: 'queue-operation', message: { role: 'user', content: OWNER } });
    expect(ownerTurns(s.path)).toEqual([]);
    expect(verifyAskQuote([s], OWNER).ok).toBe(false);
  });
});

describe('B: the harness\'s blocks are stripped with their attributes', () => {
  it('a reminder with an id, carrying an agent-message, and a plain one: neither is the owner\'s', () => {
    const s = session(
      humanBlocks(`${handBack('6d8b11aa')}\n${OWNER}`),
      humanBlocks(`<system-reminder>The ledger has 3 open refunds; ${REPORT}.</system-reminder>`),
    );
    expect(ownerTurns(s.path).map((t) => t.text)).toEqual([OWNER]);
    expect(verifyAskQuote([s], REPORT).ok).toBe(false);
    expect(verifyAskQuote([s], OWNER).ok).toBe(true);
  });

  it('a slash command turn: name and message go, the arguments the owner typed stay', () => {
    const cmd = (name: string, args: string) => `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`;
    const s = session(humanBlocks(cmd('clear', '')), humanBlocks(cmd('goal-skill', OWNER)));
    expect(ownerTurns(s.path).map((t) => t.text)).toEqual([OWNER]);
  });

  it('the server\'s blocks in an owner turn (live context, the Super Agent note) are not the owner\'s', () => {
    const live = `<live-context written-by="dreamcontext server" at="10:41">\nchat=1 status=working <untrusted-project-output vault="larkspur">topic: ${REPORT}</untrusted-project-output>\n</live-context>`;
    const note = '<super-agent-note> From now on the owner talks to you through the Super Agent; it relays your questions and answers. </super-agent-note>';
    const s = session({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: OWNER }, { type: 'text', text: live }, { type: 'text', text: note }] } });
    expect(ownerTurns(s.path).map((t) => t.text)).toEqual([OWNER]);
    expect(verifyAskQuote([s], REPORT).ok).toBe(false);
  });

  it('a whole turn the server writes (an Assistant wake, a Super Agent event) is not the owner\'s', () => {
    const s = session(
      human(`[delegated-session event] session=7f00 vault=larkspur status=idle\n<untrusted-project-output vault="larkspur">Last reply: ${REPORT}</untrusted-project-output>\nSay what changed.`),
      human(`[super event] item=q1 child=7f00 status=asking\n${REPORT}`),
    );
    expect(ownerTurns(s.path)).toEqual([]);
    const m = verifyAskQuote([s], REPORT);
    expect(m.ok).toBe(false);
    expect(m.foundIn).toContain('dreamcontext prompt');
  });
});

describe('C: dreamcontext\'s own prompts are not the owner\'s words', () => {
  const TASK = {
    slug: 'larkspur-refunds', name: 'Ledger refunds', description: 'Refunds post to the ledger.', why: 'Refunds vanish today.',
    user_stories: '- As an owner, I can refund', acceptance_criteria: '- [ ] A refund posts',
  } as never;
  const flat = (t: string) => t.replace(/[\n\t]+/g, ' ');
  const refused = 'The "Go to development" hand-off for `larkspur-refunds` was refused — the task is missing:\n\n• why: missing\n\n'
    + 'Fill each into the task with `dreamcontext tasks insert larkspur-refunds <section> "…"`, confirm `dreamcontext tasks ready larkspur-refunds` passes, then offer the develop button again.';
  const TEMPLATES: Array<[string, string]> = [
    ['develop kickoff', developKickoffPrompt('larkspur-refunds')],
    ['train kickoff', trainKickoffPrompt('ledger-digest', 'Ledger digest')],
    ['initializer kickoff (dashboard)', initializerKickoffPrompt()],
    ['initializer kickoff (CLI)', INITIALIZER_KICKOFF_PROMPT],
    ['refused Develop hand-off', refused],
    ['usage-limit continue', LIMIT_CONTINUE_TEXT],
    ['handoff continue', handoffContinuePrompt('Ledger refunds', 'larkspur-refunds')],
    ...DELEGATE_MODES.map((m): [string, string] => [`delegate: ${m.id}`, m.build(TASK, 'Ledger refunds')]),
  ];

  for (const [name, text] of TEMPLATES) {
    it(`${name}: alone (as sent, and flattened), no owner turn and no ask match`, () => {
      const s = session(human(text), humanBlocks(flat(text)));
      expect(ownerTurns(s.path)).toEqual([]);
      // Any fixed sentence of it, quoted as the owner's, is refused.
      const sentence = flat(text).split(/(?<=[.!?])\s+/).find((x) => x.split(' ').length >= 6) ?? flat(text);
      const m = verifyAskQuote([s], sentence);
      expect(m.ok).toBe(false);
      expect(m.foundIn).toContain('dreamcontext prompt');
    });

    it(`${name}: with the owner's words appended, only those are the owner's`, () => {
      const s = session(human(`${text}\n\n${OWNER}`));
      expect(ownerTurns(s.path).map((t) => t.text.replace(/\s+/g, ' ').trim())).toEqual([OWNER]);
      expect(verifyAskQuote([s], OWNER).ok).toBe(true);
    });
  }
});
