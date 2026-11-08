import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addVault } from '../../src/lib/vaults.js';
import { getApp, unregisterApp } from '../../src/lib/apps/registry.js';
import { sdkSource } from '../../src/server/apps/gateway-w3.js';

/** plan-veri r3 K4/K5, AC8-9: a removed app comes back with its data; the SDK copy is refreshed only when it is the SDK. */
const cli = resolve('dist/index.js');
let home: string; let project: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-rereg-')));
  project = join(home, 'proj');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  addVault('acme', project, home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const dc = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf-8', env: { ...env(), HOME: home } });

describe.skipIf(!existsSync(cli))('apps new after apps remove, and validate --fix-sdk', () => {
  it('re-registers the same slug from its code folder, and its data folder is there again', () => {
    expect(dc('apps', 'new', 'yuk').status).toBe(0);
    const data = join(project, '_dream_context', 'apps', 'yuk');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'yuk-bildir.json'), '{"count":9}');
    // What `apps remove` does to the registry (the route needs a server; the record is the point).
    unregisterApp(home, realpathSync(project), 'yuk');
    expect(getApp(home, project, 'yuk')).toBeNull();
    const again = dc('apps', 'new', 'yuk');
    expect(again.status, again.stderr + again.stdout).toBe(0);
    expect(again.stdout + again.stderr).toContain('registered again');
    expect(getApp(home, project, 'yuk')).not.toBeNull();
    expect(readFileSync(join(data, 'yuk-bildir.json'), 'utf-8')).toBe('{"count":9}');
    // Registered twice is still refused.
    expect(dc('apps', 'new', 'yuk').status).toBe(1);
  });

  it('--fix-sdk rewrites a stale SDK copy, warns without the flag, and never touches a file without the SDK header', () => {
    expect(dc('apps', 'new', 'yuk').status).toBe(0);
    const sdk = join(`${project}-apps`, 'yuk', 'lib', 'dc.mjs');
    writeFileSync(sdk, `${sdkSource().split('\n')[0]}\nexport const old = true;\n`);
    expect(dc('apps', 'validate', 'yuk').stdout).toContain('--fix-sdk');
    expect(readFileSync(sdk, 'utf-8')).toContain('old = true');
    dc('apps', 'validate', 'yuk', '--fix-sdk');
    expect(readFileSync(sdk, 'utf-8')).toBe(sdkSource());
    writeFileSync(sdk, 'export const mine = 1;\n');
    const own = dc('apps', 'validate', 'yuk', '--fix-sdk');
    expect(own.stdout).toContain('not the dreamcontext SDK');
    expect(readFileSync(sdk, 'utf-8')).toBe('export const mine = 1;\n');
  });
});
