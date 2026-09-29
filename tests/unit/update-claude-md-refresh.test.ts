/**
 * `dreamcontext update` refreshes the managed CLAUDE.md block, and only that.
 *
 * The contract: an existing dreamcontext block is rewritten from the shipped
 * template; a project without one (no file, or a file whose block the user
 * removed) is left exactly as it is; every byte outside the fences survives the
 * swap; AGENTS.md is never written; a symlinked CLAUDE.md is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshManagedInstructionsBlock } from '../../src/cli/commands/install-claude-md.js';
import { buildUpdateSummary } from '../../src/cli/commands/update.js';

const START = '<!-- dreamcontext:claude:start -->';
const END = '<!-- dreamcontext:claude:end -->';
const TEMPLATE = readFileSync(join(__dirname, '..', '..', 'src', 'templates', 'CLAUDE.md'), 'utf-8');

const USER_HEAD = '# My project rules\n\nKeep this exactly.\n\n\n';
const USER_TAIL = '\n\n## After the block\nAlso mine, with odd spacing   \n\n\n';
const STALE_BLOCK = `${START}\nSoul/user/memory auto-load. Never hand-edit task/feature files.\n${END}`;

let root: string;
const claudeMd = (): string => join(root, 'CLAUDE.md');

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-claude-md-refresh-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('refreshManagedInstructionsBlock', () => {
  it('rewrites an existing managed block from the shipped template', () => {
    writeFileSync(claudeMd(), USER_HEAD + STALE_BLOCK + USER_TAIL, 'utf-8');

    const result = refreshManagedInstructionsBlock(root, 'claude');

    expect(result.action).toBe('refreshed');
    const after = readFileSync(claudeMd(), 'utf-8');
    expect(after).not.toContain('Never hand-edit task/feature files');
    expect(after).toContain(`${START}\n${TEMPLATE.trim()}\n${END}`);
  });

  it('keeps every byte outside the fences identical', () => {
    writeFileSync(claudeMd(), USER_HEAD + STALE_BLOCK + USER_TAIL, 'utf-8');

    refreshManagedInstructionsBlock(root, 'claude');

    const after = readFileSync(claudeMd(), 'utf-8');
    expect(after.startsWith(USER_HEAD + START)).toBe(true);
    expect(after.endsWith(END + USER_TAIL)).toBe(true);
    expect(after.slice(0, after.indexOf(START))).toBe(USER_HEAD);
    expect(after.slice(after.indexOf(END) + END.length)).toBe(USER_TAIL);
  });

  it('writes nothing when the block is already current', () => {
    writeFileSync(claudeMd(), USER_HEAD + STALE_BLOCK + USER_TAIL, 'utf-8');
    refreshManagedInstructionsBlock(root, 'claude');
    const once = readFileSync(claudeMd(), 'utf-8');

    expect(refreshManagedInstructionsBlock(root, 'claude').action).toBe('unchanged');
    expect(readFileSync(claudeMd(), 'utf-8')).toBe(once);
  });

  it('never creates CLAUDE.md when the project has none', () => {
    expect(refreshManagedInstructionsBlock(root, 'claude').action).toBe('absent');
    expect(existsSync(claudeMd())).toBe(false);
  });

  it('leaves a CLAUDE.md without a dreamcontext block untouched', () => {
    const own = '# Only my rules\n\nNo managed block here.\n';
    writeFileSync(claudeMd(), own, 'utf-8');

    expect(refreshManagedInstructionsBlock(root, 'claude').action).toBe('absent');
    expect(readFileSync(claudeMd(), 'utf-8')).toBe(own);
  });

  it('treats a start fence with no end fence as no block', () => {
    const broken = `# Mine\n\n${START}\nhalf a block\n`;
    writeFileSync(claudeMd(), broken, 'utf-8');

    expect(refreshManagedInstructionsBlock(root, 'claude').action).toBe('absent');
    expect(readFileSync(claudeMd(), 'utf-8')).toBe(broken);
  });

  it('never writes AGENTS.md, and leaves an existing one byte-identical', () => {
    const agentsMd = join(root, 'AGENTS.md');
    const agents = `# Codex notes\n\n${START}\nold\n${END}\n`;
    writeFileSync(agentsMd, agents, 'utf-8');
    writeFileSync(claudeMd(), USER_HEAD + STALE_BLOCK + USER_TAIL, 'utf-8');

    refreshManagedInstructionsBlock(root, 'claude');

    expect(readFileSync(agentsMd, 'utf-8')).toBe(agents);
  });

  it('refuses to write through a symlinked CLAUDE.md', () => {
    const real = join(root, 'elsewhere.md');
    const content = USER_HEAD + STALE_BLOCK + USER_TAIL;
    writeFileSync(real, content, 'utf-8');
    symlinkSync(real, claudeMd());

    expect(refreshManagedInstructionsBlock(root, 'claude').action).toBe('not-a-file');
    expect(readFileSync(real, 'utf-8')).toBe(content);
  });
});

describe('buildUpdateSummary reports the root instructions', () => {
  const base = { platforms: ['claude' as const], installedCount: 1, packs: [], removed: [], setupVersion: null };

  it('names a refreshed block', () => {
    expect(buildUpdateSummary({ ...base, rootInstructions: 'refreshed' }))
      .toContain('Root instructions: CLAUDE.md managed block refreshed');
  });

  it('says a project without a block was left alone', () => {
    expect(buildUpdateSummary({ ...base, rootInstructions: 'absent' }))
      .toContain('Root instructions: no dreamcontext block in CLAUDE.md, left alone');
  });

  it('omits the line when the refresh did not run (packs-only)', () => {
    expect(buildUpdateSummary({ ...base, rootInstructions: null })).not.toContain('Root instructions');
    expect(buildUpdateSummary(base)).not.toContain('Root instructions');
  });
});
