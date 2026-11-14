/**
 * Field 2026-11-13: the server's own Allow turn was read as the owner's message (an owner ref, a
 * debt in `<super-owed>`).
 */
import { describe, it, expect } from 'vitest';
import { isServerTurnText } from '../../src/lib/usage-readers.js';
import { allowTurnText } from '../../src/lib/super/answer.js';
import { mootSuperCall } from '../../src/lib/super/inbox.js';

describe("the server's own turns are no message of the owner's", () => {
  it('an Allow turn is a server turn; his own words are not', () => {
    expect(isServerTurnText(allowTurnText('Bash', 'dreamcontext super answer x y "Yes"'))).toBe(true);
    expect(isServerTurnText('dreamcontext server is down?')).toBe(false);
  });
});

describe('an allowed call that can no longer matter', () => {
  const ID = '99e1f772-66df-4c74-bae0-c17f9253d35e';
  it('a super answer to a request nobody asks (no such chat) is moot, in the field\'s exact shape', () => {
    expect(mootSuperCall('Bash', `cd /x/brain && dreamcontext super answer ${ID} 3163a3a0-046c-4f79-9d38-82cfdf5b5bd9 "Yes, push 0.41.20" 2>&1 | tail -3; dreamcontext super brief ${ID} "pushing"`)).toBe(true);
  });
  it('a command that also does something else may still matter: never moot', () => {
    expect(mootSuperCall('Bash', `dreamcontext super answer ${ID} r1 "Yes" 2>&1 && git push origin main`)).toBe(false);
    expect(mootSuperCall('Bash', `dreamcontext super answer ${ID} r1 "Yes" > /tmp/o; npm publish`)).toBe(false);
    expect(mootSuperCall("Bash", `dreamcontext super answer ${ID} r1 "Yes" & git push`)).toBe(false);
    expect(mootSuperCall('Bash', 'git push')).toBe(false);
    expect(mootSuperCall('Edit', `dreamcontext super answer ${ID} r1 Yes`)).toBe(false);
  });
});
