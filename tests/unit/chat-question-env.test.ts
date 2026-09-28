/**
 * The Chat spawn switches on the CLI's extended AskUserQuestion schema and HTML previews.
 * Both are host opt-ins read from the environment (verified against CLI 2.1.281): without
 * them the model never sends a `title`, a `description` or a `preview`, and the question
 * card's context strip, A/B/C board and swipe face have nothing to draw.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHAT_QUESTION_ENV } from '../../src/server/routes/agent-chat.js';

describe('CHAT_QUESTION_ENV', () => {
  it('turns on extended questions and HTML previews', () => {
    expect(CHAT_QUESTION_ENV).toEqual({
      CLAUDE_CODE_QUESTION_EXTENDED: '1',
      CLAUDE_CODE_QUESTION_PREVIEW_FORMAT: 'html',
    });
  });

  it('is spread into the chat spawn AFTER process.env, so an inherited value cannot override it', () => {
    const src = readFileSync(new URL('../../src/server/routes/agent-chat.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/env: \{ \.\.\.process\.env, PATH: claudeAwarePath\(\), \.\.\.CHAT_QUESTION_ENV,/);
  });
});
