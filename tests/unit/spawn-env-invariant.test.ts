/**
 * DREAMCONTEXT_TAB_SESSION ⇒ DREAMCONTEXT_SERVER_PID, over every env builder (task: the desktop
 * app stays light on an 8GB MacBook Air, plan S10, AC13).
 *
 * The orphan sweep (src/lib/orphan-processes.ts) attributes a leftover process to a chat tab
 * only when it carries BOTH markers, so a spawn that exported the tab id without the server
 * pid would leave its leftovers unreapable for ever. The invariant is ONE-directional: the
 * dashboard server stamps its pid with no tab id (`prepareDashboardEnv`), and that is legal.
 *
 * Two layers: the builders themselves, and a scan of `src/` that holds every OTHER site to the
 * same rule — a tab id is minted only through `tabSessionEnv`, and any code that strips the
 * server pid strips the tab id in the same place.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { prepareDashboardEnv, tabSessionEnv } from '../../src/lib/session-origin.js';
import { BUILDER_ENV_UNSET, builderEnv } from '../../src/lib/builder-spawn.js';

const TAB = 'DREAMCONTEXT_TAB_SESSION';
const PID = 'DREAMCONTEXT_SERVER_PID';
const PANE = '4ceec0b6-6644-4105-b96e-617cb92bdc92';

function holds(env: Record<string, string | undefined>): boolean {
  return !env[TAB] || !!env[PID];
}

describe('env builders', () => {
  it('tabSessionEnv always carries the server pid with the tab id', () => {
    const env = tabSessionEnv(PANE, 4242);
    expect(env).toEqual({ [TAB]: PANE, [PID]: '4242' });
    expect(tabSessionEnv(PANE)[PID]).toBe(String(process.pid));
  });

  it('prepareDashboardEnv: the server pid without a tab id is legal, and an inherited tab id is dropped', () => {
    const env: NodeJS.ProcessEnv = { [TAB]: PANE, CLAUDE_CODE_SESSION_ID: 'x' };
    prepareDashboardEnv(env, 99);
    expect(env[TAB]).toBeUndefined();
    expect(env[PID]).toBe('99');
    expect(holds(env)).toBe(true);
  });

  it('builderEnv strips both markers from a pane-inherited env', () => {
    const env = builderEnv({ ...tabSessionEnv(PANE, 7), PATH: '/bin' }, '-');
    expect(env[TAB]).toBeUndefined();
    expect(env[PID]).toBeUndefined();
    expect(BUILDER_ENV_UNSET).toContain(TAB);
    expect(BUILDER_ENV_UNSET).toContain(PID);
  });

  it('a pane env spread over the server env keeps the invariant', () => {
    const server: NodeJS.ProcessEnv = {};
    prepareDashboardEnv(server, 1190);
    expect(holds({ ...server, ...tabSessionEnv(PANE, 1190) })).toBe(true);
  });
});

// ─── Every other site in src/ ──────────────────────────────────────────────────

const SRC = join(__dirname, '..', '..', 'src');

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Code with comments dropped (a doc comment may name a marker freely). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('src/ sites', () => {
  const files = tsFiles(SRC).map((p) => ({ rel: relative(SRC, p), text: code(readFileSync(p, 'utf-8')) }));

  it('a tab id is minted into an env only by tabSessionEnv', () => {
    // An object key or an assignment that SETS the tab id: `{ DREAMCONTEXT_TAB_SESSION: x }`,
    // `env.DREAMCONTEXT_TAB_SESSION = x`, `env['DREAMCONTEXT_TAB_SESSION'] = x` — not a read, a
    // comparison or a ternary branch.
    const setter = /(?:[{,]\s*|^\s*)['"]?DREAMCONTEXT_TAB_SESSION['"]?\s*:(?!:)|\.DREAMCONTEXT_TAB_SESSION\s*=(?!=)|\[['"]DREAMCONTEXT_TAB_SESSION['"]\]\s*=(?!=)/;
    const offenders = files
      .filter((f) => f.rel !== join('lib', 'session-origin.ts'))
      .filter((f) => f.text.split('\n').some((l) => setter.test(l)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('any code that strips the server pid strips the tab id in the same file', () => {
    const stripsPid = /delete\s+[\w.]+\.DREAMCONTEXT_SERVER_PID|-u\s+DREAMCONTEXT_SERVER_PID|'DREAMCONTEXT_SERVER_PID'/;
    const stripsTab = /delete\s+[\w.]+\.DREAMCONTEXT_TAB_SESSION|-u\s+DREAMCONTEXT_TAB_SESSION|'DREAMCONTEXT_TAB_SESSION'/;
    const offenders = files
      .filter((f) => f.rel !== join('lib', 'orphan-processes.ts')) // the reader, not a spawn
      .filter((f) => stripsPid.test(f.text) && !stripsTab.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
