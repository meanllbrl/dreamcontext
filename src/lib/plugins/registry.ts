/**
 * The plugin registry (Mağaza D1, contract C1): the ONE list of features that a project
 * installs or removes. The CLI gate, the server gate, the snapshot, sleep and the dashboard
 * mirror (`dashboard/src/lib/plugins.ts`, held equal by `plugins-mirror.test.ts`) all read it.
 *
 * Core stays always on and is not listed here: Chat, Tasks, Knowledge, Map, Whiteboards,
 * memory/sleep, team/automations/people, versions, Launchpad/apps, Mağaza, `learn`.
 *
 * The gate decides on the command path and the route pattern only, never on arguments
 * (plan Decision 9): `cliReads` and `cliSwitch` are EXACT leaf paths, never prefixes.
 * `plugins-registry-drift.test.ts` proves every path exists in the commander tree and every
 * route is registered, and that no owned non-GET route escapes `apiWrites`/`apiAlways`.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isLearningEnabled, readSetupConfig } from '../setup-config.js';

export type PluginId = 'roadmap' | 'hypotheses' | 'lab' | 'council' | 'marketing' | 'hackathon';
export type PluginCategory = 'product' | 'data' | 'marketing';

export interface PluginDef {
  id: PluginId;
  /** Plain English name for the CLI; the dashboard reads `plugin.<id>.name` from i18n. */
  label: string;
  /** The dashboard page id the plugin owns, when it has one. */
  page?: string;
  category: PluginCategory;
  /** Sleep runs a step for it (roadmap refresh, sleep-learn, council count, rem-sleep). */
  sleepStep: boolean;
  /** Top-level CLI commands the plugin owns (an alias resolves to its command's name). */
  cliRoots: string[];
  /** Exact leaf paths that only print: they run when the plugin is not installed. */
  cliReads: string[];
  /** Exact paths that install/remove the plugin: they always run. */
  cliSwitch: string[];
  /** `METHOD /pattern` exactly as registered in the router: refused when not installed. */
  apiWrites: string[];
  /** Owned non-GET routes that always pass (stopping a job, the switch). */
  apiAlways: string[];
  /** The plugin's data exists in this vault (the default when no owner entry is stored). */
  hasData(contextRoot: string): boolean;
}

// ─── Data probes: a symlinked path never counts (lstat, never followed) ─────

function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function hasRegularFile(dir: string, accept: (name: string) => boolean = () => true): boolean {
  if (!isRealDir(dir)) return false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (name.startsWith('.') || !accept(name)) continue;
    try {
      if (lstatSync(join(dir, name)).isFile()) return true;
    } catch {
      /* vanished between list and stat */
    }
  }
  return false;
}

/** Any regular file anywhere below `dir`, never through a symlink (bounded depth). */
function hasRegularFileDeep(dir: string, depth = 3): boolean {
  if (!isRealDir(dir)) return false;
  if (hasRegularFile(dir)) return true;
  if (depth <= 0) return false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => !name.startsWith('.') && hasRegularFileDeep(join(dir, name), depth - 1));
}

function roadmapHasData(contextRoot: string): boolean {
  if (!isRealDir(join(contextRoot, 'core'))) return false;
  return hasRegularFile(join(contextRoot, 'core', 'objectives'), (n) => n.endsWith('.md'));
}

function labHasData(contextRoot: string): boolean {
  const lab = join(contextRoot, 'lab');
  if (!isRealDir(lab)) return false;
  return hasRegularFileDeep(join(lab, 'insights')) || hasRegularFileDeep(join(lab, 'boards'));
}

function councilHasData(contextRoot: string): boolean {
  const dir = join(contextRoot, 'council');
  if (!isRealDir(dir)) return false;
  const index = join(dir, 'index.json');
  try {
    if (lstatSync(index).isFile()) {
      const parsed = JSON.parse(readFileSync(index, 'utf-8')) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
          ? (parsed as { entries: unknown[] }).entries
          : [];
      if (list.length > 0) return true;
    }
  } catch {
    /* unreadable index: fall through to the directory probe */
  }
  try {
    return readdirSync(dir).some((name) => !name.startsWith('.') && isRealDir(join(dir, name)));
  } catch {
    return false;
  }
}

function hypothesesHasData(contextRoot: string): boolean {
  // Owner decision: thesis files with the switch off do not count. This (and the store's
  // mirror write) is the only reader of `learning.enabled` outside setup-config.
  try {
    return isLearningEnabled(readSetupConfig(dirname(contextRoot)));
  } catch {
    return false;
  }
}

function hackathonHasData(contextRoot: string): boolean {
  const dir = join(contextRoot, 'hackathon');
  if (!isRealDir(dir)) return false;
  try {
    return readdirSync(dir).some((name) => /^\d{8}-/.test(name) && isRealDir(join(dir, name)));
  } catch {
    return false;
  }
}

function marketingHasData(contextRoot: string): boolean {
  return isRealDir(join(contextRoot, 'marketing'));
}

// ─── The registry ─────────────────────────────────────────────────────────

