import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import { bodyToIssueBody } from '../../src/lib/task-backend/github-map.js';

/**
 * A card with no `## Changelog` (one the reverted 0.33.0 build migrated, or one
 * written by hand): every CLI changelog writer (`tasks log`, `status`,
 * `complete`, handoff, builder sessions, sleep) used to append the raw entry at
 * EOF, i.e. inside whatever section came last, which a remote backend then
 * pushed as the issue description. Fixture: fictional.
 */

let ctx: string;
let root: string;

beforeEach(() => {
  const raw = join(tmpdir(), `dc-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  root = realpathSync(raw);
  ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const CARD = `---
id: task_orbit001
name: Orbit tiles
description: Orbit tiles
priority: medium
urgency: medium
status: in_progress
created_at: '2026-09-01'
updated_at: '2026-10-19'
tags: []
parent_task: null
related_feature: null
version: null
---
## Why

Orbit needs square tiles.

## Notes

Keep the orbit tiles square.
`;

describe('tasks log on a card without a Changelog', () => {
  it('creates the section at the end of the card instead of appending into the last section', async () => {
    writeFileSync(join(ctx, 'state', 'orbit-tiles.md'), CARD);
    const local = new LocalTaskBackend(join(ctx, 'state'));
    await local.addChangelog('orbit-tiles', '### 2026-10-20 - Session Update\n- probe', { createIfMissing: true });

    const after = readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8');
    const notes = after.slice(after.indexOf('## Notes'), after.indexOf('## Changelog'));
    expect(after).toMatch(/## Changelog\n\n### 2026-10-20 - Session Update\n- probe\n/);
    expect(notes).not.toContain('probe');
    expect(bodyToIssueBody(after)).not.toContain('probe'); // never pushed as the description
    expect((await local.get('orbit-tiles'))!.changelog).toContain('- probe');
  });
});
