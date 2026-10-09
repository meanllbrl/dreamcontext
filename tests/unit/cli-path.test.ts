import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { cliAwarePath, cliShimDir } from '../../src/lib/automations/cli-path.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-cli-path-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('cliAwarePath on the private Node', () => {
  it('the shim and the PATH name node/current, never a version folder that a pin bump prunes', () => {
    const execPath = join(home, '.dreamcontext', 'node', '24.21.0', 'bin', 'node');
    const path = cliAwarePath('/usr/bin:/bin', { execPath, entry: '/opt/dc/dist/index.js', home });
    const shim = readFileSync(join(cliShimDir(home), 'dreamcontext'), 'utf-8');
    const stable = join(home, '.dreamcontext', 'node', 'current', 'bin', 'node');
    expect(shim).toContain(`'${stable}'`);
    expect(shim).not.toContain('24.21.0');
    expect(path.split(delimiter)).toContain(join(home, '.dreamcontext', 'node', 'current', 'bin'));
    expect(path).not.toContain('24.21.0');
  });

  it('any other node is named exactly as it runs', () => {
    const execPath = join(home, 'nvm', 'v22.1.0', 'bin', 'node');
    cliAwarePath('/usr/bin:/bin', { execPath, entry: '/opt/dc/dist/index.js', home });
    expect(readFileSync(join(cliShimDir(home), 'dreamcontext'), 'utf-8')).toContain(`'${execPath}'`);
  });
});
