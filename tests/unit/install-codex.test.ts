/**
 * `dreamcontext install --tool codex` (Track T W3): opt-in per project, idempotent, and never
 * touches text that is not ours — another tool's hook entries, the owner's AGENTS.md.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CODEX_HOOK_SPECS, codexHookCommand, ensureCodexHooks } from '../../src/cli/commands/install-skill.js';
import { AGENTS_MD_END, AGENTS_MD_START, ensureAgentsMdBlock } from '../../src/lib/install-agents-md.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const project = () => { const d = mkdtempSync(join(tmpdir(), 'dc-install-codex-')); dirs.push(d); return d; };

describe('.codex/hooks.json', () => {
  it('nothing is written until asked (opt-in): a fresh project has no .codex', () => {
    expect(existsSync(join(project(), '.codex'))).toBe(false);
  });

  it('writes every event once, in Codex shape, and a second run changes nothing', () => {
    const p = project();
    expect(ensureCodexHooks(p).changed).toBe(true);
    const doc = JSON.parse(readFileSync(join(p, '.codex', 'hooks.json'), 'utf-8'));
    for (const spec of CODEX_HOOK_SPECS) {
      const cmds = (doc.hooks[spec.event] as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((h) => h.command));
      expect(cmds.filter((c) => c === codexHookCommand(spec.name)), spec.event).toHaveLength(1);
    }
    expect(codexHookCommand('session-start')).toContain('dreamcontext hook session-start --format codex');
    const before = readFileSync(join(p, '.codex', 'hooks.json'), 'utf-8');
    expect(ensureCodexHooks(p).changed).toBe(false);
    expect(readFileSync(join(p, '.codex', 'hooks.json'), 'utf-8')).toBe(before);
  });

  it('keeps entries that are not ours, and other keys of the file', () => {
    const p = project();
    mkdirSync(join(p, '.codex'));
    writeFileSync(join(p, '.codex', 'hooks.json'), JSON.stringify({ note: 'mine', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }] } }));
    ensureCodexHooks(p);
    ensureCodexHooks(p);
    const doc = JSON.parse(readFileSync(join(p, '.codex', 'hooks.json'), 'utf-8'));
    expect(doc.note).toBe('mine');
    expect(doc.hooks.PostToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }]);
    const stopCmds = doc.hooks.Stop.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));
    expect(stopCmds).toEqual(['say done', codexHookCommand('stop')]);
  });

  it('refuses to rewrite a file it cannot read as JSON (nothing written)', () => {
    const p = project();
    mkdirSync(join(p, '.codex'));
    writeFileSync(join(p, '.codex', 'hooks.json'), '{ not json');
    expect(() => ensureCodexHooks(p)).toThrow(/not valid JSON/);
    expect(readFileSync(join(p, '.codex', 'hooks.json'), 'utf-8')).toBe('{ not json');
  });
});

describe('AGENTS.md block', () => {
  it('creates, then appends to an owner file, then updates only between the markers', () => {
    const p = project();
    expect(ensureAgentsMdBlock(p)).toBe('created');
    expect(ensureAgentsMdBlock(p)).toBe('unchanged');

    const q = project();
    writeFileSync(join(q, 'AGENTS.md'), '# House rules\n\nUse tabs.\n');
    expect(ensureAgentsMdBlock(q)).toBe('appended');
    const text = readFileSync(join(q, 'AGENTS.md'), 'utf-8');
    expect(text.startsWith('# House rules\n\nUse tabs.\n\n')).toBe(true);
    expect(ensureAgentsMdBlock(q)).toBe('unchanged');

    // The owner edits around the block, and someone edits inside it: only the inside is restored.
    const edited = text.replace('Use tabs.', 'Use spaces.').replace('## dreamcontext', '## dreamcontext (edited)') + '\nFooter line.\n';
    writeFileSync(join(q, 'AGENTS.md'), edited);
    expect(ensureAgentsMdBlock(q)).toBe('updated');
    const after = readFileSync(join(q, 'AGENTS.md'), 'utf-8');
    expect(after).toContain('Use spaces.');
    expect(after).toContain('Footer line.');
    expect(after).not.toContain('(edited)');
    expect(after.split(AGENTS_MD_START)).toHaveLength(2);
    expect(after.split(AGENTS_MD_END)).toHaveLength(2);
  });
});
