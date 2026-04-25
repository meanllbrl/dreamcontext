import { join } from 'node:path';
import { ensureContextRoot, resolveContextRoot } from '../context-path.js';

const MARKETING_DIR = 'marketing';
const KNOWLEDGE_DIR = 'knowledge';
const LEARNINGS_SUBDIR = 'marketing-learnings';

export function marketingRoot(from?: string): string {
  return join(ensureContextRoot(from), MARKETING_DIR);
}

export function marketingRootIfExists(from?: string): string | null {
  const ctx = resolveContextRoot(from);
  return ctx ? join(ctx, MARKETING_DIR) : null;
}

export function marketingPath(...segments: string[]): string {
  return join(marketingRoot(), ...segments);
}

export function knowledgePath(...segments: string[]): string {
  return join(ensureContextRoot(), KNOWLEDGE_DIR, ...segments);
}

export function knowledgePathIfExists(from?: string): string | null {
  const ctx = resolveContextRoot(from);
  return ctx ? join(ctx, KNOWLEDGE_DIR) : null;
}

export const MARKETING_PATHS = {
  envFile: () => marketingPath('.env'),
  lockFile: () => marketingPath('.lock'),
  configFile: () => marketingPath('config.json'),
  toolsDir: () => marketingPath('.tools'),
  reinfluenceDir: () => marketingPath('.tools', 'reinfluence'),
  venvDir: () => marketingPath('.venv'),
  venvPython: () => marketingPath('.venv', 'bin', 'python'),
  cacheDir: () => marketingPath('.cache'),
  whisperCacheDir: () => marketingPath('.cache', 'whisper'),
  cohortsDir: () => marketingPath('cohorts'),
  campaignsDir: () => marketingPath('campaigns'),
  adsetsDir: () => marketingPath('adsets'),
  adsDir: () => marketingPath('ads'),
  creativesDir: () => marketingPath('creatives'),
  briefsDir: () => marketingPath('briefs'),
  insightsDir: () => marketingPath('insights'),
  competitorsDir: () => marketingPath('competitors'),
  runsDir: () => marketingPath('runs'),
  byIdemDir: () => marketingPath('runs', 'by-idem'),
  runsIndex: () => marketingPath('runs', 'index.md'),
  learningsDir: () => knowledgePath(LEARNINGS_SUBDIR),
  learningsFile: (date: string) => knowledgePath(LEARNINGS_SUBDIR, `${date}.md`),
  learningsIndex: () => knowledgePath(LEARNINGS_SUBDIR, '.index.json'),
};
