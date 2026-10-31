/**
 * GNU du (Linux) counts a directory once per call: given a worktree and its `target/` together it
 * prints only the worktree, so the inner path measured 0. BSD du prints both, which is why this
 * stayed green on the Mac. The fake du below behaves the GNU way on every POSIX platform.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { diskUsage } from '../../src/lib/super/disk-leftovers.js';

const GNU_DU = `#!/bin/sh
# -sk, then paths: print only those not inside an earlier one, 4 KB each.
shift
seen=""
for p in "$@"; do
  skip=""
  for s in $seen; do case "$p" in "$s"/*) skip=1;; esac; done
  [ -z "$skip" ] && printf '4\\t%s\\n' "$p"
  seen="$seen $p"
done
exit 0
`;

describe.skipIf(process.platform === 'win32')('diskUsage against a du that dedupes nested arguments', () => {
  let dir: string;
  const path = process.env.PATH;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-du-'));
    writeFileSync(join(dir, 'du'), GNU_DU);
    chmodSync(join(dir, 'du'), 0o755);
    process.env.PATH = [dir, path].join(delimiter);
  });
  afterEach(() => { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); });

  it('measures a path and the path inside it, and a repeated path once', async () => {
    const wt = join(dir, 'wt');
    const target = join(wt, 'desktop', 'target');
    const sibling = join(dir, 'other');
    mkdirSync(target, { recursive: true });
    mkdirSync(sibling);
    const sizes = await diskUsage([wt, target, sibling, wt]);
    expect([...sizes.keys()].sort()).toEqual([sibling, target, wt].sort());
  });
});
