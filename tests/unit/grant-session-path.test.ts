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
import { noteSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { match } from '../../src/lib/grants/match.js';
import type { Grant } from '../../src/lib/grants/types.js';

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
  setGrantEnvForTest({ roots: null, resolver: null, checkout: null });
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

  it('a session no longer running: the grant pins the interpreter its refusal\'s birth resolved, never the server\'s', () => {
    // No crew handle (the session ended, the Allow waits in the outbox): the fact's interpreter decides.
    const cmd = 'node tools/weekly-total.mjs';
    const born = { name: 'node', path: join(sessionBin, 'node') };
    const later = eligible('Bash', cmd, 'job', { ...grantCtx(ctxRoot(), undefined, 'pin-gone', { interpreter: born }), cwd: project } as never);
    expect(later.ok && later.form).toBe('script');
    expect(later.ok ? later.script?.interpreterPath : null).toBe(join(sessionBin, 'node'));
    // Another program on the same line still resolves on the PATH as before.
    expect(grantCtx(ctxRoot(), undefined, 'pin-gone', { interpreter: born }).resolve.which('sh')).toBe(grantCtx(ctxRoot()).resolve.which('sh'));
  });
});

describe('a grant resolves a relative script where the session works (its own worktree)', () => {
  let wt: string;
  beforeEach(() => {
    // A child delegated with --worktree: the same relative name, different bytes, in its own tree.
    wt = join(dir, 'acme-storefront-wt');
    mkdirSync(join(wt, 'tools'), { recursive: true });
    writeFileSync(join(wt, 'tools', 'weekly-total.mjs'), 'console.log("worktree")\n');
    setGrantEnvForTest({ roots: (p) => [p, wt], checkout: (sid, p) => (sid === 'pin-wt' ? wt : p) });
  });
  const cmd = 'node tools/weekly-total.mjs';

  it('the writer pins the worktree\'s script, and the hook running in that worktree matches it', () => {
    const ctx = grantCtx(ctxRoot(), undefined, 'pin-wt');
    expect(ctx.cwd).toBe(wt);
    const e = eligible('Bash', cmd, 'job', ctx);
    expect(e.ok && e.form).toBe('script');
    expect(e.ok ? e.script?.scriptPath : null).toBe(join(wt, 'tools', 'weekly-total.mjs'));
    const g: Grant = { id: 'job_t1', scope: 'job', project, pin: 'pin-wt', tool: 'Bash', input: cmd, form: 'script', script: e.ok ? e.script : undefined, createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
    // The enforcer side: its own cwd, the same roots and resolver.
    const hook = { project, roots: [project, wt], cwd: wt, resolve: ctx.resolve };
    expect(match([g], { project, pin: 'pin-wt', tool: 'Bash', input: cmd }, hook)?.id).toBe('job_t1');
    // The same session in the project root resolves another file: asked again, never allowed.
    expect(match([g], { project, pin: 'pin-wt', tool: 'Bash', input: cmd }, { ...hook, cwd: project })).toBeNull();
  });

  it('the folder recorded at birth wins once the session is gone; a folder outside the roots is never used', () => {
    expect(grantCtx(ctxRoot(), undefined, 'pin-gone', { cwd: wt }).cwd).toBe(wt);
    expect(grantCtx(ctxRoot(), undefined, 'pin-gone').cwd).toBeUndefined();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    expect(grantCtx(ctxRoot(), undefined, 'pin-gone', { cwd: elsewhere }).cwd).toBeUndefined();
  });
});

describe('a delegated child that only cd-s into its worktree (no frame reports the move)', () => {
  let wt: string;
  beforeEach(() => {
    wt = join(dir, 'acme-storefront-wt');
    mkdirSync(join(wt, 'tools'), { recursive: true });
    writeFileSync(join(wt, 'tools', 'weekly-total.mjs'), 'console.log("worktree")\n');
    // The real lookup: no checkout stub, only the roots (the worktree is one of the project's).
    setGrantEnvForTest({ roots: (p) => [p, wt], checkout: null });
    resetSuperIndex();
  });
  afterEach(() => resetSuperIndex());

  it('the writer takes the worktree the server made for it from the Super record, so the hook in it matches', () => {
    const state = { ...emptySuperState(), session: 'sess-main', enabled: true, children: {
      'pin-cd': { sessionId: 'pin-cd', brief: 'weekly totals', adopted: false, worktree: wt, branch: 'super/weekly', startedAt: 1 },
    } } as unknown as Parameters<typeof noteSuperState>[1];
    noteSuperState(ctxRoot(), state);
    const ctx = grantCtx(ctxRoot(), undefined, 'pin-cd');
    expect(ctx.cwd).toBe(wt);
    const cmd = 'node tools/weekly-total.mjs';
    const e = eligible('Bash', cmd, 'job', ctx);
    expect(e.ok ? e.script?.scriptPath : null).toBe(join(wt, 'tools', 'weekly-total.mjs'));
    const g: Grant = { id: 'job_t2', scope: 'job', project, pin: 'pin-cd', tool: 'Bash', input: cmd, form: 'script', script: e.ok ? e.script : undefined, createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
    expect(match([g], { project, pin: 'pin-cd', tool: 'Bash', input: cmd }, { project, roots: [project, wt], cwd: wt, resolve: ctx.resolve })?.id).toBe('job_t2');
    // A session with no worktree of its own works in the project root, as before.
    expect(grantCtx(ctxRoot(), undefined, 'pin-other').cwd).toBeUndefined();
  });
});
