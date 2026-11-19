/**
 * A global agent carries a photo (owner, 16 Nov: "neden izin vermiyoruz"). It lives beside the
 * agent in its home on this machine, never in a brain, and every project shows it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createProgram } from '../../src/cli/program.js';
import { createGlobalAgent, getAgent, updateAgent } from '../../src/lib/agents/store.js';
import { globalAgentHome } from '../../src/lib/agents/scope.js';
import { storeAgentPhoto } from '../../src/lib/agents/photo.js';
import { resolveGlobalAgentPhoto, resolveMemberPhoto } from '../../src/lib/automations/store.js';
import { registerProject } from '../../src/lib/automations/registry.js';
import { handleAgentsPhotoGet, listAgentSummaries } from '../../src/server/routes/agents.js';
import { identityFor } from '../../src/server/telegram/identity.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const NOW = new Date('2026-11-16T09:00:00.000Z');

let cwd: string;
let realHome: string | undefined;
let fakeHome: string;
let scratch: string;
let a: { project: string; context: string };
let b: { project: string; context: string };

function makeProject(prefix: string): { project: string; context: string } {
  const project = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const context = join(project, '_dream_context');
  mkdirSync(join(context, 'state'), { recursive: true });
  return { project, context };
}

function brainPaths(context: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      out.push(relative(context, abs));
      if (statSync(abs).isDirectory()) walk(abs);
    }
  };
  walk(context);
  return out;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...x: unknown[]) => { lines.push(x.join(' ')); }));
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

function photoGet(context: string, slug: string): Promise<{ status: number; bytes: Buffer | null }> {
  let status = 0;
  let bytes: Buffer | null = null;
  const res = {
    writeHead(code: number) { status = code; },
    end(data: unknown) { bytes = Buffer.isBuffer(data) ? data : null; },
    setHeader() {},
  } as unknown as ServerResponse;
  return handleAgentsPhotoGet({} as IncomingMessage, res, { slug }, context).then(() => ({ status, bytes }));
}

beforeEach(() => {
  cwd = process.cwd();
  realHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dc-gphoto-home-')));
  process.env.HOME = fakeHome;
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dc-gphoto-files-')));
  writeFileSync(join(scratch, 'face.png'), PNG);
  a = makeProject('dc-gphoto-a-');
  b = makeProject('dc-gphoto-b-');
  registerProject(a.project);
  registerProject(b.project);
  createGlobalAgent({ slug: 'dwight', title: 'Dwight', prompt: 'You keep the farm in order.' }, { approve: { now: NOW } });
});

afterEach(() => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  for (const d of [fakeHome, scratch, a.project, b.project]) rmSync(d, { recursive: true, force: true });
});

describe('a global agent has a photo', () => {
  it('`agents edit --photo` in one project stores it in the agent\'s home (0700) and every project shows and serves it; no brain holds it', async () => {
    const before = { a: brainPaths(a.context), b: brainPaths(b.context) };
    process.chdir(a.project);
    const { code, out } = await run(['agents', 'edit', 'dwight', '--photo', join(scratch, 'face.png')]);
    expect(code, out).toBe(0);

    const file = join(globalAgentHome('dwight'), 'automations', 'photos', 'dwight.png');
    expect(existsSync(file)).toBe(true);
    expect(statSync(join(globalAgentHome('dwight'), 'automations', 'photos')).mode & 0o777).toBe(0o700);
    expect(brainPaths(a.context)).toEqual(before.a);
    expect(brainPaths(b.context)).toEqual(before.b);

    for (const p of [a, b]) {
      expect(listAgentSummaries(p.context).find((x) => x.slug === 'dwight')?.hasPhoto).toBe(true);
      const got = await photoGet(p.context, 'dwight');
      expect(got.status).toBe(200);
      expect(got.bytes?.equals(PNG)).toBe(true);
    }
    // Its Telegram bot, which has no project, reads the same file.
    expect(identityFor({ scope: 'global', target: 'dwight', contextRoot: null, projectName: '' }, fakeHome)?.photo).toBe(realpathSync(file));
  });

  it('`--photo none` removes it everywhere', async () => {
    process.chdir(a.project);
    expect((await run(['agents', 'edit', 'dwight', '--photo', join(scratch, 'face.png')])).code).toBe(0);
    process.chdir(b.project);
    const { code, out } = await run(['agents', 'edit', 'dwight', '--photo', 'none']);
    expect(code, out).toBe(0);
    expect(existsSync(join(globalAgentHome('dwight'), 'automations', 'photos', 'dwight.png'))).toBe(false);
    expect(getAgent(a.context, 'dwight')?.photo).toBeNull();
    for (const p of [a, b]) {
      expect(listAgentSummaries(p.context).find((x) => x.slug === 'dwight')?.hasPhoto).toBe(false);
      expect((await photoGet(p.context, 'dwight')).status).toBe(404);
    }
  });

  it('a link anywhere under the global agents folder is refused: never read, never written through', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dc-gphoto-outside-')));
    try {
      writeFileSync(join(outside, 'dwight.png'), PNG);
      mkdirSync(join(globalAgentHome('dwight'), 'automations'), { recursive: true });
      symlinkSync(outside, join(globalAgentHome('dwight'), 'automations', 'photos'));
      updateAgent(a.context, 'dwight', { photo: 'automations/photos/dwight.png' });

      expect(resolveMemberPhoto(a.context, 'dwight', 'automations/photos/dwight.png')).toBeNull();
      expect(resolveGlobalAgentPhoto('dwight', 'automations/photos/dwight.png')).toBeNull();
      expect((await photoGet(b.context, 'dwight')).status).toBe(404);
      expect(listAgentSummaries(b.context).find((x) => x.slug === 'dwight')?.hasPhoto).toBe(false);
      expect(() => storeAgentPhoto(a.context, 'dwight', { buf: PNG, ext: '.png' })).toThrow(/link/);

      // A link at the file itself, inside a real photos folder, is refused too.
      rmSync(join(globalAgentHome('dwight'), 'automations', 'photos'));
      mkdirSync(join(globalAgentHome('dwight'), 'automations', 'photos'));
      symlinkSync(join(outside, 'dwight.png'), join(globalAgentHome('dwight'), 'automations', 'photos', 'dwight.png'));
      expect(resolveMemberPhoto(a.context, 'dwight', 'automations/photos/dwight.png')).toBeNull();
      expect((await photoGet(a.context, 'dwight')).status).toBe(404);
      // ...and never written through: the file the link points at keeps its bytes.
      expect(() => storeAgentPhoto(a.context, 'dwight', { buf: Buffer.concat([PNG, PNG]), ext: '.png' })).toThrow(/link/);
      expect(readFileSync(join(outside, 'dwight.png')).equals(PNG)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a global agent still has no home board', () => {
    expect(() => updateAgent(a.context, 'dwight', { whiteboard: 'farm' })).toThrow(/no home board/);
  });
});
