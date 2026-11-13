import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CLOUD_DISCLOSURE_VERSION } from '../../src/lib/embeddings/egress-rules.js';
import { renderDisclosure, type CloudIndexPlan } from '../../src/lib/recall-cloud-disclosure.js';
import type { RecallCloudStatus } from '../../src/lib/recall-cloud-config.js';

/**
 * The disclosure is what a user consents to. If its wording changes, CLOUD_DISCLOSURE_VERSION must
 * be bumped (making every existing consent stale) and this pin updated in the same commit.
 */
const PINNED = { version: 1, sha256: '74f10d4e0c839a767b14b8d12b7828f05ff9216ba12b875088e327ad35708197' };

const plan: CloudIndexPlan = {
  toEmbed: 120, total: 300, estTokens: 45_000, estUsd: 0.0027,
  byType: { task: 40, knowledge: 30 }, withheld: { type_not_allowed: 12, secret_aws: 1 },
};
const status: RecallCloudStatus = {
  key: true, keySource: 'file', keyOrigin: 'manual', tier: 'local', consent: 'none', consentedAt: null, consentSurface: null, rerankModel: null,
  spend: { maxIndexUsd: 1, maxIndexUsd24h: 2, maxQueriesPerDay: 1000, maxEvalUsd: 5, vaultLifetimeUsd: 0, todayQueries: 0, indexSpend24hUsd: 0, evalSpentUsd: 0 },
  churn: null,
  indexStop: null,
};
const render = (): string => [
  ...renderDisclosure('cloud-index', plan, status, null),
  '---',
  ...renderDisclosure('cloud', plan, status, 'voyageai/rerank-2.5-lite'),
].join('\n');

describe('disclosure text is pinned to its version', () => {
  it('has the pinned version and text hash', () => {
    const hash = createHash('sha256').update(render()).digest('hex');
    expect({ version: CLOUD_DISCLOSURE_VERSION, sha256: hash }, 'disclosure wording changed: bump CLOUD_DISCLOSURE_VERSION and update PINNED').toEqual(PINNED);
  });

  it('states the load-bearing facts', () => {
    const text = render();
    expect(text).toContain('OpenRouter → Voyage AI');
    expect(text).toContain('data_collection: "deny"');
    expect(text).toContain('NOT zero-data-retention');
    expect(text).toContain('best-effort');
    expect(text).toContain('knowledge, feature, task, objective, thesis, whiteboard, core, memory');
    expect(text).toContain('there is no query-time egress');
    expect(text).toContain('voyageai/rerank-2.5-lite');
    expect(text).toContain('type_not_allowed 12');
  });

  it('never prints a key', () => {
    expect(render()).not.toMatch(/or-test|sk-/);
  });
});
