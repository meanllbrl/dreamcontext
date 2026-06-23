import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
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
  it('sync AUTO-PROVISIONS the missing recommended fields and pushes their values', async () => {
    // The list starts with only Summary — Urgency / RICE / Feature / Version are
    // missing. The user no longer has to click "Provision": a sync creates them.
    fake.customFields = [{ id: 'fld_summary', name: 'Summary', type: 'short_text' }];
    await backend.create({ name: 'Pre Provision', urgency: 'high', variant: 'cli' });

    await backend.sync('push');

    // Summary (pre-existing) + the full recommended set now live on the list.
    expect(fake.customFields.map((f) => f.name).sort()).toEqual(
      ['Confidence', 'Effort', 'Feature', 'Impact', 'RICE Score', 'Reach', 'Summary', 'Urgency', 'Version'].sort(),
    );
    // The new dropdown carries its options, and the urgency value was pushed into it.
    const urgency = fake.customFields.find((f) => f.name === 'Urgency');
    expect(urgency?.type).toBe('drop_down');
    expect(urgency?.type_config?.options?.map((o) => o.name)).toEqual(['low', 'medium', 'high', 'critical']);
    const remote = [...fake.tasks.values()][0];
    expect(remote.custom_fields.find((f) => f.id === urgency!.id)?.value).toBe('opt_Urgency_high');

    // Auto-provision is idempotent: a follow-up sync creates nothing and converges.
    fake.requests.length = 0;
    const sync = await backend.sync('both');
    expect(sync.pushed).toBe(0);
    expect(sync.pulled).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('provisionRemote BACKFILLS an already-synced task whose remote field was emptied', async () => {
    fake.customFields = [{ id: 'fld_summary', name: 'Summary', type: 'short_text' }];
    await backend.create({ name: 'Backfill Me', urgency: 'high', variant: 'cli' });
    await backend.sync('push'); // auto-provisions the fields + writes urgency

    const remote = [...fake.tasks.values()][0];
    const urgencyId = fake.customFields.find((f) => f.name === 'Urgency')!.id;
    // Someone clears the field on ClickUp; the local task still says high and has
    // no hash drift, so a normal delta push would never re-send it.
    fake.setFieldValue(remote.id, urgencyId, null);

    const result = await backend.provisionRemote!();
    expect(result.errors).toEqual([]);
    expect(result.created).toEqual([]); // schema already complete
    expect(result.existing).toContain('Urgency');
    expect(result.backfilled).toBeGreaterThan(0); // re-filled from the local value
    expect(remote.custom_fields.find((f) => f.id === urgencyId)?.value).toBe('opt_Urgency_high');

    // Idempotent: a second run backfills nothing (the field is populated again).
    const again = await backend.provisionRemote!();
    expect(again.created).toEqual([]);
    expect(again.backfilled).toBe(0);
  });

  it('provisionRemote({ dryRun: true }) PREVIEWS the delta without creating or writing anything', async () => {
    fake.customFields = [{ id: 'fld_summary', name: 'Summary', type: 'short_text' }];
    await backend.create({ name: 'Preview Me', urgency: 'high', variant: 'cli' });
    // Deliberately do NOT sync first (a sync would auto-provision). Preview the
    // still-missing recommended fields.
    fake.requests.length = 0;

    const preview = await backend.provisionRemote!({ dryRun: true });
    expect(preview.existing).toEqual(['Summary']);
    expect(preview.created).toEqual([
      'Urgency', 'Reach', 'Impact', 'Confidence', 'Effort', 'RICE Score', 'Feature', 'Version',
    ]);
    expect(preview.backfilled).toBe(0);

    // Nothing was actually created on the list, and no mutating requests fired.
    expect(fake.customFields.map((f) => f.name)).toEqual(['Summary']);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

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

  it('a missing recommended field is auto-created on sync and its value is pushed alongside the existing one', async () => {
    fake.customFields = [{ id: 'fld_summary', name: 'Summary', type: 'short_text' }];
    await backend.create({ name: 'Partial Fields', description: 'ozet', urgency: 'critical', variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    // The pre-existing Summary receives its value...
    expect(remoteField('fld_summary')).toBe('ozet');
    // ...and the previously-missing Urgency field is auto-created and populated.
    const urgency = fake.customFields.find((f) => f.name === 'Urgency');
    expect(urgency).toBeDefined();
    const remote = [...fake.tasks.values()][0];
    expect(remote.custom_fields.find((f) => f.id === urgency!.id)?.value).toBe('opt_Urgency_critical');
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

describe('user-defined custom fields via overrides/task.md (reuse-if-exists)', () => {
  function writeOverride(): void {
    mkdirSync(join(contextRoot, 'overrides'), { recursive: true });
    writeFileSync(
      join(contextRoot, 'overrides', 'task.md'),
      [
        '---',
        'custom_fields:',
        '  - { name: "Team", type: select, options: [platform, growth], sync: [clickup] }',
        '  - { name: "Story Points", type: number, sync: [clickup] }',
        '---',
        '## Why',
        '{{WHY}}',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  it('binds a user field to a PRE-EXISTING like-named list field and pushes its value (no duplicate)', async () => {
    writeOverride();
    // The list already has a "Team" drop_down (e.g. created by the team manually).
    fake.customFields = [
      {
        id: 'fld_team',
        name: 'Team',
        type: 'drop_down',
        type_config: {
          options: [
            { id: 'opt_team_platform', name: 'platform', orderindex: 0 },
            { id: 'opt_team_growth', name: 'growth', orderindex: 1 },
          ],
        },
      },
    ];

    await backend.create({
      name: 'Override Fielded',
      custom_fields: { team: 'platform', story_points: 8 },
      variant: 'cli',
    });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);

    // Value landed in the EXISTING Team field (dropdown → option id), which was
    // REUSED, never duplicated.
    expect(remoteField('fld_team')).toBe('opt_team_platform');
    expect(fake.customFields.filter((f) => f.name === 'Team')).toHaveLength(1);
    // Story Points (override-declared) is auto-provisioned on sync and its value
    // pushed too — no manual "Provision" click required.
    const sp = fake.customFields.find((f) => f.name === 'Story Points');
    expect(sp).toBeDefined();
    const remote = [...fake.tasks.values()][0];
    expect(remote.custom_fields.find((f) => f.id === sp!.id)?.value).toBe(8);
  });

  it('provisionRemote REUSES the existing Team field and only CREATES the missing Story Points', async () => {
    writeOverride();
    fake.customFields = [
      {
        id: 'fld_team',
        name: 'Team',
        type: 'drop_down',
        type_config: { options: [{ id: 'opt_team_platform', name: 'platform', orderindex: 0 }] },
      },
    ];

    const result = await backend.provisionRemote!();
    expect(result.errors).toEqual([]);
    expect(result.existing).toContain('Team');          // reused, NOT recreated
    expect(result.created).toContain('Story Points');   // the only missing user field
    expect(result.created).not.toContain('Team');
  });

  it('pulls a remote edit of a user field back into the mirror custom_fields map', async () => {
    writeOverride();
    fake.customFields = [
      {
        id: 'fld_team',
        name: 'Team',
        type: 'drop_down',
        type_config: {
          options: [
            { id: 'opt_team_platform', name: 'platform', orderindex: 0 },
            { id: 'opt_team_growth', name: 'growth', orderindex: 1 },
          ],
        },
      },
    ];
    await backend.create({ name: 'Override Pull', custom_fields: { team: 'platform' }, variant: 'cli' });
    await backend.sync('both');

    // A teammate moves it to growth on ClickUp (setFieldValue bumps server time).
    const rid = [...fake.tasks.keys()][0];
    fake.setFieldValue(rid, 'fld_team', 'opt_team_growth');

    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);
    const merged = mirror('override-pull');
    expect(merged).toContain('team: growth');
  });
});
