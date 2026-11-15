import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { getAgent } from '../../src/lib/agents/store.js';
import { resolveAutomationPhoto } from '../../src/lib/automations/store.js';
import { checkApproval } from '../../src/lib/automations/registry.js';
import { getRunTarget } from '../../src/lib/automations/store.js';
import { memberFileRefusal } from '../../src/lib/agents/member-file-guard.js';

/** `agents edit <slug> --photo <file>|none`, through the real command tree, under a fake HOME. */

let projectRoot: string;
let contextRoot: string;
let cwd: string;
let realHome: string | undefined;
let fakeHome: string;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); }));
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

beforeEach(async () => {
  vi.stubEnv('CLAUDECODE', undefined as unknown as string);
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-photo-cli-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  process.chdir(projectRoot);
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-photo-cli-home-'));
  process.env.HOME = fakeHome;
  await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P']);
});

afterEach(() => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

function approved(): boolean {
  const t = getRunTarget(contextRoot, 'x');
  return !!t && checkApproval(contextRoot, t as never).ok !== false;
}

describe('agents edit --photo', () => {
  it('sets the photo through the upload path and the agent stays approved', async () => {
    const before = approved();
    const file = join(projectRoot, 'face.bin');
    writeFileSync(file, PNG);
    const { code } = await run(['agents', 'edit', 'x', '--photo', file]);
    expect(code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.photo).toBe('automations/photos/x.png');
    expect(resolveAutomationPhoto(contextRoot, 'automations/photos/x.png')).not.toBeNull();
    expect(readFileSync(join(contextRoot, 'automations/photos/x.png')).equals(PNG)).toBe(true);
    expect(approved()).toBe(before);
  });

  it('none clears the key and removes the file', async () => {
    const file = join(projectRoot, 'a.png');
    writeFileSync(file, PNG);
    await run(['agents', 'edit', 'x', '--photo', file]);
    expect((await run(['agents', 'edit', 'x', '--photo', 'none'])).code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.photo).toBeNull();
    expect(existsSync(join(contextRoot, 'automations/photos/x.png'))).toBe(false);
  });

  it('refuses a non-image and writes nothing', async () => {
    const file = join(projectRoot, 'fake.png');
    writeFileSync(file, '#!/bin/sh\necho hi\n');
    const { code, out } = await run(['agents', 'edit', 'x', '--photo', file]);
    expect(code).toBe(1);
    expect(out).toContain('not a PNG');
    expect(getAgent(contextRoot, 'x')?.photo).toBeNull();
    expect(existsSync(join(contextRoot, 'automations/photos'))).toBe(false);
  });

  it('refuses a symlink, even to a real image', async () => {
    const real = join(projectRoot, 'real.png');
    writeFileSync(real, PNG);
    const link = join(projectRoot, 'link.png');
    symlinkSync(real, link);
    const { code, out } = await run(['agents', 'edit', 'x', '--photo', link]);
    expect(code).toBe(1);
    expect(out).toContain('symlink');
    expect(getAgent(contextRoot, 'x')?.photo).toBeNull();
  });

  it('a refused edit (unknown agent) writes no file', async () => {
    const file = join(projectRoot, 'a.png');
    writeFileSync(file, PNG);
    const { code } = await run(['agents', 'edit', 'ghost', '--photo', file]);
    expect(code).toBe(1);
    expect(existsSync(join(contextRoot, 'automations/photos'))).toBe(false);
  });

  it('the hook refusal names --photo', () => {
    expect(memberFileRefusal('/b/agents/x.md')).toContain('--photo');
  });
});
