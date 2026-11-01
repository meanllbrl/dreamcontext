import { describe, it, expect } from 'vitest';
import { ALLOW_TEXT_MAX, allowAlertText, cleanAlertText } from '../../dashboard/src/components/sleepy/chat/permissionAlert';

describe('the Allow alert', () => {
  it('says what runs, per tool', () => {
    expect(allowAlertText('Bash', { command: 'rm -rf x' })).toBe('rm -rf x');
    expect(allowAlertText('Write', { file_path: '/a/b', content: 'xyz' })).toBe('Write /a/b (3 characters)');
    expect(allowAlertText('Edit', { file_path: '/a/b', new_string: 'xy' })).toBe('Edit /a/b (2 characters)');
    expect(allowAlertText('mcp__meta__pause', { id: 1 })).toBe('MCP meta / pause {"id":1}');
    expect(allowAlertText('WebFetch', { url: 'u' })).toBe('WebFetch {"url":"u"}');
  });
  it('strips bidi and zero-width characters and collapses space before it measures', () => {
    expect(cleanAlertText('safe‮​cmd   now\n')).toBe('safe cmd now');
    expect(cleanAlertText(`a${' '.repeat(2000)}b`).length).toBeLessThan(ALLOW_TEXT_MAX);
  });
});
