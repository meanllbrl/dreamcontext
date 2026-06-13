/**
 * Integration test for launcher quiz onboarding: runs the REAL `init` + `setup`
 * via scaffoldProject's default child-process runner against a tmp folder and
 * asserts a working dreamcontext project is produced and registered.
 *
 * Requires a current build (`dist/index.js`) — same convention as
 * dashboard-vault.test.ts. Skipped automatically when no build is present so the
 * unit suite stays green without a build step.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scaffoldProject } from '../../src/server/routes/launcher.js';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const hasBuild = existsSync(CLI);

let dirs: string[] = [];
let prevCliEnv: string | undefined;

function mkTmp(prefix = 'dc-scaffold-it'): string {
  const raw = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

beforeAll(() => {
  prevCliEnv = process.env.DREAMCONTEXT_CLI;
  process.env.DREAMCONTEXT_CLI = CLI;
});
afterAll(() => {
  if (prevCliEnv === undefined) delete process.env.DREAMCONTEXT_CLI;
  else process.env.DREAMCONTEXT_CLI = prevCliEnv;
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe.skipIf(!hasBuild)('scaffoldProject (integration, real CLI)', () => {
  it('creates a new project with _dream_context/ + .claude/ and registers it', async () => {
    const parent = mkTmp();
    const home = mkTmp('dc-home');
    dirs.push(parent, home);

    const res = await scaffoldProject(
      {
        mode: 'new',
        name: 'demo-app',
        parentDir: parent,
        description: 'A demo',
        stack: 'TypeScript, Node.js',
        priority: 'Initial setup',
      },
      undefined, // default runner → spawns the real CLI
      home,
    );

    const target = join(parent, 'demo-app');
    expect(existsSync(join(target, '_dream_context', 'core', '0.soul.md'))).toBe(true);
    expect(existsSync(join(target, '.claude'))).toBe(true);
    expect(res.vault.name).toBe('demo-app');
    expect(res.vault.path).toBe(target);
  }, 90_000);
});
