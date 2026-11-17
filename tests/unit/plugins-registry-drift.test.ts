/**
 * Mağaza D1, C1 invariants: the registry names only real commands and real routes, and no owned
 * write escapes it. Plus criterion 7: nothing outside the three allowed files reads
 * `learning.enabled` or calls `isLearningEnabled` (the Hypotheses plugin is the one switch).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Command } from 'commander';
import { createProgram } from '../../src/cli/program.js';
import { PLUGIN_CLI_ROOTS } from '../../src/cli/root.js';
import { buildRouter } from '../../src/server/index.js';
import { PLUGINS } from '../../src/lib/plugins/registry.js';
import { pluginCliRoots } from '../../src/lib/plugins/gate.js';

const repo = join(__dirname, '..', '..');

function commandPaths(): Set<string> {
  const out = new Set<string>();
  const walk = (c: Command, path: string[]): void => {
    if (path.length > 0) out.add(path.join(' '));
    for (const s of c.commands) walk(s, [...path, s.name()]);
  };
  walk(createProgram(), []);
  return out;
}

describe('registry ↔ commander tree', () => {
  const paths = commandPaths();
  it('every root, read and switch path exists', () => {
    const missing = PLUGINS.flatMap((p) => [...p.cliRoots, ...p.cliReads, ...p.cliSwitch]).filter((x) => !paths.has(x));
    expect(missing).toEqual([]);
  });
  it('the root hook mirror equals the registry roots', () => {
    expect([...PLUGIN_CLI_ROOTS].sort()).toEqual([...pluginCliRoots()].sort());
  });
});

describe('registry ↔ router', () => {
  const routes = buildRouter().list().map((r) => `${r.method} ${r.path}`);
  const registered = new Set(routes);

  it('every apiWrites/apiAlways entry is a registered route', () => {
    const missing = PLUGINS.flatMap((p) => [...p.apiWrites, ...p.apiAlways]).filter((r) => !registered.has(r));
    expect(missing).toEqual([]);
  });

  it('every registered non-GET route under an owned prefix is in apiWrites or apiAlways', () => {
    const owned = /^(POST|PUT|PATCH|DELETE) \/api\/(objectives|roadmap|roadmap-prefs|theses|lab|lab-prefs|learning|council|marketing)(\/|$)/;
    const known = new Set(PLUGINS.flatMap((p) => [...p.apiWrites, ...p.apiAlways]));
    const escaped = routes.filter((r) => owned.test(r) && !known.has(r));
    expect(escaped).toEqual([]);
  });

  it('a route belongs to at most one plugin', () => {
    const all = PLUGINS.flatMap((p) => [...p.apiWrites, ...p.apiAlways]);
    expect(all.length).toBe(new Set(all).size);
  });
});

describe('one switch for Hypotheses (criterion 7)', () => {
  const ALLOWED = new Set(['src/lib/setup-config.ts', 'src/lib/plugins/registry.ts', 'src/lib/plugins/store.ts']);

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  }

  /** Code only: block and line comments, and string/template literals, are blanked. */
  function codeOnly(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, '``');
  }

  it('no code read of learning.enabled or call of isLearningEnabled outside the three files', () => {
    const offenders: string[] = [];
    for (const f of files(join(repo, 'src'))) {
      const rel = relative(repo, f);
      if (ALLOWED.has(rel)) continue;
      const code = codeOnly(readFileSync(f, 'utf-8'));
      if (/\blearning\??\.enabled\b/.test(code) || /\bisLearningEnabled\s*\(/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
