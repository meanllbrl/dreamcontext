import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * Issue #11 follow-up — custom-field bridge.
 * Create a field on the list (Urgency / Summary / Reach / Impact / …) and the
 * sync systematically writes and reads it. No field → value stays local.
 */

const CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.0.0',
  disableNativeMemory: true,
  taskBackend: 'clickup',
  cloudTaskManagement: true,
  clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' },
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeClickUp;
let backend: ClickUpTaskBackend;
let localClock: number;

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-cuf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeClickUp();
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  backend = new ClickUpTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function remoteField(fieldId: string): unknown {
  return [...fake.tasks.values()][0].custom_fields.find((f) => f.id === fieldId)?.value;
}

function mirror(slug: string): string {
  return readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
}

describe('custom-field bridge (urgency / summary / RICE / …)', () => {
  it('push writes urgency (dropdown option), summary, and RICE numbers into matching list fields', async () => {
    await backend.create({
      name: 'Fielded',
      description: 'tek satirlik ozet',
      urgency: 'high',
      rice: { reach: 8, impact: 4, confidence: 75, effort: 2, score: 1200 },
      variant: 'cli',
    });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);

    expect(remoteField('fld_urgency')).toBe('opt_high'); // dropdown → option id
    expect(remoteField('fld_summary')).toBe('tek satirlik ozet');
    expect(remoteField('fld_reach')).toBe(8);
    expect(remoteField('fld_impact')).toBe(4);
    expect(remoteField('fld_confidence')).toBe(75);
    expect(remoteField('fld_effort')).toBe(2);
    expect(remoteField('fld_score')).toBe(1200);
  });

  it('no matching field on the list → that value stays local, no requests, no errors', async () => {
    fake.customFields = [{ id: 'fld_summary', name: 'Summary', type: 'short_text' }];
    await backend.create({ name: 'Partial Fields', description: 'ozet', urgency: 'critical', variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    const fieldWrites = fake.requests.filter((r) => r.method === 'POST' && /\/field\//.test(r.path));
    expect(fieldWrites).toHaveLength(1); // only the summary
    expect(remoteField('fld_summary')).toBe('ozet');
  });

  it('field pushes are delta-based and converge (re-sync sends nothing)', async () => {
    await backend.create({ name: 'Field Conv', urgency: 'low', variant: 'cli' });
    await backend.sync('both');

    fake.requests.length = 0;
    const again = await backend.sync('both');
    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);

    // local urgency change → exactly one field write
    await backend.updateFields('field-conv', { urgency: 'critical', updated_at: '2026-06-11' });
    fake.requests.length = 0;
    await backend.sync('push');
    const fieldWrites = fake.requests.filter((r) => r.method === 'POST' && /\/field\//.test(r.path));
    expect(fieldWrites).toHaveLength(1);
    expect(remoteField('fld_urgency')).toBe('opt_critical');
  });

  it('pull: a remote urgency/RICE edit lands in the mirror (score recomputed locally, never pulled)', async () => {
    await backend.create({
      name: 'Pull Fields',
      urgency: 'medium',
      rice: { reach: 5, impact: 3, confidence: 50, effort: 5, score: 150 },
      variant: 'cli',
    });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    // Remote side: urgency → critical, reach → 10, score → garbage (must be ignored)
    fake.setFieldValue(rid, 'fld_urgency', 'opt_critical');
    fake.setFieldValue(rid, 'fld_reach', 10);
    fake.setFieldValue(rid, 'fld_score', 99999);

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);

    const merged = mirror('pull-fields');
    expect(merged).toContain('urgency: critical');
    expect(merged).toContain('reach: 10');
    // score recomputed: 10 × 3 × 0.5 ÷ 5 = 3 → NOT the remote 99999
    expect(merged).not.toContain('99999');
  });

  it('both changed: remote (later) urgency wins; local-only change survives and pushes back', async () => {
    await backend.create({ name: 'Field LWW', urgency: 'low', description: 'eski ozet', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    // local: summary changes; remote (later): urgency changes
    await backend.updateFields('field-lww', { description: 'yeni ozet', updated_at: '2026-06-11' });
    fake.setFieldValue(rid, 'fld_urgency', 'opt_high');

    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);

    const merged = mirror('field-lww');
    expect(merged).toContain('urgency: high');      // remote won its field
    expect(merged).toContain('description: yeni ozet'); // local won its field
    expect(remoteField('fld_summary')).toBe('yeni ozet'); // and pushed back
  });
});
