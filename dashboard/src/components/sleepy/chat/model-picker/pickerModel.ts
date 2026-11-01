/**
 * The r29 model picker's data, without React (Track T W4): which tools the rail shows, each
 * tool's models split into current and legacy, the search across tools, favourites and the
 * ⌘1-9 shortcuts. Tested on its own (tests/unit/model-picker.test.tsx).
 */
import { splitModels, type ModelConfig } from '../../../../lib/agentComposer';

export type PickerTool = 'claude' | 'codex';

export interface PickerModel {
  tool: PickerTool;
  id: string;
  label: string;
}

export interface PickerToolState {
  tool: PickerTool;
  label: string;
  /** Usable now. False draws the list greyed under a "Sign in" line. */
  ready: boolean;
  /** Why not, in one line; '' when ready. */
  blocker: '' | 'not-installed' | 'signed-out' | 'needs-node';
  current: PickerModel[];
  legacy: PickerModel[];
  efforts: string[];
}

/** Readiness as `/api/agent/tools` reports it (registry.ts ToolInfo). */
export interface ToolReadiness {
  tool: PickerTool;
  label: string;
  ready: boolean;
  installed: boolean;
  signedIn: boolean;
  nodeOk?: boolean;
  models: { id: string; label: string; efforts: string[] }[];
}

export function blockerOf(r: Pick<ToolReadiness, 'installed' | 'signedIn' | 'nodeOk'>): PickerToolState['blocker'] {
  if (!r.installed) return 'not-installed';
  if (!r.signedIn) return 'signed-out';
  if (r.nodeOk === false) return 'needs-node';
  return '';
}

/** A model's version family: `gpt-6.1-sol` → 6.1, `GPT-6 Luna` → 6. NaN when it has none. */
export function versionOf(m: { id: string; label: string }): number {
  const hit = /(\d+(?:\.\d+)?)/.exec(m.id) ?? /(\d+(?:\.\d+)?)/.exec(m.label);
  return hit ? Number(hit[1]) : NaN;
}

/**
 * Codex's list split the way r29 draws it: the newest version family is current, older ones are
 * "Legacy models". A list with one family (or no versions) is all current.
 */
export function splitByVersion(models: { id: string; label: string }[], tool: PickerTool): { current: PickerModel[]; legacy: PickerModel[] } {
  const rows = models.map((m) => ({ tool, id: m.id, label: m.label }));
  const versions = models.map(versionOf).filter((v) => Number.isFinite(v));
  if (versions.length === 0) return { current: rows, legacy: [] };
  const top = Math.max(...versions);
  const current = rows.filter((_, i) => !Number.isFinite(versionOf(models[i]!)) || versionOf(models[i]!) === top);
  const legacy = rows.filter((r) => !current.includes(r));
  return current.length ? { current, legacy } : { current: rows, legacy: [] };
}

/**
 * Claude's list: the composer's own model config, split the way the old menu split it
 * (`primary` = the first `primaryCount` or the ones not flagged other).
 */
export function claudeState(config: ModelConfig, model: string): PickerToolState {
  const { primary, other } = splitModels(config, model);
  return {
    tool: 'claude',
    label: 'Claude',
    ready: true,
    blocker: '',
    current: primary.map((m) => ({ tool: 'claude' as const, id: m.id, label: m.label })),
    legacy: other.map((m) => ({ tool: 'claude' as const, id: m.id, label: m.label })),
    efforts: config.efforts,
  };
}

export function codexState(r: ToolReadiness): PickerToolState {
  const { current, legacy } = splitByVersion(r.models, 'codex');
  return {
    tool: 'codex',
    label: r.label || 'Codex',
    ready: r.ready,
    blocker: r.ready ? '' : blockerOf(r) || 'signed-out',
    current,
    legacy,
    efforts: [...new Set(r.models.flatMap((m) => m.efforts))],
  };
}

/** Every model of every tool whose label or id holds the query (case-insensitive), in rail order. */
export function searchModels(tools: PickerToolState[], query: string): PickerModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return tools.flatMap((t) => [...t.current, ...t.legacy]).filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
}

export const favouriteKey = (m: Pick<PickerModel, 'tool' | 'id'>): string => `${m.tool}:${m.id}`;

/** The favourites, as models that still exist (a favourite of a model that left the list is dropped). */
export function favouriteModels(tools: PickerToolState[], keys: readonly string[]): PickerModel[] {
  const all = tools.flatMap((t) => [...t.current, ...t.legacy]);
  return keys.map((k) => all.find((m) => favouriteKey(m) === k)).filter((m): m is PickerModel => !!m);
}

export function toggleFavourite(keys: readonly string[], m: Pick<PickerModel, 'tool' | 'id'>): string[] {
  const k = favouriteKey(m);
  return keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k];
}

/** ⌘1-9: the n-th row of what is on screen, first nine only. */
export function shortcutFor(index: number): string | null {
  return index >= 0 && index < 9 ? `⌘${index + 1}` : null;
}

