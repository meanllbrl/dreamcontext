import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { createAutomation, getAutomation, readPattern } from '../../src/lib/automations/store.js';

/**
 * `automations learn --playbook-file` through the real command tree: the route a Train Me
 * chat bound to an automation writes its confirmed result through. `automations-pattern`
 * covers `recordLesson` itself; what is under test here is the VERB: that the file's
 * contents become the playbook, and that learning off is refused with nothing written.
 */

let projectRoot: string;
let contextRoot: string;
let cwd: string;
let realHome: string | undefined;
let fakeHome: string;

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
    warn.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

beforeEach(() => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-learn-cli-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  createAutomation(contextRoot, {
    slug: 'digest', title: 'Daily digest', days: 'daily', at: '18:00', prompt: 'Say hello.', learning: true,
  });
  createAutomation(contextRoot, {
    slug: 'no-learn', title: 'No learning', days: 'daily', at: '18:00', prompt: 'Say hello.', learning: false,
  });
  process.chdir(projectRoot);
  // Nothing here should touch the home directory, but a CLI run must never be able to.
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-learn-cli-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('automations learn --playbook-file', () => {
  it('writes the file’s contents as the automation’s playbook, in its own manifest', async () => {
    const file = join(projectRoot, 'playbook.md');
    writeFileSync(file, 'Lead with the number that moved.\nKeep it to three lines.\n');
    const { code } = await run(['automations', 'learn', 'digest', '--playbook-file', file]);
    expect(code).toBe(0);

    const manifest = getAutomation(contextRoot, 'digest')!;
    expect(readPattern(manifest).playbook).toBe('Lead with the number that moved.\nKeep it to three lines.');
    expect(readFileSync(manifest.path, 'utf-8')).toContain('## Pattern');
  });

  it('writes nothing into the project’s knowledge/patterns', async () => {
    const file = join(projectRoot, 'playbook.md');
    writeFileSync(file, 'A playbook.');
    await run(['automations', 'learn', 'digest', '--playbook-file', file]);
    expect(existsSync(join(contextRoot, 'knowledge', 'patterns'))).toBe(false);
  });

  it('refuses with learning off, exits non-zero, and leaves the manifest untouched', async () => {
    const before = readFileSync(getAutomation(contextRoot, 'no-learn')!.path, 'utf-8');
    const file = join(projectRoot, 'playbook.md');
    writeFileSync(file, 'Should never land.');
    const { code, out } = await run(['automations', 'learn', 'no-learn', '--playbook-file', file]);
    expect(code).not.toBe(0);
    expect(out).toContain('learning off');
    expect(out).toContain('nothing would ever read this pattern');
    expect(readFileSync(getAutomation(contextRoot, 'no-learn')!.path, 'utf-8')).toBe(before);
  });

  it('fails loudly on a missing file rather than writing an empty playbook', async () => {
    const { code } = await run(['automations', 'learn', 'digest', '--playbook-file', join(projectRoot, 'missing.md')]);
    expect(code).not.toBe(0);
    expect(readPattern(getAutomation(contextRoot, 'digest')!).playbook).toBe('');
  });
});
