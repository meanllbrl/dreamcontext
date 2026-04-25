/**
 * Cohort entity helpers — read / write / list under
 * _dream_context/marketing/cohorts/<cohort_id>.{json,md}.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { customAlphabet } from 'nanoid';
import { MARKETING_PATHS } from './paths.js';
import { writeJsonWithBridge } from './store.js';
import type { Hypothesis } from './hypothesis.js';

// 22-char URL-safe alphanumeric id (collision-resistant for our scale)
const idgen = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

export interface Cohort {
  id: string;
  profile: string;
  name: string;
  hypothesis: Hypothesis;
  status: 'planning' | 'launched' | 'monitoring' | 'closed_won' | 'closed_lost' | 'killed';
  started_at: string;
  closed_at: string | null;
  campaign_ids: string[];
  /** Optional human note. */
  note?: string;
  created_at: string;
  updated_at: string;
}

export function newCohortId(): string {
  return `coh_${idgen()}`;
}

export function cohortPaths(id: string): { json: string; md: string } {
  const dir = MARKETING_PATHS.cohortsDir();
  return {
    json: join(dir, `${id}.json`),
    md: join(dir, `${id}.md`),
  };
}

export function loadCohort(id: string): Cohort | null {
  const { json } = cohortPaths(id);
  if (!existsSync(json)) return null;
  try {
    return JSON.parse(readFileSync(json, 'utf8')) as Cohort;
  } catch {
    return null;
  }
}

export function listCohorts(): Cohort[] {
  const dir = MARKETING_PATHS.cohortsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const cohorts: Cohort[] = [];
  for (const f of files) {
    try {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Cohort;
      cohorts.push(c);
    } catch {
      // skip malformed
    }
  }
  // Newest first
  cohorts.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return cohorts;
}

export function saveCohort(cohort: Cohort): void {
  const { json, md } = cohortPaths(cohort.id);
  const bridge = renderCohortBridge(cohort);
  writeJsonWithBridge(json, md, cohort, bridge);
}

function renderCohortBridge(c: Cohort): string {
  const fm = [
    '---',
    `id: ${c.id}`,
    `type: cohort`,
    `name: ${JSON.stringify(c.name)}`,
    `status: ${c.status}`,
    `profile: ${c.profile}`,
    `started_at: ${c.started_at}`,
    `campaign_ids: [${c.campaign_ids.map((id) => JSON.stringify(id)).join(', ')}]`,
    '---',
    '',
    `# ${c.name}`,
    '',
    '## Hypothesis',
    '',
    `- **Predicted winner:** ${c.hypothesis.predicted_winner}`,
    `- **Predicted metric:** ${c.hypothesis.predicted_metric}`,
    `- **Decision threshold:** ${c.hypothesis.decision_threshold}`,
    `- **Kill condition:** ${c.hypothesis.kill_condition}`,
    '',
  ];
  if (c.note) {
    fm.push('## Note', '', c.note, '');
  }
  return fm.join('\n');
}
