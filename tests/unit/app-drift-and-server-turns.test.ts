/**
 * Field 2026-11-13: an install over the running app left run cards failing with no word, and the
 * server's own Allow turn was read as the owner's message (an owner ref, a debt in `<super-owed>`).
 */
import { describe, it, expect } from 'vitest';
import { driftProbe, APP_UPDATED_MESSAGE } from '../../src/lib/app-drift.js';
import { isServerTurnText } from '../../src/lib/usage-readers.js';
import { allowTurnText } from '../../src/lib/super/answer.js';
import { mootSuperCall } from '../../src/lib/super/inbox.js';

describe('the app replaced under a running server', () => {
  it('a bundle entry whose file changed (or vanished) reads as replaced; the same file does not', () => {
    let id = { ino: 1, mtimeMs: 10, size: 100 };
    let gone = false;
    const stat = () => { if (gone) throw new Error('ENOENT'); return id; };
    const replaced = driftProbe('/Applications/x.app/Contents/Resources/dist/index.js', stat);
    expect(replaced()).toBe(false);
    id = { ino: 2, mtimeMs: 20, size: 101 };
    expect(replaced()).toBe(true);
    id = { ino: 1, mtimeMs: 10, size: 100 };
    expect(replaced()).toBe(false);
    gone = true;
    expect(replaced()).toBe(true);
  });

  it('a dev server (tsx on src/) or no entry never reads as replaced', () => {
    const stat = () => { throw new Error('never read'); };
    expect(driftProbe('/repo/src/cli/index.ts', stat)()).toBe(false);
    expect(driftProbe(null, stat)()).toBe(false);
  });

  it('the line says plainly to restart', () => {
    expect(APP_UPDATED_MESSAGE).toMatch(/restart/);
    expect(APP_UPDATED_MESSAGE).not.toMatch(/—/);
  });
});

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
