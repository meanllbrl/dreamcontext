/**
 * A grant pins the interpreter the SESSION's hook will find (uye-bildirim K3, found by the live
 * walk on 2026-11-11): the server resolved `node` with its own PATH, the member's hook with its
 * login shell's, two different binaries on a Mac with nvm and Homebrew, so an Allow once on a
 * script never matched and the owner's tap did nothing. Every place a pin is made (the grant, the
 * refusal's script fact, the offer) resolves with the session's PATH, read from its crew handle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCrewHandle, _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { grantCtx, sessionResolveEnv, setGrantEnvForTest } from '../../src/lib/super/inbox.js';
import { eligible } from '../../src/lib/grants/eligible.js';

let dir: string;
let project: string;
let sessionBin: string;
let off: () => void = () => undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dc-grant-path-')));
  project = join(dir, 'acme-storefront');
  mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(project, 'tools'), { recursive: true });
  writeFileSync(join(project, 'tools', 'weekly-total.mjs'), 'console.log(42)\n');
  // The session's own `node`: a binary only the session's PATH holds (outside the project).
  sessionBin = join(dir, 'session-bin');
  mkdirSync(sessionBin);
  writeFileSync(join(sessionBin, 'node'), '#!/bin/sh\n');
  chmodSync(join(sessionBin, 'node'), 0o755);
  // The temp folder holds the stand-in interpreter: only the project counts as the agent's here.
  setGrantEnvForTest({ roots: (p) => [p] });
  _resetChatRegistry();
});
afterEach(() => {
  off();
  setGrantEnvForTest({ roots: null, resolver: null });
  _resetChatRegistry();
  rmSync(dir, { recursive: true, force: true });
});

const ctxRoot = () => join(project, '_dream_context');

describe('a grant resolves its interpreter where the session runs', () => {
  it('the session\'s PATH comes from its crew handle; none known means the server\'s own', () => {
    off = registerCrewHandle('pin-rota', { sendServerTurn: () => true, sessionPath: () => `${sessionBin}:/usr/bin:/bin` });
    expect(sessionResolveEnv('pin-rota').PATH).toBe(`${sessionBin}:/usr/bin:/bin`);
    expect(sessionResolveEnv('pin-unknown').PATH).toBe(process.env.PATH);
    expect(sessionResolveEnv(undefined).PATH).toBe(process.env.PATH);
    // A live process whose read is not back yet: the server's, as before.
    off();
    off = registerCrewHandle('pin-rota', { sendServerTurn: () => true, sessionPath: () => null });
    expect(sessionResolveEnv('pin-rota').PATH).toBe(process.env.PATH);
  });

  it('a script call made by the session pins the session\'s interpreter, not the server\'s', () => {
    off = registerCrewHandle('pin-rota', { sendServerTurn: () => true, sessionPath: () => `${sessionBin}:/usr/bin:/bin` });
    const cmd = 'node tools/weekly-total.mjs';
    const mine = eligible('Bash', cmd, 'once', { ...grantCtx(ctxRoot(), undefined, 'pin-rota'), cwd: project } as never);
    expect(mine.ok && mine.form).toBe('script');
    expect(mine.ok ? mine.script?.interpreterPath : null).toBe(join(sessionBin, 'node'));
    // Without the session the server's PATH decides: another binary (or none), never the session's.
    const servers = eligible('Bash', cmd, 'once', { ...grantCtx(ctxRoot()), cwd: project } as never);
    expect(servers.ok ? servers.script?.interpreterPath : null).not.toBe(join(sessionBin, 'node'));
  });
});
