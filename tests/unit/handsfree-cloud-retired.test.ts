// Hands-free's cloud mode (a GitHub Codespace trip: go / return, the laptop lock, transfers, the
// cloud server) was retired on 2026-10-16; hands-free is Mac mode only. This guard fails when
// any of its entry points comes back. "Cloud" alone is not forbidden: cloud recall
// (recall-cloud, CloudRecallCard, isCloudEligible*) and brain cloud-sync are other features.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProgram } from '../../src/cli/program.js';

const REPO = join(__dirname, '..', '..');

/** Case-insensitive: each one names a piece of the retired cloud mode and nothing else. */
const FORBIDDEN = [
  'cloud machine',
  'isCloud(',
  'DREAMCONTEXT_CLOUD',
  'codespaces',
  'cloud-worker',
  'cloud-mode',
  'trip-state',
  'handsfree go',
  'handsfree return',
  'X-Dreamcontext-Cloud',
  'cloud_unavailable',
  'spawnAsWorker',
  'handsfreeLockFor',
];

const SCANNED = ['src', 'dashboard/src', 'dashboard/public', 'scripts', 'skill', 'README.md'];

/** Every tracked or new (not ignored) file under the scanned roots. */
function scannedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCANNED], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter((f) => f && existsSync(join(REPO, f)) && !/\.(png|jpe?g|gif|webp|ico|mp4|mov|woff2?)$/i.test(f));
}

describe('hands-free cloud mode is retired', () => {
  it('no source, script, skill or README names a cloud-mode entry point', () => {
    const files = scannedFiles();
    // The scan really covers the code (a wrong root would pass on zero files).
    expect(files).toEqual(expect.arrayContaining(['src/server/index.ts', 'dashboard/src/App.tsx', 'README.md', 'skill/references/hands-free.md']));
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(REPO, f), 'utf8').toLowerCase();
      for (const word of FORBIDDEN) if (text.includes(word.toLowerCase())) hits.push(`${f}: ${word}`);
    }
    expect(hits).toEqual([]);
  });

  it('the cloud image is gone and the package ships no cloud dir', () => {
    expect(existsSync(join(REPO, 'cloud'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files.filter((f) => /cloud/i.test(f))).toEqual([]);
  });

  it('`dreamcontext cloud` is not a command, and `handsfree` has only `mac`', () => {
    const program = createProgram();
    expect(program.commands.map((c) => c.name())).not.toContain('cloud');
    const hf = program.commands.find((c) => c.name() === 'handsfree');
    expect(hf?.commands.map((c) => c.name())).toEqual(['mac']);
  });
});
