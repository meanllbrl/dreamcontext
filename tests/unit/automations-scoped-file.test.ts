import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scopedReadablePath } from '../../src/lib/automations/scoped-file.js';
import { AGENT_BOARD_ENV, AGENT_SCRATCH_ENV, AGENT_SELF_ENV, AutomationError } from '../../src/lib/automations/types.js';

/**
 * `learn --playbook-file` and `propose --body-file` copy a file's content into the synced brain,
 * and a board agent is allowed to run both for itself. Its Read deny rules bind Claude's tools,
 * not the CLI child, so while scoped the file must come from the agent's own writable folders.
 */
describe('scopedReadablePath', () => {
  let base: string;
  let ctx: string;
  let scratch: string;
  let output: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-scoped-file-')));
    ctx = join(base, 'proj', '_dream_context');
    output = join(ctx, 'automations', 'output', 'launch-watcher');
    scratch = join(base, 'scratch');
    mkdirSync(output, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(base, 'proj', '.env'), 'TOKEN=fake\n');
    writeFileSync(join(output, 'notes.md'), 'from output\n');
    writeFileSync(join(scratch, 'draft.md'), 'from scratch\n');
    env = { [AGENT_BOARD_ENV]: 'launch-board', [AGENT_SELF_ENV]: 'launch-watcher', [AGENT_SCRATCH_ENV]: scratch };
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('passes any path through unchanged when no board scope is set', () => {
    const file = join(base, 'proj', '.env');
    expect(scopedReadablePath(ctx, file, '--body-file', {})).toBe(file);
  });

  it('reads from the scratch folder and from automations/output/<self>', () => {
    expect(scopedReadablePath(ctx, join(scratch, 'draft.md'), '--body-file', env)).toBe(join(scratch, 'draft.md'));
    expect(scopedReadablePath(ctx, join(output, 'notes.md'), '--playbook-file', env)).toBe(join(output, 'notes.md'));
  });

  it('refuses the project .env and a path outside the vault, naming the flag and the allowed folders', () => {
    expect(() => scopedReadablePath(ctx, join(base, 'proj', '.env'), '--playbook-file', env))
      .toThrow(/--playbook-file .* is outside the folders this agent may read from/);
    expect(() => scopedReadablePath(ctx, join(base, 'proj', '.env'), '--body-file', env))
      .toThrow(/automations\/output\/launch-watcher\//);
  });

  it('refuses a symlink in scratch that points at a secret', () => {
    symlinkSync(join(base, 'proj', '.env'), join(scratch, 'innocent.md'));
    expect(() => scopedReadablePath(ctx, join(scratch, 'innocent.md'), '--body-file', env)).toThrow(/is a symlink/);
  });

  it('refuses a ../ escape out of an allowed folder', () => {
    expect(() => scopedReadablePath(ctx, join(scratch, '..', 'proj', '.env'), '--body-file', env)).toThrow(AutomationError);
  });

  it('refuses everything while scoped when neither folder resolves', () => {
    const bare = { [AGENT_BOARD_ENV]: 'launch-board' };
    expect(() => scopedReadablePath(ctx, join(scratch, 'draft.md'), '--body-file', bare)).toThrow(/outside the folders/);
  });

  it('reports a missing file as not found', () => {
    expect(() => scopedReadablePath(ctx, join(scratch, 'nope.md'), '--body-file', env)).toThrow(/--body-file not found/);
  });
});
