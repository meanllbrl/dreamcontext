/** The doctor's Antigravity row: fake HOME, nothing started, and no claim it cannot measure. */
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityProfileDir, antigravityRuntime } from '../../src/lib/antigravity-accounts.js';
import { checkAntigravity, machineToDoctorResults } from '../../src/cli/commands/doctor.js';

const RELEASE = 'a'.repeat(64);

describe('checkAntigravity', () => {
  let home: string;
  const narrow = { path: '/usr/bin:/bin', loginPath: null, node: '/fake/node' } as const;
  const check = (o = {}) => checkAntigravity({ home, ...narrow, ...o });
  const target = `${process.platform}-${process.arch}`;
  const root = (): string => join(home, '.dreamcontext', 't3', 'tools', 'antigravity-acp', target);
  function install(bytes = 4): string {
    const dir = join(root(), 'versions', RELEASE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root(), 'active.json'), JSON.stringify({ releaseId: RELEASE }));
    for (const f of ['agy_acp_server.par', 'localharness_external']) { writeFileSync(join(dir, f), 'abcd'); chmodSync(join(dir, f), 0o755); }
    writeFileSync(join(dir, '.install-complete.json'), JSON.stringify({ releaseId: RELEASE, version: '1.4.1', executable: { name: 'agy_acp_server.par', bytes }, harness: { name: 'localharness_external', bytes: 4 } }));
    return dir;
  }
  const signIn = (): void => {
    const dir = join(antigravityProfileDir('primary', home), 'antigravity-acp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'acp_token.json'), '{}');
  };
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-agy-doc-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('not installed is no fault: the tool is opt-in', () => {
    expect(check()).toMatchObject({ status: 'ok', message: 'Antigravity: not installed (optional)' });
  });

  it('a sign-in on file never reads as a working one', () => {
    install();
    signIn();
    const row = check();
    expect(row.status).toBe('ok');
    expect(row.message).toContain('Antigravity 1.4.1');
    expect(row.message).toContain('not checked');
    expect(row.message).not.toMatch(/\bready\b/);
    expect(row.message).toContain('whether the sign-in still works');
  });

  it('says signed out, a damaged install and a missing Node for what they are', () => {
    install();
    expect(check()).toMatchObject({ status: 'warn' });
    expect(check().message).toContain('signed out');
    signIn();
    expect(check({ node: null }).message).toContain('22.16');
    install(999);
    expect(antigravityRuntime({ home }).intact).toBe(false);
    expect(check().message).toContain('damaged');
  });

  it('a Windows install has no exec bits, and that is no damage', () => {
    const dir = install();
    chmodSync(join(dir, 'agy_acp_server.par'), 0o644);
    expect(antigravityRuntime({ home, platform: process.platform, arch: process.arch }).intact).toBe(false);
    const win = join(home, '.dreamcontext', 't3', 'tools', 'antigravity-acp', `win32-${process.arch}`);
    mkdirSync(dirname(win), { recursive: true });
    renameSync(root(), win);
    expect(antigravityRuntime({ home, platform: 'win32', arch: process.arch }).intact).toBe(true);
  });

  it('a managed install is found with no PATH at all, as the app starts it', () => {
    install();
    signIn();
    expect(check({ path: '' }).status).toBe('ok');
  });

  it('an agent only on PATH is found, with no version it cannot read', () => {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'agy_acp_server.par'), '#!/bin/sh\n');
    chmodSync(join(bin, 'agy_acp_server.par'), 0o755);
    signIn();
    expect(check({ path: bin }).message).toMatch(/^Antigravity: installed/);
  });
});

describe('doctor --machine', () => {
  it('an unknown row says not checked, never ready', () => {
    const rows = machineToDoctorResults({ ready: true, checks: [{ id: 'codex-auth', tier: 'recommended', scopes: ['machine'], status: 'unknown', dependsOn: [], fix: null }] } as never);
    expect(rows[0]!.message).toBe('Codex sign-in: not checked');
  });
});