export const PLUGINS: readonly PluginDef[] = [
  {
    id: 'roadmap',
    label: 'Roadmap',
    page: 'roadmap',
    category: 'product',
    sleepStep: true,
    cliRoots: ['roadmap'],
    cliReads: ['roadmap unscored', 'roadmap objective list', 'roadmap objective show'],
    cliSwitch: [],
    apiWrites: [
      'POST /api/objectives',
      'PATCH /api/objectives/:slug',
      'DELETE /api/objectives/:slug',
      'POST /api/objectives/:slug/dependencies',
      'DELETE /api/objectives/:slug/dependencies/:to',
      'POST /api/objectives/:slug/suggestion/accept',
      'POST /api/objectives/:slug/suggestion/dismiss',
      'POST /api/roadmap/scoring/start',
      'PUT /api/roadmap-prefs',
    ],
    apiAlways: ['POST /api/roadmap/scoring/stop'],
    hasData: roadmapHasData,
  },
  {
    id: 'hypotheses',
    label: 'Hypotheses',
    page: 'hypotheses',
    category: 'data',
    sleepStep: true,
    cliRoots: ['theses'],
    // `theses candidates` stages claims into theses/.candidates.json: a write, never a read.
    cliReads: ['theses list', 'theses show'],
    cliSwitch: ['theses enable', 'theses disable'],
    apiWrites: [
      'POST /api/theses',
      'PATCH /api/theses/:slug',
      'DELETE /api/theses/:slug',
      'POST /api/theses/:slug/changelog',
      'POST /api/theses/:slug/evidence',
      'POST /api/theses/:slug/links',
      'DELETE /api/theses/:slug/links/:kind/:target',
      'POST /api/theses/:slug/predictions',
      'POST /api/theses/:slug/promote',
      'POST /api/theses/:slug/status',
    ],
    apiAlways: ['POST /api/learning/enable', 'POST /api/learning/disable'],
    hasData: hypothesesHasData,
  },
  {
    id: 'lab',
    label: 'Lab',
    page: 'lab',
    category: 'data',
    sleepStep: false,
    cliRoots: ['lab'],
    cliReads: [
      'lab list',
      'lab show',
      'lab body',
      'lab data check',
      'lab board list',
      'lab board show',
      'lab board validate',
      'lab block list',
    ],
    cliSwitch: [],
    apiWrites: [
      'POST /api/lab/sync',
      'POST /api/lab/sync-jobs',
      'POST /api/lab/credentials',
      'PATCH /api/lab/:slug/tweaks',
      'PATCH /api/lab/:slug/binding',
      'POST /api/lab/boards',
      'PUT /api/lab/boards/:slug',
      'DELETE /api/lab/boards/:slug',
      'PUT /api/lab/blocks/:slug',
      'PUT /api/lab-prefs',
    ],
    apiAlways: [],
    hasData: labHasData,
  },
  {
    id: 'council',
    label: 'Council',
    page: 'council',
    category: 'product',
    sleepStep: true,
    cliRoots: ['council'],
    cliReads: ['council list', 'council show', 'council timeline', 'council research list'],
    cliSwitch: [],
    apiWrites: [],
    apiAlways: [],
    hasData: councilHasData,
  },
  {
    id: 'hackathon',
    label: 'Hackathon',
    page: 'hackathon',
    category: 'product',
    sleepStep: false,
    cliRoots: ['hackathon'],
    cliReads: ['hackathon status', 'hackathon stats', 'hackathon show', 'hackathon list', 'hackathon design'],
    cliSwitch: [],
    apiWrites: [
      'POST /api/hackathon/:run/start',
      'POST /api/hackathon/:run/resume',
      'POST /api/hackathon/:run/pick',
      'POST /api/hackathon/:run/pr',
    ],
    apiAlways: ['POST /api/hackathon/:run/stop'],
    hasData: hackathonHasData,
  },
  {
    id: 'marketing',
    label: 'Marketing',
    category: 'marketing',
    sleepStep: true,
    cliRoots: ['marketing'],
    // Only leaves that write nothing under `_dream_context/` (held by plugins-cli.test.ts, which
    // runs each read leaf and compares the tree). `learnings status` flips a record and its lock
    // creates `marketing/`, so it is a write; `mk config` and the bootstrap commands likewise.
    cliReads: [
      'marketing competitor list',
      'marketing competitor health',
      'marketing account list',
      'marketing cohort list',
      'marketing cohort show',
      'marketing insights show',
      'marketing today',
      'marketing campaign list',
      'marketing adset list',
      'marketing creative list',
      'marketing ad list',
      'marketing learnings show',
      'marketing learnings list',
    ],
    cliSwitch: [],
    apiWrites: [],
    apiAlways: [],
    hasData: marketingHasData,
  },
];

export const PLUGIN_IDS: readonly PluginId[] = PLUGINS.map((p) => p.id);

export function isPluginId(value: unknown): value is PluginId {
  return typeof value === 'string' && (PLUGIN_IDS as readonly string[]).includes(value);
}

export function getPlugin(id: string): PluginDef | undefined {
  return PLUGINS.find((p) => p.id === id);
}

/** The plugin that owns a top-level CLI command (`mk` arrives already resolved to `marketing`). */
export function pluginForCliRoot(root: string): PluginDef | undefined {
  return PLUGINS.find((p) => p.cliRoots.includes(root));
}

/** The plugin whose `apiWrites` holds this registered `METHOD /pattern`. */
export function pluginForApiWrite(method: string, pattern: string): PluginDef | undefined {
  const key = `${method.toUpperCase()} ${pattern}`;
  return PLUGINS.find((p) => p.apiWrites.includes(key));
}

export type PluginGive = 'screen' | 'command' | 'agent' | 'sleep';

/** What installing brings, derived (never stored): Ekran / Komut / Ajan talimatı / Uyku işi. */
export function pluginGives(p: PluginDef): PluginGive[] {
  const out: PluginGive[] = [];
  if (p.page) out.push('screen');
  if (p.cliRoots.length > 0) out.push('command');
  out.push('agent');
  if (p.sleepStep) out.push('sleep');
  return out;
}
