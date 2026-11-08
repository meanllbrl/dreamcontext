/** TABLO rows 2 and 5: a bridge chat's `/` menu, and what `/name` sends the tool. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandSlash, slashCommandNames } from '../../../src/lib/t3-bridge/slash.js';
import { ToWire } from '../../../src/lib/t3-bridge/to-wire.js';

let root = '';
let cwd = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-slash-'));
  cwd = join(root, 'proj');
  home = join(root, 'home');
  mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(cwd, '.claude', 'skills', 'goal-skill'), { recursive: true });
  mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills', 'ugc-edit'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'commands', 'pattern-every-store-key.md'), '---\ndescription: x\n---\nRead the pattern file and apply it to $ARGUMENTS.\n');
  writeFileSync(join(cwd, '.claude', 'skills', 'goal-skill', 'SKILL.md'), '# goal');
  writeFileSync(join(home, '.claude', 'commands', 'standup.md'), 'Write my standup.');
  writeFileSync(join(home, '.claude', 'skills', 'ugc-edit', 'SKILL.md'), '# ugc');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('the / menu of a bridge chat', () => {
  it("lists the tool's own verbs, the project's commands and skills, then the owner's", () => {
    expect(slashCommandNames('codex', cwd, home)).toEqual(['clear', 'compact', 'pattern-every-store-key', 'goal-skill', 'standup', 'ugc-edit']);
    expect(slashCommandNames('antigravity', cwd, home)[0]).toBe('clear');
    expect(slashCommandNames('antigravity', cwd, home)).not.toContain('compact');
  });

  it('rides system/init, and an empty list is never sent (the client would take it as the whole menu)', () => {
    const w = new ToWire({ tool: 'codex', model: 'm', cwd, permissionMode: 'auto' });
    expect(w.init()).not.toHaveProperty('slash_commands');
    w.slashCommands = slashCommandNames('codex', cwd, home);
    expect(w.init().slash_commands).toContain('pattern-every-store-key');
  });

  it('a command becomes its body with the arguments filled in, as Claude expands it', () => {
    expect(expandSlash('/pattern-every-store-key the tab store', cwd, home)).toBe('Read the pattern file and apply it to the tab store.');
    expect(expandSlash('/standup today', cwd, home)).toBe('Write my standup.\n\nARGUMENTS: today');
  });

  it('a skill becomes an ask to read and follow it', () => {
    expect(expandSlash('/goal-skill ship the lid', cwd, home)).toBe(`Use the goal-skill skill: read ${join(cwd, '.claude', 'skills', 'goal-skill', 'SKILL.md')} first and follow it.\n\nship the lid`);
  });

  it('anything else is sent as typed', () => {
    expect(expandSlash('/usage', cwd, home)).toBeNull();
    expect(expandSlash('hello /goal-skill', cwd, home)).toBeNull();
    expect(expandSlash('/../../etc/passwd', cwd, home)).toBeNull();
  });
});
