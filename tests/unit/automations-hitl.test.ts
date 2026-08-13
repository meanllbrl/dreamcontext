/**
 * The question store.
 *
 * Two things are being protected here and they pull in different directions.
 * The FEATURE property: a question is the only record that an automation is
 * waiting on you, so nothing may silently delete or double-answer one. The
 * SECURITY property: `kind` decides whether an answer may resume a
 * `bypassPermissions` session, so an `approval` question must never acquire a
 * resumable session by any path — creation, backfill, or a hand-edited file.
 *
 * Every failure direction below is "not resumable" and "still pending", because
 * a question that cannot be answered is a nuisance and one that is answered
 * twice is a double-send.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ANSWERED_QUESTION_KEEP,
  allPendingQuestions,
  backfillQuestionSession,
  canResume,
  claimQuestion,
  createQuestion,
  hitlDir,
  hitlSlugDir,
  listQuestions,
  noteResolution,
  pendingQuestion,
  pruneAnsweredQuestions,
  questionExists,
  questionPath,
  readQuestion,
  recordSteer,
  refreshQuestion,
  reopenQuestion,
  resolveQuestion,
  setChannelRef,
  writeQuestion,
  type CreateQuestionInput,
} from '../../src/lib/automations/hitl.js';
import { HITL_DIR, type AutomationQuestion } from '../../src/lib/automations/types.js';

let contextRoot: string;
let root: string;

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const FIRED = '2026-08-09T18:00:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-hitl-'));
  contextRoot = join(root, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ask(overrides: Partial<CreateQuestionInput> = {}): AutomationQuestion {
  return createQuestion(contextRoot, {
    slug: 'eod-digest',
    runFiredAt: FIRED,
    kind: 'flow-hitl',
    sessionId: SESSION,
    channel: 'chat',
    question: 'Send the digest?',
    choices: ['send', 'revise', 'skip'],
    nowISO: '2026-08-09T18:05:00.000Z',
    ...overrides,
  });
}

describe('paths', () => {
  it('lives under automations/hitl/<slug>/, machine-local', () => {
    expect(hitlDir(contextRoot)).toBe(join(contextRoot, 'automations', HITL_DIR));
    expect(hitlSlugDir(contextRoot, 'eod-digest')).toBe(join(contextRoot, 'automations', 'hitl', 'eod-digest'));
  });

  it('refuses a traversal slug rather than building a path out of it', () => {
    // The slug is a PATH SEGMENT here. Every caller validates upstream, and that
    // is exactly the assumption not worth depending on.
    expect(() => hitlSlugDir(contextRoot, '../../etc')).toThrow(/unsafe slug/);
    expect(() => questionPath(contextRoot, '../../etc', 'q_1')).toThrow(/unsafe slug/);
  });

  it('refuses a traversal question id', () => {
    expect(() => questionPath(contextRoot, 'eod-digest', '../../../passwd')).toThrow(/unsafe id/);
  });
});

describe('creating and reading', () => {
  it('round-trips a question', () => {
    const q = ask();
    const read = readQuestion(questionPath(contextRoot, 'eod-digest', q.id));
    expect(read).toEqual(q);
    expect(read!.question).toBe('Send the digest?');
    expect(read!.choices).toEqual(['send', 'revise', 'skip']);
    expect(read!.state).toBe('pending');
  });

  it('is the runner\'s serial gate — pendingQuestion finds it', () => {
    const q = ask();
    expect(pendingQuestion(contextRoot, 'eod-digest')!.id).toBe(q.id);
  });

  it('answers the OLDEST pending when there is somehow more than one', () => {
    // A newer question from the same automation is by construction less informed
    // than the answer still outstanding on the older one.
    const first = ask({ nowISO: '2026-08-09T18:00:00.000Z' });
    ask({ nowISO: '2026-08-09T19:00:00.000Z' });
    expect(pendingQuestion(contextRoot, 'eod-digest')!.id).toBe(first.id);
  });

  it('has nothing pending once answered', () => {
    const q = ask();
    resolveQuestion(contextRoot, q, 'send', 'dashboard');
    expect(pendingQuestion(contextRoot, 'eod-digest')).toBeNull();
  });

  it('a missing directory reads as nothing, never a throw', () => {
    expect(listQuestions(contextRoot, 'never-existed')).toEqual([]);
    expect(pendingQuestion(contextRoot, 'never-existed')).toBeNull();
    expect(allPendingQuestions(contextRoot)).toEqual([]);
  });

  it('allPendingQuestions spans automations, oldest first', () => {
    ask({ slug: 'eod-digest', nowISO: '2026-08-09T19:00:00.000Z' });
    mkdirSync(join(contextRoot, 'automations', 'hitl', 'weekly-report'), { recursive: true });
    ask({ slug: 'weekly-report', nowISO: '2026-08-09T18:00:00.000Z' });
    expect(allPendingQuestions(contextRoot).map((q) => q.slug)).toEqual(['weekly-report', 'eod-digest']);
  });

  it('questionExists answers without throwing on a hostile id', () => {
    const q = ask();
    expect(questionExists(contextRoot, 'eod-digest', q.id)).toBe(true);
    expect(questionExists(contextRoot, 'eod-digest', '../../../etc/passwd')).toBe(false);
    expect(questionExists(contextRoot, '../../etc', q.id)).toBe(false);
  });
});

describe('kind is a security discriminator, not a label', () => {
  it('an approval question is created with NO session, even when one is handed in', () => {
    // The caller holding a session id is the runner — the very component that
    // would pass it here out of symmetry. Forced null, not merely expected null.
    const q = ask({ kind: 'approval', sessionId: SESSION });
    expect(q.sessionId).toBeNull();
    expect(readQuestion(questionPath(contextRoot, 'eod-digest', q.id))!.sessionId).toBeNull();
  });

  it('an approval question is never resumable, whatever the file on disk claims', () => {
    // The planted case: a hand-edited question naming a session it should not
    // have. Neutralised on the way IN, so no call site can forget to check.
    const q = ask({ kind: 'approval' });
    const path = questionPath(contextRoot, 'eod-digest', q.id);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    writeFileSync(path, JSON.stringify({ ...raw, sessionId: SESSION }), 'utf-8');
    const read = readQuestion(path)!;
    expect(read.sessionId).toBeNull();
    expect(canResume(read)).toBe(false);
  });

  it('an unrecognised kind reads as approval — the RESTRICTIVE side', () => {
    // The one place leniency points at the safe state rather than at the
    // pre-feature behaviour: a corrupt discriminator must fail toward "cannot be
    // resumed", never toward the elevated path.
    const q = ask();
    const path = questionPath(contextRoot, 'eod-digest', q.id);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    writeFileSync(path, JSON.stringify({ ...raw, kind: 'something-new' }), 'utf-8');
    const read = readQuestion(path)!;
    expect(read.kind).toBe('approval');
    expect(read.sessionId).toBeNull();
    expect(canResume(read)).toBe(false);
  });

  it('a flow-hitl question with a real session IS resumable', () => {
    expect(canResume(ask())).toBe(true);
  });

  it('a flow-hitl question whose run left no session is not resumable', () => {
    expect(canResume(ask({ sessionId: null }))).toBe(false);
  });

  it('rejects a session id that is not path-safe', () => {
    expect(ask({ sessionId: '../../etc/passwd' }).sessionId).toBeNull();
  });
});

describe('backfilling the session id', () => {
  it('fills a flow-hitl question asked by this fire', () => {
    const q = ask({ sessionId: null });
    const filled = backfillQuestionSession(contextRoot, 'eod-digest', FIRED, SESSION);
    expect(filled).toHaveLength(1);
    expect(refreshQuestion(contextRoot, q)!.sessionId).toBe(SESSION);
  });

  it('NEVER fills an approval question — the one path that could give it a session', () => {
    const q = ask({ kind: 'approval', sessionId: null });
    expect(backfillQuestionSession(contextRoot, 'eod-digest', FIRED, SESSION)).toEqual([]);
    expect(refreshQuestion(contextRoot, q)!.sessionId).toBeNull();
  });

  it('never repoints one that already names a session', () => {
    const q = ask({ sessionId: SESSION });
    backfillQuestionSession(contextRoot, 'eod-digest', FIRED, OTHER_SESSION);
    expect(refreshQuestion(contextRoot, q)!.sessionId).toBe(SESSION);
  });

  it('only touches questions from the matching fire', () => {
    const q = ask({ sessionId: null, runFiredAt: '2026-08-08T18:00:00.000Z' });
    expect(backfillQuestionSession(contextRoot, 'eod-digest', FIRED, SESSION)).toEqual([]);
    expect(refreshQuestion(contextRoot, q)!.sessionId).toBeNull();
  });

  it('ignores an unusable session id rather than writing it', () => {
    const q = ask({ sessionId: null });
    expect(backfillQuestionSession(contextRoot, 'eod-digest', FIRED, '../../nope')).toEqual([]);
    expect(refreshQuestion(contextRoot, q)!.sessionId).toBeNull();
  });
});

describe('claiming — disk is the authority, never the caller\'s copy', () => {
  it('claims a pending question exactly once', () => {
    const q = ask();
    const first = claimQuestion(contextRoot, q, 'send', 'dashboard', '2026-08-09T19:00:00.000Z');
    expect(first.claimed).toBe(true);
    expect(first.claimed && first.question.state).toBe('answered');
    expect(first.claimed && first.question.answer).toBe('send');
  });

  it('a second surface holding a stale copy is REFUSED, not allowed to resume again', () => {
    // Two taps a second apart would otherwise both resume the session and the
    // approved work would happen twice — the worst outcome this feature has.
    const q = ask();
    claimQuestion(contextRoot, q, 'send', 'dashboard');
    const second = claimQuestion(contextRoot, q, 'send', 'telegram');
    expect(second.claimed).toBe(false);
    expect(second.claimed === false && second.reason).toMatch(/already answered/);
    expect(second.claimed === false && second.question?.answeredVia).toBe('dashboard');
  });

  it('refuses when the question is gone', () => {
    const q = ask();
    rmSync(questionPath(contextRoot, 'eod-digest', q.id), { force: true });
    const result = claimQuestion(contextRoot, q, 'send', 'cli');
    expect(result.claimed).toBe(false);
    expect(result.claimed === false && result.reason).toMatch(/no longer exists/);
  });

  it('leaves no claim lock behind', () => {
    const q = ask();
    claimQuestion(contextRoot, q, 'send', 'dashboard');
    expect(existsSync(join(hitlSlugDir(contextRoot, 'eod-digest'), `${q.id}.claim`))).toBe(false);
  });
});

describe('steering — a correction revises, it never answers', () => {
  it('leaves the question PENDING', () => {
    // The property an incident bought: collapsing "help me fix this" and "go
    // ahead" into one gesture is how an instruction meant for the agent ends up
    // delivered to the world verbatim.
    const q = ask();
    const next = recordSteer(contextRoot, q, { text: 'make it shorter', via: 'telegram' });
    expect(next.state).toBe('pending');
    expect(pendingQuestion(contextRoot, 'eod-digest')!.id).toBe(q.id);
  });

  it('keeps the trail newest LAST — it reads as a conversation', () => {
    let q = ask();
    q = recordSteer(contextRoot, q, { text: 'first', via: 'cli' });
    q = recordSteer(contextRoot, q, { text: 'second', via: 'cli' });
    expect(q.steers.map((s) => s.text)).toEqual(['first', 'second']);
  });

  it('bounds the trail — past the cap the oldest fall off', () => {
    let q = ask();
    for (let i = 0; i < 20; i++) q = recordSteer(contextRoot, q, { text: `steer ${i}`, via: 'cli' });
    expect(q.steers).toHaveLength(12);
    expect(q.steers[q.steers.length - 1].text).toBe('steer 19');
  });

  it('can revise the question text itself', () => {
    const q = ask();
    const next = recordSteer(contextRoot, q, { text: 'ask differently', via: 'cli', newQuestion: 'Send the SHORT digest?' });
    expect(next.question).toBe('Send the SHORT digest?');
  });
});

describe('resolution outcome — recorded separately, on purpose', () => {
  it('notes what the agent said after the answer was acted on', () => {
    const q = resolveQuestion(contextRoot, ask(), 'send', 'dashboard');
    const noted = noteResolution(contextRoot, q, { note: 'Sent to 41 subscribers.' });
    expect(refreshQuestion(contextRoot, noted)!.resolutionNote).toBe('Sent to 41 subscribers.');
  });

  it('records a failed resume so it can never be mistaken for a clean success', () => {
    // The answer is persisted BEFORE the resume spawns, so a question whose
    // resume then failed reads `answered` on disk while nothing may have been
    // carried out. Without this field that is indistinguishable from done.
    const q = resolveQuestion(contextRoot, ask(), 'send', 'dashboard');
    const noted = noteResolution(contextRoot, q, { error: 'the resumed session timed out' });
    expect(noted.state).toBe('answered');
    expect(noted.resolutionError).toBe('the resumed session timed out');
  });

  it('reopens ONLY back to pending, clearing the answer that was never carried out', () => {
    const q = resolveQuestion(contextRoot, ask(), 'send', 'dashboard');
    const reopened = reopenQuestion(contextRoot, q, 'the claude binary could not be launched');
    expect(reopened.state).toBe('pending');
    expect(reopened.answer).toBeNull();
    expect(reopened.answeredAt).toBeNull();
    expect(reopened.answeredVia).toBeNull();
    expect(reopened.resolutionError).toMatch(/could not be launched/);
    expect(pendingQuestion(contextRoot, 'eod-digest')!.id).toBe(q.id);
  });
});

describe('channel refs', () => {
  it('records a handle so a steer edits in place rather than posting a second copy', () => {
    const q = setChannelRef(contextRoot, ask(), 'telegram', '4242');
    expect(refreshQuestion(contextRoot, q)!.channelRefs.telegram).toBe('4242');
  });
});

describe('pruning cannot lose a question you owe an answer to', () => {
  it('never drops a PENDING question, at any count', () => {
    const pending = ask();
    for (let i = 0; i < ANSWERED_QUESTION_KEEP + 5; i++) {
      resolveQuestion(contextRoot, ask({ nowISO: `2026-08-09T${String(i).padStart(2, '0')}:00:00.000Z` }), 'x', 'cli');
    }
    pruneAnsweredQuestions(contextRoot, 'eod-digest');
    expect(refreshQuestion(contextRoot, pending)).not.toBeNull();
    expect(pendingQuestion(contextRoot, 'eod-digest')!.id).toBe(pending.id);
  });

  it('drops the oldest ANSWERED past the cap', () => {
    for (let i = 0; i < ANSWERED_QUESTION_KEEP + 5; i++) {
      resolveQuestion(contextRoot, ask({ nowISO: `2026-08-09T${String(i).padStart(2, '0')}:00:00.000Z` }), 'x', 'cli');
    }
    pruneAnsweredQuestions(contextRoot, 'eod-digest');
    expect(listQuestions(contextRoot, 'eod-digest').length).toBeLessThanOrEqual(ANSWERED_QUESTION_KEEP);
  });
});

describe('reads are lenient and never throw', () => {
  it('an unparseable question file is ignored, not fatal', () => {
    const dir = hitlSlugDir(contextRoot, 'eod-digest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q_broken.json'), 'not json at all', 'utf-8');
    const good = ask();
    expect(() => listQuestions(contextRoot, 'eod-digest')).not.toThrow();
    expect(listQuestions(contextRoot, 'eod-digest').map((q) => q.id)).toEqual([good.id]);
  });

  it('a record with no id or slug is dropped rather than half-read', () => {
    const dir = hitlSlugDir(contextRoot, 'eod-digest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q_headless.json'), JSON.stringify({ question: 'orphan' }), 'utf-8');
    expect(listQuestions(contextRoot, 'eod-digest')).toEqual([]);
  });

  it('an unrecognised state reads as pending — an automation must not silently unwedge', () => {
    const q = ask();
    const path = questionPath(contextRoot, 'eod-digest', q.id);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf-8')), state: 'weird' }), 'utf-8');
    expect(readQuestion(path)!.state).toBe('pending');
  });

  it('a directory whose name is not a safe slug is skipped by the global scan', () => {
    mkdirSync(join(hitlDir(contextRoot), 'Not A Slug'), { recursive: true });
    ask();
    expect(() => allPendingQuestions(contextRoot)).not.toThrow();
    expect(allPendingQuestions(contextRoot).map((q) => q.slug)).toEqual(['eod-digest']);
  });

  it('writes atomically, leaving no .tmp behind', () => {
    const q = ask();
    writeQuestion(contextRoot, q);
    const names = readFileSync(questionPath(contextRoot, 'eod-digest', q.id), 'utf-8');
    expect(names.length).toBeGreaterThan(0);
    expect(existsSync(`${questionPath(contextRoot, 'eod-digest', q.id)}.tmp`)).toBe(false);
  });
});
