/**
 * `superAnswerText` is ONE builder on both sides (plan A6, pattern mirror-with-drift-test): the
 * server copy in src/lib/super/answer.ts (the Telegram hub and the phone answer the Super's own
 * ask with it) and the window's in superQuestions.ts must produce the same owner text, byte for
 * byte, for every shape.
 */
import { describe, it, expect } from 'vitest';
import { superAnswerText as server, SUPER_ANSWER_PREFIX as SERVER_PREFIX } from '../../src/lib/super/answer.js';
import { superAnswerText as client, SUPER_ANSWER_PREFIX as CLIENT_PREFIX } from '../../dashboard/src/components/sleepy/super/superQuestions.js';

const ask = { id: 'q-1', kind: 'ask' as const, sessionId: 's-1' };
const question = { id: 'q-2', kind: 'question' as const, sessionId: 'child-1' };
const qs = [
  { question: 'Hangi renk?', options: [{ label: 'Mor' }, { label: 'Yeşil' }] },
  { question: 'Ne zaman "bugün"?', options: [{ label: 'Şimdi' }], multiSelect: true },
];

describe('superAnswerText server <-> window', () => {
  it('the same prefix and the same text for every shape', () => {
    expect(SERVER_PREFIX).toBe(CLIENT_PREFIX);
    const cases: Array<[Parameters<typeof server>[0], Record<string, string>, Record<string, string> | undefined]> = [
      [ask, { 'Hangi renk?': 'Mor' }, undefined],
      [ask, { 'Hangi renk?': 'Mor', 'Ne zaman "bugün"?': 'Şimdi, yarın' }, { 'Hangi renk?': 'koyu olsun' }],
      [ask, {}, undefined],
      [question, { 'Hangi renk?': 'Yeşil' }, { 'Hangi renk?': 'not' }],
      [question, {}, undefined],
    ];
    for (const [item, picked, notes] of cases) {
      expect(server(item, qs, picked, notes)).toBe(client(item, qs as never, picked, notes));
    }
  });
});
