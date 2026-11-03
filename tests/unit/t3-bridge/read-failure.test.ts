/**
 * Antigravity fails a sub-agent's open reads with the NEXT step's refusal (real run 2026-11-04,
 * to-wire.ts readFailureText). The strings below are the two shapes Antigravity really sent.
 */
import { describe, expect, it } from 'vitest';
import { UNREPORTED_READ, readFailureText } from '../../../src/lib/t3-bridge/to-wire.js';

const PROJECT = '/private/var/folders/x/T/lumen-notes';
const hook = (p: string): string => `denied by pre-tool hook: Access to path "${p}" is denied. It is outside the allowed workspace directories: [${PROJECT}]`;
const tool = (p: string): string => `Tool view_file failed with error message: Access to path '${p}' is denied. It is outside the allowed workspace directories: [${PROJECT}]`;

describe('a read failed with a refusal', () => {
  it('naming another path says its result is unknown, and never names that path', () => {
    const text = readFailureText({ AbsolutePath: `${PROJECT}/README.md`, path: `${PROJECT}/README.md` }, hook('/opt/homebrew/lib/node_modules/dreamcontext/package.json'));
    expect(text).toBe(UNREPORTED_READ);
    expect(text).not.toContain('package.json');
  });

  it('naming its own path is left exactly as sent, in either quote style', () => {
    const own = '/Users/someone/.dreamcontext/t3/state/antigravity-tmp/run-1/gate.js';
    expect(readFailureText({ AbsolutePath: own }, tool(own))).toBe(tool(own));
    expect(readFailureText({ path: own }, hook(own))).toBe(hook(own));
  });

  it('any other failure text, or a read with no path, is left alone', () => {
    expect(readFailureText({ AbsolutePath: `${PROJECT}/a.md` }, 'file not found')).toBe('file not found');
    expect(readFailureText({}, hook('/elsewhere/x'))).toBe(hook('/elsewhere/x'));
  });
});
