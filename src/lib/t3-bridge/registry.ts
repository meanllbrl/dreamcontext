/**
 * Which tools a chat can run on, and whether each is ready (plan r5 §3 `registry.ts`, W1 scope).
 *
 * W1 reads readiness from disk only, with no process spawned and no model call: the `codex`
 * binary on the claude-aware PATH, a sign-in record in `~/.codex` (its presence only, never its
 * content), the default model from `config.toml`, the model list Codex itself cached. T3's
 * provider snapshots (`ProviderInstanceRegistry`) take this over when accounts become instances
 * in W2. Never imports Effect: the dashboard server reads this on every Composer open.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

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
  /** installed + signed in */
  readonly ready: boolean;
  readonly installed: boolean;
  readonly signedIn: boolean;
  readonly defaultModel: string | null;
  readonly models: readonly ToolModel[];
}

/** `?tool=` from a socket URL: a known tool, or null (absent = today's Claude path). */
export function sanitizeTool(v: string | null | undefined): ToolId | null {
  return v === 'claude' || v === 'codex' ? v : null;
}

function onPath(bin: string, path: string): boolean {
  return path.split(delimiter).some((d) => d && existsSync(join(d, bin)));
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

export function codexInfo(o: { home?: string; path?: string } = {}): ToolInfo {
  const home = o.home ?? homedir();
  const installed = onPath(process.platform === 'win32' ? 'codex.cmd' : 'codex', o.path ?? process.env.PATH ?? '');
  const signedIn = existsSync(join(home, '.codex', 'auth.json'));
  const models = codexCachedModels(home);
  const defaultModel = codexDefaultModel(home) ?? models[0]?.id ?? null;
  return { tool: 'codex', label: 'Codex', installed, signedIn, ready: installed && signedIn, defaultModel, models };
}

export function listTools(o: { home?: string; path?: string } = {}): ToolInfo[] {
  return [
    { tool: 'claude', label: 'Claude', installed: true, signedIn: true, ready: true, defaultModel: null, models: [] },
    codexInfo(o),
  ];
}
