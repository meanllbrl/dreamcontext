/**
 * The bridge session on T3's recorded Codex transcripts: what the chat client receives.
 * Every frame is parsed by the CLIENT's own `parseChatLine`, so these assert what the owner sees.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseChatLine } from '../../../dashboard/src/lib/chatProtocol.js';
import type { BridgeSession } from '../../../src/lib/t3-bridge/session.js';
import { isResult, openReplaySession, waitFor } from './replay-harness.js';

const open: BridgeSession[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });

const events = (frames: Record<string, unknown>[]) => frames.map((f) => parseChatLine(JSON.stringify(f))!);

describe('t3 bridge session (T3 replay)', () => {
  it('streams text as deltas BEFORE the message completes, then ends the turn with a result', async () => {
    const { session, frames } = await openReplaySession('simple');
    open.push(session);
    await session.send((await import('./replay-harness.js')).loadFixture('simple').prompt);
    await waitFor(() => frames.some(isResult));
    const kinds = events(frames).map((e) => e.kind);
    const firstDelta = kinds.indexOf('text-delta');
    const finalText = kinds.indexOf('assistant-text');
    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init', dc_tool: 'codex' });
    expect(firstDelta).toBeGreaterThan(-1);
    expect(finalText).toBeGreaterThan(firstDelta);
    const text = frames.filter((f) => f.type === 'assistant').map((f) => JSON.stringify(f)).join('');
    expect(text).toContain('fixture simple ok');
    const result = frames.find(isResult)!;
    expect(result).toMatchObject({ subtype: 'success', is_error: false });
    expect(String(result.session_id)).toMatch(/^[0-9a-f-]{20,}$/);
  });

  it('asks an approval with the tool name and its input, and resumes on allow', async () => {
    const { session, frames, fixture } = await openReplaySession('tool_call_read_only_on_request');
    open.push(session);
    await session.send(fixture.prompt);
    await waitFor(() => frames.some((f) => f.type === 'control_request'));
    const ask = frames.find((f) => f.type === 'control_request')!;
    const req = ask.request as { subtype: string; tool_name: string; input: Record<string, unknown> };
    expect(req.subtype).toBe('can_use_tool');
    expect(req.tool_name).toBe('Bash');
    expect(String(req.input.command)).toContain('.codex-probe-write-action.txt');
    const ev = parseChatLine(JSON.stringify(ask))!;
    expect(ev.kind).toBe('permission-request');
    await session.answer(String(ask.request_id), { behavior: 'allow', updatedInput: req.input });
    await waitFor(() => frames.some(isResult));
    expect(frames.some((f) => f.type === 'user' && JSON.stringify(f).includes('tool_result'))).toBe(true);
  });

  it('asks a question as an AskUserQuestion card and maps the answer back to T3 question ids', async () => {
    const { session, frames, fixture } = await openReplaySession('plan_questions', { mode: 'plan' });
    open.push(session);
    await session.send(fixture.prompt);
    await waitFor(() => frames.some((f) => f.type === 'control_request'));
    const ask = frames.find((f) => f.type === 'control_request')!;
    const req = ask.request as { tool_name: string; input: { questions: Array<{ question: string; options: Array<{ label: string }> }> } };
    expect(req.tool_name).toBe('AskUserQuestion');
    expect(req.input.questions.length).toBeGreaterThan(0);
    expect(parseChatLine(JSON.stringify(ask))!.kind).toBe('question');
    const q = req.input.questions[0]!;
    await session.answer(String(ask.request_id), { behavior: 'allow', updatedInput: { questions: req.input.questions, answers: { [q.question]: q.options[0]!.label } } });
    await waitFor(() => frames.some(isResult));
    expect(JSON.stringify(frames.filter((f) => f.type === 'assistant'))).toContain('plan questions fixture complete');
  });

  it('interrupts a running turn: the turn ends with an aborted result', async () => {
    const { session, frames, fixture } = await openReplaySession('turn_interrupt');
    open.push(session);
    await session.send(fixture.prompt);
    // The recorded turn is running once Codex acknowledged it (its turn id is known).
    await waitFor(() => session.busy && frames.length > 0);
    await new Promise((r) => setTimeout(r, 800));
    await session.interrupt();
    await waitFor(() => frames.some(isResult));
    expect(frames.find(isResult)).toMatchObject({ is_error: true, terminal_reason: 'aborted' });
  });

  it('draws a plan update as a TodoWrite card', async () => {
    const { session, frames, fixture } = await openReplaySession('todo_list');
    open.push(session);
    await session.send(fixture.prompt);
    await waitFor(() => frames.some(isResult));
    expect(frames.some((f) => JSON.stringify(f).includes('"name":"TodoWrite"'))).toBe(true);
  });

  it('measures context from contextUsage.usedTokens onto the assistant usage', async () => {
    const { session, frames, fixture } = await openReplaySession('todo_list');
    open.push(session);
    await session.send(fixture.prompt);
    await waitFor(() => frames.some(isResult));
    expect(session.wire.contextTokens).toBeGreaterThan(0);
    const result = frames.find(isResult) as { usage: { input_tokens: number } };
    expect(result.usage.input_tokens).toBe(session.wire.contextTokens);
  });
});
