/**
 * Unit tests for `resolveChatReference` — which file a path WRITTEN IN A TRANSCRIPT names.
 *
 * The owner's 07-28 report is the canonical case and has its own describe block below: an
 * answer wrote `![…](../../tmp/dc-verify-auto/automations-light.png)` for a screenshot really
 * sitting at `/tmp/dc-verify-auto/automations-light.png`. The `../..` climb lands nowhere,
 * so the picture could not be drawn, the fallback card's "Open ↗" could not open, and the
 * user got a chip that did nothing at all.
 *
 * Two things are being pinned here, and the second matters as much as the first:
 *   1. a reference is resolved by what it NAMES, tail-first, when the literal path misses;
 *   2. the recovery cannot wander — the roots are a fixed allowlist, `/` is not among them,
 *      and a BARE filename is only ever matched inside the project's own directories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveChatReference } from '../../src/server/chat-reference-path.js';

let projectRoot: string;
let contextRoot: string;
let stamp: string;
/** Stands in for `/tmp/dc-verify-auto` — where an agent's verification shots really land. */
let shotDir: string;

beforeEach(() => {
  stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectRoot = join(tmpdir(), `dc-ref-proj-${stamp}`);
  contextRoot = join(projectRoot, '_dream_context');
  shotDir = join(tmpdir(), `dc-ref-shots-${stamp}`);
  mkdirSync(join(contextRoot, 'tmp', 'agent-drops'), { recursive: true });
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  mkdirSync(shotDir, { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'app.ts'), 'export {}\n', 'utf-8');
  writeFileSync(join(contextRoot, 'tmp', 'note.md'), '# note\n', 'utf-8');
  writeFileSync(join(shotDir, 'automations-light.png'), Buffer.from([0x89, 0x50]), 'binary');
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(shotDir, { recursive: true, force: true });
});

describe('resolveChatReference — the literal reading, which is almost always right', () => {
  it('resolves a project-relative path under the project root', () => {
    const ref = resolveChatReference(projectRoot, contextRoot, 'src/app.ts');
    expect(ref).toMatchObject({ abs: join(projectRoot, 'src', 'app.ts'), outside: false, missing: false });
    expect(ref?.recovered).toBe(false);
  });

  it('passes an absolute path straight through, and marks it outside the project', () => {
    const target = join(shotDir, 'automations-light.png');
    expect(resolveChatReference(projectRoot, contextRoot, target))
      .toMatchObject({ abs: target, outside: true, recovered: false, missing: false });
  });

  it('normalises `..` inside an absolute path rather than reading it literally', () => {
    const target = join(shotDir, 'sub', '..', 'automations-light.png');
    expect(resolveChatReference(projectRoot, contextRoot, target)?.abs)
      .toBe(join(shotDir, 'automations-light.png'));
  });

  it('refuses a null byte outright — that is not a mistyped path', () => {
    expect(resolveChatReference(projectRoot, contextRoot, 'src/app.ts\0.png')).toBeNull();
    expect(resolveChatReference(projectRoot, contextRoot, '')).toBeNull();
  });
});

