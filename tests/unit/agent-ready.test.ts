/**
 * `agentCanSpawn` is the agent surface's FULL spawn guard, lifted out so the onboarding hand-off
 * asks the same question the surface will. Pinned two ways: an exhaustive truth table against
 * the surface's own expression, and a source check that the surface still computes (or now
 * imports) exactly that guard, so the two cannot drift apart silently.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentCanSpawn, type AgentSpawnInputs } from '../../dashboard/src/lib/agentReady.js';

const SURFACE = join(import.meta.dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'AgentSurface.tsx');

/** AgentSurface.tsx's full-guard sites, spelled exactly as the surface spells them. */
function surfaceGuard(i: AgentSpawnInputs): boolean {
  const caps = { desktop: i.desktop, claudeCli: i.claudeCli, embeddedTerminal: i.embeddedTerminal };
  const agentSettings = { chatView: i.chatView, enabled: i.enabled };
  const chatMode = !!agentSettings.chatView && !!caps?.claudeCli;
  const claudeReady = chatMode || !!(caps?.embeddedTerminal && caps?.claudeCli);
  return !!(caps?.desktop && caps.claudeCli && claudeReady) && !!agentSettings.enabled;
}

function allInputs(): AgentSpawnInputs[] {
  const out: AgentSpawnInputs[] = [];
  for (let n = 0; n < 32; n++) {
    out.push({
      desktop: !!(n & 1),
      claudeCli: !!(n & 2),
      chatView: !!(n & 4),
      embeddedTerminal: !!(n & 8),
      enabled: !!(n & 16),
    });
  }
  return out;
}

describe('agentCanSpawn', () => {
  it('equals the surface guard for all 32 input combinations', () => {
    for (const input of allInputs()) {
      expect({ input, value: agentCanSpawn(input) }).toEqual({ input, value: surfaceGuard(input) });
    }
  });

  it('chat view needs only the CLI; the terminal view also needs the embedded terminal', () => {
    const base = { desktop: true, claudeCli: true, enabled: true };
    expect(agentCanSpawn({ ...base, chatView: true, embeddedTerminal: false })).toBe(true);
    expect(agentCanSpawn({ ...base, chatView: false, embeddedTerminal: false })).toBe(false);
    expect(agentCanSpawn({ ...base, chatView: false, embeddedTerminal: true })).toBe(true);
  });

  it('never spawns off the desktop, without the CLI, or with the surface switched off', () => {
    const ok = { desktop: true, claudeCli: true, chatView: true, embeddedTerminal: true, enabled: true };
    expect(agentCanSpawn(ok)).toBe(true);
    expect(agentCanSpawn({ ...ok, desktop: false })).toBe(false);
    expect(agentCanSpawn({ ...ok, claudeCli: false })).toBe(false);
    expect(agentCanSpawn({ ...ok, enabled: false })).toBe(false);
  });

  it('the agent surface still uses this guard (inline, or through agentCanSpawn)', () => {
    const src = readFileSync(SURFACE, 'utf-8');
    const inline =
      /const chatMode = !!agentSettings\.chatView && !!caps\?\.claudeCli;/.test(src) &&
      /const claudeReady = chatMode \|\| !!\(caps\?\.embeddedTerminal && caps\?\.claudeCli\);/.test(src) &&
      /caps\?\.desktop && caps\.claudeCli && claudeReady\) \|\| !agentSettings\.enabled/.test(src);
    const shared = /from '\.\.\/\.\.\/lib\/agentReady'/.test(src) && /agentCanSpawn\(/.test(src);
    expect(inline || shared).toBe(true);
  });
});
