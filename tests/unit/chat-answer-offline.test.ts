/**
 * Honest submit (hands-free, 2026-10-23). `answer()` used to remove the card even when the
 * socket was down ("optimistic"); the server still held the request, re-sent it on reattach,
 * and the card came back EMPTY. Now: not written → `false`, the card stays. Written → the
 * picks are only marked sent, so a re-sent ask after a half-open loss restores them; a
 * `result` with the request gone is what retires them. And the owner's tap on a held answer
 * asks for the connection at once (`reconnectSoon`), deferring to the 1 s floor, abandoning a
 * hung attempt once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static all: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  throwOnSend = false;
  closed = 0;
  constructor(url: string) { this.url = url; FakeWebSocket.all.push(this); }
  send(d: string) { if (this.throwOnSend) throw new Error('gone'); this.sent.push(d); }
  close() { this.closed += 1; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }); }
  frame(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}

const QUESTIONS = [{ question: 'Which db?', options: [{ label: 'postgres' }, { label: 'sqlite' }] }];
const ask = (requestId: string) => ({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', requires_user_interaction: true, input: { questions: QUESTIONS } },
});
const reattached = (busy: boolean) => ({ type: '_meta', subtype: 'reattached', busy });
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1 };
const CID = '6f1c2e9a-a001-4a5b-8c9d-0123456789ab';

beforeEach(async () => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'https:', host: 'quiet-lake-1234.trycloudflare.com', assign: vi.fn() });
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [], items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  const { clearSurveyDraftsForTests } = await import('../../dashboard/src/components/sleepy/chat/surveyDrafts');
  clearSurveyDraftsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open() {
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession');
  return createChatSession('demo', false, () => {}, CID, false, '', '', '', '', false, 'basic', '', '', null, '');
}
const last = () => FakeWebSocket.all[FakeWebSocket.all.length - 1];
const answers = (ws: FakeWebSocket) => ws.sent.map((d) => JSON.parse(d)).filter((f) => f.type === 'answer');
const pendingIds = (s: Awaited<ReturnType<typeof open>>) => s.getModel().pending.map((p) => `${p.kind}:${p.requestId}`).map((k) => k.replace(/^question:/, ''));

describe('answer() is honest about the wire', () => {
  it('socket closed: false, nothing sent, the card stays', async () => {
    const s = await open();
    last().open();
    last().frame(ask('req-1'));
    last().drop(1005);
    expect(s.answerQuestion('req-1', QUESTIONS, { 'Which db?': 'postgres' })).toBe(false);
    expect(s.answer('req-1', { behavior: 'deny', message: 'unclear' })).toBe(false);
    expect(pendingIds(s)).toEqual(['req-1']);
    expect(s.asking).toBe(true);
    s.dispose();
  });

  it('status says open but the socket is not OPEN (or send throws): false, the card stays', async () => {
    const s = await open();
    last().open();
    last().frame(ask('req-1'));
    last().readyState = 2;   // closing, no close event yet
    expect(s.status).toBe('open');
    expect(s.answerQuestion('req-1', QUESTIONS, { 'Which db?': 'postgres' })).toBe(false);
    last().readyState = 1;
    last().throwOnSend = true;
    expect(s.answerQuestion('req-1', QUESTIONS, { 'Which db?': 'postgres' })).toBe(false);
    expect(pendingIds(s)).toEqual(['req-1']);
    s.dispose();
  });

  it('written: true, one answer frame, the card leaves', async () => {
    const s = await open();
    last().open();
    last().frame(ask('req-1'));
    expect(s.answerQuestion('req-1', QUESTIONS, { 'Which db?': 'postgres' })).toBe(true);
    expect(answers(last())).toHaveLength(1);
    expect(pendingIds(s)).toEqual([]);
    s.dispose();
  });
});

describe('a written answer that never arrived (half-open socket)', () => {
  it('the re-sent ask after a reattach finds its picks; a result with the id gone drops them', async () => {
    const { surveyDraftKey, writeSurveyDraft, markSurveyDraftSent, readSurveyDraft } = await import('../../dashboard/src/components/sleepy/chat/surveyDrafts');
    const s = await open();
    last().open();
    last().frame(ask('req-1'));
    const key = surveyDraftKey(CID, 'req-1');
    // What the card persists, then marks on a `true` submit.
    writeSurveyDraft(key, { 'Which db?': { chosen: ['sqlite'], text: 'small one' } }, 0);
    expect(s.answerQuestion('req-1', QUESTIONS, { 'Which db?': 'sqlite' })).toBe(true);
    markSurveyDraftSent(key);
    // The frame was swallowed: the socket dies, the server re-asks the same id after an idle reattach.
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(1000);
    last().open();
    last().frame(reattached(false));
    last().frame(ask('req-1'));
    expect(pendingIds(s)).toEqual(['req-1']);
    expect(readSurveyDraft(key, ['Which db?'])?.picks).toEqual({ 'Which db?': { chosen: ['sqlite'], text: 'small one' } });
    // Answered again, this time the turn moves on: the result retires the draft.
    expect(s.answerQuestion('req-1', QUESTIONS, { 'Which db?': 'sqlite' })).toBe(true);
    last().frame(result);
    expect(readSurveyDraft(key, ['Which db?'])).toBeNull();
    s.dispose();
  });

  it('a result while the question is STILL open keeps its draft', async () => {
    const { surveyDraftKey, writeSurveyDraft, readSurveyDraft } = await import('../../dashboard/src/components/sleepy/chat/surveyDrafts');
    const s = await open();
    last().open();
    last().frame(ask('req-1'));
    writeSurveyDraft(surveyDraftKey(CID, 'req-1'), {}, 0);
    last().frame(result);
    expect(readSurveyDraft(surveyDraftKey(CID, 'req-1'), ['Which db?'])).not.toBeNull();
    s.dispose();
  });
});

describe('reconnectSoon (the owner tapped Submit while down)', () => {
  /** Drive the ladder to the 30 s rung: five failed attempts. */
  async function climbTo30s(): Promise<void> {
    last().drop(1006);
    for (const wait of [1000, 2000, 5000, 10000]) {
      await vi.advanceTimersByTimeAsync(wait);
      last().drop(1006);
    }
  }

  it('on the 30 s rung, 300 ms after a failed attempt: the next attempt is ~1 s after the last, not 30 s', async () => {
    const s = await open();
    last().open();
    await climbTo30s();
    const n = FakeWebSocket.all.length;
    await vi.advanceTimersByTimeAsync(300);
    s.reconnectSoon();
    await vi.advanceTimersByTimeAsync(699);
    expect(FakeWebSocket.all.length).toBe(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.all.length).toBe(n + 1);
    s.dispose();
  });

  it('a tap long after the last attempt goes at once', async () => {
    const s = await open();
    last().open();
    await climbTo30s();
    const n = FakeWebSocket.all.length;
    await vi.advanceTimersByTimeAsync(5000);
    s.reconnectSoon();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.all.length).toBe(n + 1);
    s.dispose();
  });

  it('an attempt CONNECTING for 4 s is abandoned and retried once; then exactly one new attempt in 15 s', async () => {
    const s = await open();
    last().open();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const hung = last();
    expect(hung.readyState).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    s.reconnectSoon();
    expect(hung.closed).toBe(1);
    const replacement = last();
    expect(replacement).not.toBe(hung);
    // The hung attempt's late close changes nothing.
    hung.onclose?.({ code: 1006 });
    // A second tap on the replacement within its first 3 s: untouched.
    await vi.advanceTimersByTimeAsync(2000);
    s.reconnectSoon();
    expect(replacement.closed).toBe(0);
    const n = FakeWebSocket.all.length;
    // The replacement is not abandoned by later taps either (never starve a slow upgrade).
    await vi.advanceTimersByTimeAsync(2000);
    s.reconnectSoon();
    expect(replacement.closed).toBe(0);
    expect(FakeWebSocket.all.length).toBe(n);
    // Its own connect timeout (15 s from its start) closes it; that close schedules ONE attempt.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(replacement.closed).toBe(1);
    replacement.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(FakeWebSocket.all.length).toBe(n + 1);
    s.dispose();
  });

  it('on a 1 s-old CONNECTING attempt: untouched; open: nothing; taken over: nothing', async () => {
    const s = await open();
    last().open();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const young = last();
    await vi.advanceTimersByTimeAsync(1000);
    s.reconnectSoon();
    expect(young.closed).toBe(0);
    young.open();
    const n = FakeWebSocket.all.length;
    s.reconnectSoon();
    expect(FakeWebSocket.all.length).toBe(n);
    young.drop(4409);
    s.reconnectSoon();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.all.length).toBe(n);
    s.dispose();
  });
});

describe('review r1 fixes', () => {
  it('a hung "Buraya al" (evicting) attempt abandoned by a tap is retried EVICTING, never passive', async () => {
    const s = await open();
    last().open();
    last().drop(4409);
    expect(s.takenOver).toBe(true);
    s.takeBack();
    const hung = last();
    expect(hung.url).toMatch(/[?&]reattach=1(&|$)/);
    await vi.advanceTimersByTimeAsync(4000);
    s.reconnectSoon();
    expect(hung.closed).toBe(1);
    expect(last()).not.toBe(hung);
    expect(last().url).toMatch(/[?&]reattach=1(&|$)/);
    s.dispose();
  });

  it('PlanCard locks its buttons only after the answer was written', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/PlanCard.tsx', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    // Every lock is conditional on the write, and a refused write asks for the connection.
    expect(src).toMatch(/if \(session\.answer\(item\.requestId, \{ behavior: 'allow'[^\n]*\)\) setSent\(true\);\s*else session\.reconnectSoon\(\);/);
    expect(src).toMatch(/if \(written\) setSent\(true\);\s*else session\.reconnectSoon\(\);/);
    expect(src.match(/setSent\(true\)/g)).toHaveLength(2);
  });
});