describe('resolveChatReference — the 07-28 report: a `../..` climb that lands nowhere', () => {
  it('finds the screenshot the reference actually names', () => {
    // Exactly the shape the answer wrote: enough `..` to leave the project, then a tail that
    // is correct. Anchored literally this is `<tmpdir>/…/automations-light.png` — nothing.
    const written = `../../${`dc-ref-shots-${stamp}`}/automations-light.png`;
    const ref = resolveChatReference(projectRoot, contextRoot, written);
    expect(ref).toMatchObject({
      abs: join(shotDir, 'automations-light.png'),
      outside: true,
      recovered: true,
      missing: false,
    });
  });

  it('recovering does NOT grant anything — the file is still flagged outside the project', () => {
    const written = `../../../../${`dc-ref-shots-${stamp}`}/automations-light.png`;
    expect(resolveChatReference(projectRoot, contextRoot, written)?.outside).toBe(true);
  });

  it('recovers a file in the project\'s own scratch dir regardless of the climb', () => {
    const ref = resolveChatReference(projectRoot, contextRoot, '../../../tmp/note.md');
    expect(ref).toMatchObject({ abs: join(contextRoot, 'tmp', 'note.md'), outside: false, recovered: true });
  });

  it('prefers the LONGEST matching tail, so the most specific file wins', () => {
    // A same-named decoy in the project root: the two-segment tail must beat the bare name.
    mkdirSync(join(projectRoot, 'shots'), { recursive: true });
    writeFileSync(join(projectRoot, 'shots', 'automations-light.png'), 'decoy', 'utf-8');
    writeFileSync(join(projectRoot, 'automations-light.png'), 'decoy2', 'utf-8');
    expect(resolveChatReference(projectRoot, contextRoot, '../../../shots/automations-light.png')?.abs)
      .toBe(join(projectRoot, 'shots', 'automations-light.png'));
  });
});

describe('resolveChatReference — the recovery cannot wander', () => {
  it('will not match a BARE filename outside the project, however it was written', () => {
    // `secret.txt` sitting directly in the system temp dir is not "the file the answer meant"
    // — half the machines in the world have one. A bare name is only matched project-side.
    const stray = join(tmpdir(), `dc-ref-stray-${stamp}.txt`);
    writeFileSync(stray, 'not yours\n', 'utf-8');
    try {
      const ref = resolveChatReference(projectRoot, contextRoot, `../../${`dc-ref-stray-${stamp}.txt`}`);
      expect(ref?.missing).toBe(true);
      expect(ref?.recovered).toBe(false);
    } finally {
      rmSync(stray, { force: true });
    }
  });

  it('DOES match a bare filename inside the project\'s own directories', () => {
    const ref = resolveChatReference(projectRoot, contextRoot, '../../../../note.md');
    expect(ref).toMatchObject({ abs: join(contextRoot, 'tmp', 'note.md'), outside: false, recovered: true });
  });

  it('never RECOVERS from the filesystem root — `/` is not a search root', () => {
    // Literally nowhere, so recovery is what would have to find it: the tails
    // `etc/<name>.conf` and `<name>.conf` are tried against the allowlist and nothing else.
    const written = `../../../../../../etc/dc-ref-nonexistent-${stamp}.conf`;
    const ref = resolveChatReference(projectRoot, contextRoot, written);
    expect(ref?.recovered).toBe(false);
    expect(ref?.missing).toBe(true);
  });

  it('a reference that literally IS a system file resolves to it — and is still outside', () => {
    // `resolve()` has always read `../..` this way, and an answer can write `/etc/passwd`
    // outright regardless. What keeps it off the page is the `outside` flag: `/agent/file`
    // will not serve it without an explicit per-file grant. Resolving is not permission.
    const ref = resolveChatReference(projectRoot, contextRoot, '../../../../../../etc/passwd');
    expect(ref?.outside).toBe(true);
    expect(ref?.recovered).toBe(false);
  });

  it('reports a reference that names nothing anywhere as missing, with the literal reading', () => {
    const ref = resolveChatReference(projectRoot, contextRoot, 'src/ghost.ts');
    expect(ref).toMatchObject({ abs: join(projectRoot, 'src', 'ghost.ts'), missing: true, recovered: false });
  });
});

describe('resolveChatReference — no vault resolved for the request', () => {
  it('still handles an absolute reference', () => {
    const target = join(shotDir, 'automations-light.png');
    expect(resolveChatReference(null, null, target)).toMatchObject({ abs: target, missing: false });
  });

  it('refuses a relative one rather than anchoring on the server process\'s cwd', () => {
    // Anchoring on cwd is the original bug this module exists to end: for a desktop-spawned
    // server that directory is not the project, and every relative path resolved nowhere.
    expect(resolveChatReference(null, null, 'src/app.ts')).toBeNull();
  });
});
