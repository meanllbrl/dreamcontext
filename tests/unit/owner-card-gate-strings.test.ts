/**
 * Lane B of sahip-karti-yerinde:
 *  - K8: the heavy-step refusal (hook Gate 1d, `builder heavy`) names the run card the owner can
 *    run: the bare command, `cd` inside it, no absolute cwd. The two copies are one text.
 *  - K4: no agent path reaches the owner's actions. No CLI verb (everything `createProgram()`
 *    builds lives under src/cli), no server-side helper an agent's verb runs (src/lib), and no
 *    window command handler mints a ticket or calls a card-action route; only the route module
 *    mints.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HEAVY_OWNER_RUN_CARD_LINE } from '../../src/cli/commands/builder.js';
import { OWNER_RUN_CARD_LINE } from '../../src/cli/commands/hook.js';

const REPO = join(__dirname, '..', '..');

/** Code only: block and line comments dropped (a doc comment may name a route). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('K8: the refusal names the run card the owner can run', () => {
  it('both copies are the same text, and it says: run card, bare command, cd inside, no absolute cwd', () => {
    expect(OWNER_RUN_CARD_LINE).toBe(HEAVY_OWNER_RUN_CARD_LINE);
    expect(OWNER_RUN_CARD_LINE).toMatch(/run card/);
    expect(OWNER_RUN_CARD_LINE).toMatch(/bare command/);
    expect(OWNER_RUN_CARD_LINE).toMatch(/cd inside the command/);
    expect(OWNER_RUN_CARD_LINE).toMatch(/no absolute cwd/);
  });

  it('Gate 1d and `builder heavy`\'s spent-because refusal print it', () => {
    const hook = readFileSync(join(REPO, 'src/cli/commands/hook.ts'), 'utf-8');
    const gate = hook.slice(hook.indexOf('// Gate 1d'), hook.indexOf('// Gate 2'));
    expect(gate).toContain('OWNER_RUN_CARD_LINE');
    const builder = readFileSync(join(REPO, 'src/cli/commands/builder.ts'), 'utf-8');
    // The `--because`-already-spent refusal of `builder heavy` (not the red-suite line that also says it).
    const at = builder.indexOf('and this run already spent its one --because on');
    expect(at).toBeGreaterThan(0);
    expect(builder.slice(at, at + 600)).toContain('HEAVY_OWNER_RUN_CARD_LINE');
  });
});

describe('K4: no agent path to a ticket or a card action', () => {
  const ROUTES = ['/api/agent/card-ticket', '/api/agent/cards/checklist-submit', '/api/agent/cards/not-needed'];

  it('no CLI verb or lib module names a card-action route or mints a ticket', () => {
    const hits: string[] = [];
    for (const f of [...walk(join(REPO, 'src/cli')), ...walk(join(REPO, 'src/lib'))]) {
      const text = code(readFileSync(f, 'utf-8'));
      if (ROUTES.some((r) => text.includes(r)) || /\bmintCardTicket\b/.test(text)) hits.push(relative(REPO, f));
    }
    expect(hits).toEqual([]);
  });

  it('only the card-action route module mints a ticket on the server', () => {
    const minters = walk(join(REPO, 'src/server'))
      .filter((f) => /\bmintCardTicket\(/.test(code(readFileSync(f, 'utf-8'))))
      .map((f) => relative(REPO, f).split('\\').join('/'));
    expect(minters.sort()).toEqual(['src/server/card-ticket.ts', 'src/server/routes/card-actions.ts']);
  });

  it('the window\'s command handlers (hub_command, window_command, super_command) reach no card action', () => {
    for (const rel of ['dashboard/src/lib/hubCommands.ts', 'dashboard/src/lib/chatProtocol.ts']) {
      const text = code(readFileSync(join(REPO, rel), 'utf-8'));
      for (const r of ROUTES) expect(text.includes(r), `${rel} names ${r}`).toBe(false);
      expect(text).not.toMatch(/card-ticket|cardTicket/);
    }
  });
});
