import { cpSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `init` once per test file, copied per test.
 *
 * Several CLI suites gave every test a fresh vault by spawning the real `init` in a `beforeEach`:
 * one more CLI start (~0.35 s of CPU, seconds of wall time on a loaded box) per test. `init`
 * writes only inside the folder it runs in (no absolute path, nothing under HOME), so running it
 * ONCE with the same arguments and environment and copying the result gives each test the same
 * fresh vault, still its own copy: nothing is shared between tests.
 *
 * Usage: build it in a `beforeAll` with the file's own `run`, in an empty folder the file makes
 * with its OWN temp prefix (a literal `mkdtemp` prefix, so super-disk-leftovers' list keeps
 * naming it); copy it in the `beforeEach`; remove it in an `afterAll`. The tests that test
 * `init` itself keep spawning it.
 */
export function buildInitTemplate(dir: string, runInit: (cwd: string) => void): string {
  runInit(dir);
  if (!readdirSync(dir).includes('_dream_context')) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`init did not create _dream_context in the template folder ${dir}`);
  }
  return dir;
}

/** Copy everything `init` wrote in the template into `dest` (an existing, empty folder). */
export function copyInitTemplate(template: string, dest: string): void {
  for (const entry of readdirSync(template)) {
    cpSync(join(template, entry), join(dest, entry), { recursive: true, verbatimSymlinks: true });
  }
}
