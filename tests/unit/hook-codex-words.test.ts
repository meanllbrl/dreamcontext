/**
 * The prompt hook a Codex or Antigravity turn gets (`--format codex`, what the bridge runs) speaks
 * that tool's words: no Read or Skill tool. Claude's own output is held byte for byte by
 * hook-golden.test.ts on the same kind of fixture. Runs on the built CLI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_ONLY } from '../../src/lib/tool-text.js';

const CLI = join(__dirname, '../..', 'dist', 'index.js');

describe('prompt hook in Codex words', () => {
  it.skipIf(!existsSync(CLI))('names the skill list and SKILL.md, never a Claude tool', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hook-codex-words-')));
    try {
      const home = join(root, 'home');
      const proj = join(root, 'acme-shop');
      const ctx = join(proj, '_dream_context');
      for (const d of [join(home, '.dreamcontext'), join(ctx, 'core'), join(ctx, 'state'), join(ctx, 'knowledge')]) mkdirSync(d, { recursive: true });
      writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: "acme-shop"\ntype: soul\nupdated: "2026-01-02"\n---\n\n## Project Identity\n\nA fictional storefront.\n');
      writeFileSync(join(ctx, 'knowledge', 'checkout.md'), '---\nname: Checkout flow\ndescription: How the checkout works\ntags: [checkout]\nupdated: "2026-01-02"\n---\n\nThe checkout has three steps: cart, address, payment.\n');
      writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1' }));
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, DREAMCONTEXT_BRAIN_SYNC: '0', DREAMCONTEXT_RECALL_CLOUD: '0', CLAUDE_PROJECT_DIR: proj };
      for (const k of ['DREAMCONTEXT_CHAT_TAB', 'CLAUDE_CODE_SESSION_ID', 'DREAMCONTEXT_CONTEXT_BY', 'DREAMCONTEXT_SKILLS_HOOK']) delete env[k];
      // One session per run: the long blocks print in full only on a session's first prompt.
      const run = (format: string[]) => spawnSync(process.execPath, [CLI, 'hook', 'user-prompt-submit', ...format], {
        cwd: proj, env, input: JSON.stringify({ prompt: 'how does the checkout work', session_id: `acme-${format.length}` }), encoding: 'utf-8', timeout: 60_000,
      });
      const codex = run(['--format', 'codex']);
      expect(codex.status, codex.stderr).toBe(0);
      expect(codex.stdout).toContain('OPEN the SKILL.md');
      expect(codex.stdout.split('\n').filter((l) => CLAUDE_ONLY.test(l))).toEqual([]);
      expect(codex.stdout).not.toContain('(Read tool)');
      const claude = run([]);
      expect(claude.stdout).toContain('via the Skill tool');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
