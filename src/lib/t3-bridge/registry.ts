/**
 * Which tools a chat can run on, and whether each is ready (plan r5 §3 `registry.ts`, W1 scope).
 *
 * Readiness asks the one finder (`codex-bin.ts`), never this process's PATH: a Finder-started app
 * has none of the folders a Codex lands in. `codex --version` runs once per installed file, the
 * rest is read from disk with no model call: a sign-in record in `~/.codex` (its presence only,
 * never its content), the default model from `config.toml`, the model list Codex cached. T3's
 * provider snapshots (`ProviderInstanceRegistry`) take this over when accounts become instances
 * in W2. Never imports Effect: the dashboard server reads this on every Composer open.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexHealth, type CodexRunner } from '../codex-bin.js';
import { bridgeNode } from './node-floor.js';

export type ToolId = 'claude' | 'codex';
export const BRIDGE_TOOLS: readonly ToolId[] = ['codex'];
export const KNOWN_TOOLS: readonly ToolId[] = ['claude', 'codex'];

export interface ToolModel {
  readonly id: string;
  readonly label: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
}

export interface ToolInfo {
  readonly tool: ToolId;
  readonly label: string;
  /** installed, starts, signed in, and a Node that can run the bridge */
  readonly ready: boolean;
  readonly installed: boolean;
  readonly signedIn: boolean;
  /** A Node at the bridge floor exists on this machine (always true for Claude). */
  readonly nodeOk: boolean;
  /** Absent on Claude. `installed` but false: the file is there and `--version` failed. */
  readonly runs?: boolean;
  /** Why it did not start, one line. */
  readonly startError?: string;
  readonly version?: string;
  readonly bin?: string;
  readonly defaultModel: string | null;
  readonly models: readonly ToolModel[];
}

/** `?tool=` from a socket URL: a known tool, or null (absent = today's Claude path). */
export function sanitizeTool(v: string | null | undefined): ToolId | null {
  return v === 'claude' || v === 'codex' ? v : null;
}

/** The default model in `~/.codex/config.toml` (a top-level `model = "…"` line). */
export function codexDefaultModel(home: string = homedir()): string | null {
  try {
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8');
    for (const line of text.split('\n')) {
      if (/^\s*\[/.test(line)) break; // only the top-level table
      const m = /^\s*model\s*=\s*"([A-Za-z0-9._-]{1,64})"\s*$/.exec(line);
      if (m) return m[1]!;
    }
  } catch { /* no config */ }
  return null;
}

/** Codex's own model cache (`models_cache.json`): the models this account can use. */
export function codexCachedModels(home: string = homedir()): ToolModel[] {
  try {
    const j = JSON.parse(readFileSync(join(home, '.codex', 'models_cache.json'), 'utf-8')) as { models?: unknown };
    if (!Array.isArray(j.models)) return [];
    const out: ToolModel[] = [];
    for (const m of j.models as Array<Record<string, unknown>>) {
      const id = typeof m.slug === 'string' ? m.slug : '';
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || m.visibility === 'hide') continue;
      const levels = Array.isArray(m.supported_reasoning_levels)
        ? (m.supported_reasoning_levels as Array<{ effort?: unknown } | string>)
          .map((l) => (typeof l === 'string' ? l : typeof l.effort === 'string' ? l.effort : ''))
          .filter((l) => /^[a-z]{1,16}$/.test(l))
        : [];
      out.push({
        id,
        label: typeof m.display_name === 'string' ? m.display_name.slice(0, 64) : id,
        efforts: levels,
        defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export interface ToolLookup {
  home?: string;
  path?: string;
  node?: string | null;
  /** The login shell's PATH; `null` = do not ask. */
  loginPath?: (() => string | null) | null;
  system?: readonly string[];
  /** Tests stand in for `codex --version`. */
  run?: CodexRunner;
}

export function codexInfo(o: ToolLookup = {}): ToolInfo {
  const home = o.home ?? homedir();
  const h = codexHealth(o);
  const installed = h.bin !== null;
  const signedIn = existsSync(join(home, '.codex', 'auth.json'));
  const models = codexCachedModels(home);
  const defaultModel = codexDefaultModel(home) ?? models[0]?.id ?? null;
  const nodeOk = (o.node === undefined ? bridgeNode() : o.node) !== null;
  return {
    tool: 'codex', label: 'Codex', installed, signedIn, nodeOk, ready: installed && h.runs && signedIn && nodeOk, defaultModel, models,
    runs: h.runs,
    ...(h.version ? { version: h.version } : {}),
    ...(h.bin ? { bin: h.bin } : {}),
    ...(h.error ? { startError: h.error } : {}),
  };
}

export function listTools(o: ToolLookup = {}): ToolInfo[] {
  return [
    { tool: 'claude', label: 'Claude', installed: true, signedIn: true, nodeOk: true, ready: true, defaultModel: null, models: [] },
    codexInfo(o),
  ];
}
