/**
 * Eco end to end on Codex (Track T W3, criterion 4): the nudge reaches the Codex agent as app
 * context, the agent writes its handoff record through the brain MCP server's verb tool — keyed by
 * its pane, because the server's env carries the pane's tab id — and the next `/clear` rotation
 * consumes that record and hands its banner to the fresh thread. Runs the built CLI for the verb
 * (as the MCP server does), in a scratch vault and HOME.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ecoJoins } from '../../../src/lib/t3-bridge/eco.js';
import { codexBrainMcpArgs } from '../../../src/lib/t3-bridge/launch.js';
import { callBrainTool, defaultRunCli, resolveBrainRoots } from '../../../src/lib/brain-mcp/server.js';
import { readHandoffRecord } from '../../../src/lib/context-watch.js';

const CLI = join(__dirname, '../../..', 'dist', 'index.js');
const PANE = '5b2c7d1e-9a8f-4e3d-b2c1-a0f9e8d7c6b5';
const THREAD = '01a0d5eb-0000-7000-8000-00000000a01d';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-eco-codex-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const HOME = join(base, 'home');
const PROJ = join(base, 'acme-shop');
const ctx = join(PROJ, '_dream_context');

describe.skipIf(!existsSync(CLI))('Eco on Codex, end to end', () => {
  it('nudge as app context → handoff through the MCP verb, keyed by the pane → consumed on rotation', async () => {
    for (const d of [join(ctx, 'core'), join(ctx, 'state'), join(HOME, '.dreamcontext')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: "acme-shop"\ntype: soul\nupdated: "2026-01-02"\n---\n\nA fictional storefront.\n');
    writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', contextHandoff: { enabled: true, nudgeAt: 3000, remindEvery: 2000 } }));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME, DREAMCONTEXT_BRAIN_SYNC: '0', DREAMCONTEXT_RECALL_CLOUD: '0', DREAMCONTEXT_VERSION_CHECK: '0' };
    delete env.DREAMCONTEXT_TAB_SESSION;
    const made = spawnSync(process.execPath, [CLI, 'tasks', 'create', 'Checkout redesign', '--why', 'A fictional fixture task for the Codex brain checks'], { cwd: PROJ, env, encoding: 'utf-8', timeout: 60_000 });
    expect(made.status, made.stderr).toBe(0);
    const slug = 'checkout-redesign';
    expect(existsSync(join(ctx, 'state', `${slug}.md`))).toBe(true);

    // 1. The bridge measured Codex's context over the threshold: the nudge rides the next turn.
    const paneEnv = { DREAMCONTEXT_TAB_SESSION: PANE };
    const prevHome = process.env.HOME;
    process.env.HOME = HOME;
    try {
      const eco = ecoJoins(PROJ, paneEnv, { codexHome: join(HOME, '.codex') });
      const owed = eco.onResult(THREAD, 5_000);
      expect(owed.map((c) => c.key)).toEqual(['dreamcontext-context']);
      expect(owed[0]!.text).toContain('[context handoff]');

      // 2. Codex's MCP server for this pane is told the pane (its env is filtered by Codex).
      expect(codexBrainMcpArgs({ node: process.execPath, cli: CLI, root: PROJ, tabSession: PANE })).toContain(`DREAMCONTEXT_TAB_SESSION = "${PANE}"`);

      // 3. The agent writes its handoff through the verb tool, as that server runs it.
      const roots = resolveBrainRoots(PROJ);
      const r = await callBrainTool('dreamcontext', { args: ['tasks', 'handoff', slug, '--done', 'cart and address steps work, unit tests pass', '--next', 'build the payment step, then wire it after the address step', '--decisions', 'none', '--learned', 'none', '--style', 'small commits, unit tests after each step', '--files', 'none'] }, roots, defaultRunCli(process.execPath, CLI, { ...env, ...paneEnv })!) as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError, r.content[0]?.text).toBeUndefined();
      const record = readHandoffRecord(ctx, PANE);
      expect(record?.task).toBe(slug);

      // 4. `/clear` on the pane: the record is consumed and its banner goes to the fresh thread.
      const banner = eco.onRotated('01a0d5eb-0000-7000-8000-00000000b02e');
      expect(banner.map((c) => c.key)).toEqual(['dreamcontext-handoff']);
      expect(banner[0]!.text).toContain(`(${slug})`);
      // The banner points at the task, whose newest changelog entry is the agent's own handoff.
      expect(readFileSync(join(ctx, 'state', `${slug}.md`), 'utf-8')).toContain('build the payment step');
      expect(readHandoffRecord(ctx, PANE)?.consumedAt).toBeTruthy();
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    }
  }, 120_000);
});
