/**
 * An answer that could not be written is never reported as answered (hands-free, 2026-10-23):
 * the voice doorbell (`runVerb answer`) and the Super Agent's `super answer` say
 * `not_connected` when the chat's socket is down, and the card stays waiting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../dashboard/src/lib/agentPrompt', () => ({ preparePrompt: vi.fn() }));
vi.mock('../../dashboard/src/lib/assistantBridge', () => ({ listenForAssistantCommands: vi.fn(() => () => {}) }));
vi.mock('../../dashboard/node_modules/@tauri-apps/api/window.js', () => ({ getCurrentWindow: () => ({ setFocus: vi.fn(async () => {}) }) }));

const { runVerb } = await import('../../dashboard/src/components/assistant/useAssistantDoorbell');

describe('the doorbell answering a chat whose socket is down', () => {
  const question = { kind: 'question', requestId: 'q1', questions: [{ question: 'Which db?', options: [{ label: 'postgres' }] }] };
  const permission = { kind: 'permission', requestId: 'p1', input: { command: 'ls' } };
  let pending: unknown[];
  let chat: { answer: ReturnType<typeof vi.fn>; answerQuestion: ReturnType<typeof vi.fn>; getModel: () => { pending: unknown[] } };
  let deps: Parameters<typeof runVerb>[0];
  beforeEach(() => {
    pending = [question, permission];
    // The real session returns false and keeps the card when nothing was written.
    chat = { answer: vi.fn(() => false), answerQuestion: vi.fn(() => false), getModel: () => ({ pending }) };
    deps = {
      vault: 'acme',
      findChat: vi.fn(() => chat as never),
      findOwnerChat: vi.fn(() => chat as never),
      openChat: vi.fn(() => ({ claudeId: 'new-1' }) as never),
      reveal: vi.fn(),
      openPage: vi.fn(),
      closeChat: vi.fn(() => true),
    };
  });

  it('a question: not_connected, never answered', async () => {
    const out = await runVerb(deps, 'answer', { sessionId: 'c-1', question: 'q1', choice: 'postgres' });
    expect(out).toEqual({ ok: false, error: 'not_connected' });
    expect(chat.answerQuestion).toHaveBeenCalledTimes(1);
    expect(chat.getModel().pending).toContain(question);
  });

  it('a permission (allow and deny): not_connected', async () => {
    expect(await runVerb(deps, 'answer', { sessionId: 'c-1', question: 'p1', choice: 'allow' })).toEqual({ ok: false, error: 'not_connected' });
    expect(await runVerb(deps, 'answer', { sessionId: 'c-1', question: 'p1', choice: 'deny', by: 'owner' })).toEqual({ ok: false, error: 'not_connected' });
  });

  it('written: answered as before', async () => {
    chat.answerQuestion.mockReturnValue(true);
    expect(await runVerb(deps, 'answer', { sessionId: 'c-1', question: 'q1', choice: 'postgres' })).toEqual({ ok: true, result: { answered: 'postgres' } });
  });
});

describe('the Super Agent answering a child whose socket is down (AgentSurface `super answer`)', () => {
  it('returns not_connected when answerQuestion could not write', () => {
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/AgentSurface.tsx', import.meta.url), 'utf-8');
    expect(src).toMatch(/if \(!cs\.answerQuestion\(requestId, q\.questions, picks\.picked, picks\.notes\)\) return \{ ok: false, error: 'not_connected' \};/);
  });
});
