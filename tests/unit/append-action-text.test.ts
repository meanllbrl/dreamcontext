import { describe, it, expect } from 'vitest';
import { appendActionText } from '../../dashboard/src/components/sleepy/chat/appendActionText';

describe('appendActionText', () => {
  it('numbers the first item in an empty composer', () => {
    expect(appendActionText('', 'Commit Et')).toBe('1. Commit Et');
  });
  it('adds the second item on its own line', () => {
    expect(appendActionText('1. Commit Et', 'Pushla')).toBe('1. Commit Et\n2. Pushla');
  });
  it('does not repeat the same item', () => {
    expect(appendActionText('1. Commit Et\n2. Pushla', 'Commit Et')).toBe('1. Commit Et\n2. Pushla');
  });
  it('leaves free text alone and starts at 1 below it', () => {
    expect(appendActionText('bir not', 'Pushla')).toBe('bir not\n1. Pushla');
  });
  it('continues from the last number after a hand-deleted line', () => {
    expect(appendActionText('1. A\n3. C', 'D')).toBe('1. A\n3. C\n4. D');
  });
  it('handles a trailing newline or none', () => {
    expect(appendActionText('1. A\n', 'B')).toBe('1. A\n2. B');
    expect(appendActionText('1. A', 'B')).toBe('1. A\n2. B');
  });
  it('treats a whitespace-only composer as empty', () => {
    expect(appendActionText('  \n', 'A')).toBe('  \n1. A');
  });
});
