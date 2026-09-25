import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliAwarePath, cliShimDir, renderCliShim } from '../../src/lib/automations/cli-path.js';

/**
 * A headless run started from the APP inherits a Finder-launched environment
 * (`/usr/bin:/bin`), and the agent's `dreamcontext automations post` then fails
 * with "command not found" — observed on a real ask, where the thread stayed
 * empty. `cliAwarePath` gives the run a shim that execs the very CLI running it.
 */

let home: string;
let fakeNodeDir: string;
let fakeNode: string;
let entry: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-cli-path-home-'));
  fakeNodeDir = mkdtempSync(join(tmpdir(), 'dc-cli-path-node-'));
  fakeNode = join(fakeNodeDir, 'node');
  // A stand-in "node" that prints its arguments, so the shim can be EXECUTED and its
  // exec line proven rather than string-matched.
  writeFileSync(fakeNode, '#!/bin/sh\necho "ran:$*"\n');
  chmodSync(fakeNode, 0o755);
  entry = join(fakeNodeDir, 'cli entry', "it's", 'index.js');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(fakeNodeDir, { recursive: true, force: true });
});

describe('cliAwarePath', () => {
  it('rescues a minimal PATH: the shim dir comes first, node\'s dir is appended', () => {
    const path = cliAwarePath('/usr/bin:/bin', { execPath: fakeNode, entry, home });
    const parts = path.split(delimiter);
    expect(parts[0]).toBe(cliShimDir(home));
    expect(parts).toContain(fakeNodeDir);
    expect(parts).toContain('/usr/bin');
  });

  it('writes an executable shim that execs THIS node on THIS entry, quoting survived', () => {
    cliAwarePath('/usr/bin:/bin', { execPath: fakeNode, entry, home });
    const shim = join(cliShimDir(home), 'dreamcontext');
    expect(statSync(shim).mode & 0o111).not.toBe(0);
    expect(readFileSync(shim, 'utf-8')).toBe(renderCliShim(fakeNode, entry));
    const out = execFileSync(shim, ['automations', 'post', 'x y'], { encoding: 'utf-8' }).trim();
    expect(out).toBe(`ran:${entry} automations post x y`);
  });

  it('never shadows a dreamcontext the PATH already resolves', () => {
    const own = mkdtempSync(join(tmpdir(), 'dc-cli-path-own-'));
    try {
      const bin = join(own, 'dreamcontext');
      writeFileSync(bin, '#!/bin/sh\n');
      chmodSync(bin, 0o755);
      const path = cliAwarePath(`${own}${delimiter}/usr/bin`, { execPath: fakeNode, entry, home });
      expect(path.split(delimiter)).not.toContain(cliShimDir(home));
      expect(path.split(delimiter)[0]).toBe(own);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('with no entry to point at, leaves the lookup alone rather than writing a broken shim', () => {
    const path = cliAwarePath('/usr/bin', { execPath: fakeNode, entry: undefined, home });
    expect(path.split(delimiter)).not.toContain(cliShimDir(home));
  });

  it('degrades to the PATH it was given when the home is unwritable', () => {
    const blocked = join(home, 'file-not-dir');
    writeFileSync(blocked, '');
    mkdirSync(join(home, 'ok'), { recursive: true });
    const path = cliAwarePath('/usr/bin', { execPath: fakeNode, entry, home: blocked });
    expect(path.split(delimiter)).toEqual(['/usr/bin', fakeNodeDir]);
  });
});
