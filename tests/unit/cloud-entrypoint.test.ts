// The root entrypoint's `claude-login` verdict (smoke #5, minor): the owner signed
// mhmnuraydin77@gmail.com into the `mehmet-ottoapps-studio` slot and nothing said so. The python
// step (extracted verbatim from cloud/entrypoint.sh) now warns when the signed-in email is not
// the one the slot is registered for.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = readFileSync(join(resolve(__dirname, '..', '..'), 'cloud', 'entrypoint.sh'), 'utf8');
const PY = /LOGIN_STATUS_PY=\$\(cat <<'PY'\n([\s\S]*?)\nPY\n\)/.exec(SRC)?.[1];

function verdict(status: unknown, registry: unknown, id: string): string {
  const r = spawnSync('python3', ['-c', PY!, id], {
    input: typeof status === 'string' ? status : JSON.stringify(status),
    env: { ...process.env, DC_REG: typeof registry === 'string' ? registry : JSON.stringify(registry) },
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

const REG = { accounts: [{ id: 'mehmet-ottoapps-studio', email: 'mehmet@ottoapps.studio' }, { id: 'mhmnuraydin77-gmail-com', email: 'mhmnuraydin77@gmail.com' }] };

describe('entrypoint claude-login: the signed-in email must be the slot\'s', () => {
  it('the extracted step exists and the entrypoint pipes the status, the id and the registry (read as dcuser) into it', () => {
    expect(PY).toBeTruthy();
    expect(SRC).toMatch(/REG=\$\("\$\{ENVV\[@\]\}" "\$\{DROP\[@\]\}" \/usr\/bin\/head -c 1048576 -- "\$MIRROR\/\.dreamcontext\/claude-accounts\.json"/);
    expect(SRC).toMatch(/\| DC_REG="\$REG" python3 -c "\$LOGIN_STATUS_PY" "\$ID"/);
  });

  it('the wrong account in a slot is a clear WARNING naming both emails (smoke #5)', () => {
    const out = verdict({ loggedIn: true, email: 'mhmnuraydin77@gmail.com' }, REG, 'mehmet-ottoapps-studio');
    expect(out.split('\n')[0]).toBe('signed in mhmnuraydin77@gmail.com');
    expect(out).toMatch(/^WARNING: the slot mehmet-ottoapps-studio is registered for mehmet@ottoapps\.studio, but mhmnuraydin77@gmail\.com signed in here\./m);
  });

  it('the right account (any letter case), a not-signed-in slot, an unknown slot or an unreadable registry: no warning', () => {
    expect(verdict({ loggedIn: true, email: 'MhmNuraydin77@gmail.com' }, REG, 'mhmnuraydin77-gmail-com')).toBe('signed in MhmNuraydin77@gmail.com');
    expect(verdict({ loggedIn: false }, REG, 'mehmet-ottoapps-studio')).toBe('NOT signed in');
    expect(verdict({ loggedIn: true, email: 'a@b.c' }, REG, 'not-registered')).toBe('signed in a@b.c');
    expect(verdict({ loggedIn: true, email: 'a@b.c' }, 'not json', 'mehmet-ottoapps-studio')).toBe('signed in a@b.c');
    expect(verdict('garbage', REG, 'x')).toBe('unknown');
  });

  it('r18: terminal control characters in either email never reach the terminal', () => {
    const evil = 'a@b.c\u001b]0;pwned\u0007\u001b[2J\r\nWARNING: fake\u009b31m';
    const reg = { accounts: [{ id: 'slot', email: 'x@y.z\u001b[31m' }] };
    const out = verdict({ loggedIn: true, email: evil }, reg, 'slot');
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/); // only the line break between the two lines
    expect(out.split('\n')).toHaveLength(2); // the planted newline did not forge a line
    expect(out.split('\n')[0]).toBe('signed in a@b.c]0;pwned[2JWARNING: fake31m');
    expect(out).toMatch(/^WARNING: the slot slot is registered for x@y\.z\[31m, but a@b\.c\]0;pwned/m);
  });
});
