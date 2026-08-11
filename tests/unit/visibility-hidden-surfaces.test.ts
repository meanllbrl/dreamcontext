import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { generateSnapshot } from '../../src/cli/commands/snapshot.js';
import { buildGraph } from '../../src/lib/graph.js';
import { buildPeerSummary } from '../../src/lib/federation-peer-summary.js';
import { writeSetupConfig } from '../../src/lib/setup-config.js';

// ── `visibility: false` — the surfaces that DON'T go through the two choke
// points ───────────────────────────────────────────────────────────────────
// buildKnowledgeIndex and loadMarkdownDocs cover most of the brain, but the
// snapshot, the graph and the peer summary glob `state/`, `knowledge/features/`
// and `knowledge/products/` DIRECTLY. Each was a live leak found by running the
// real CLI against a probe vault; these are the regressions.
//
// Every assertion here is paired with a positive control (the same vault with
// no `visibility` field), because an assertion that a string is ABSENT proves
// nothing unless the string shows up when the flag is off.

function makeProject(): string {
  const dir = join(tmpdir(), `dc-vis-surf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '_dream_context', 'knowledge', 'features'), { recursive: true });
  mkdirSync(join(dir, '_dream_context', 'knowledge', 'products'), { recursive: true });
  mkdirSync(join(dir, '_dream_context', 'core'), { recursive: true });
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  return dir;
}

/** Build a vault; `hide` toggles the `visibility: false` line on every secret. */
function buildVault(hide: boolean): string {
  const projectRoot = makeProject();
  const ctx = join(projectRoot, '_dream_context');
  const v = hide ? 'visibility: false\n' : '';

  writeSetupConfig(projectRoot, {
    platforms: [], packs: [], multiProduct: ['widgets'],
    setupVersion: '0.23.1', disableNativeMemory: true,
  });

  writeFileSync(join(ctx, 'core', '0.soul.md'),
    '---\nname: probe\ntype: soul\n---\n\nA probe vault.\n', 'utf-8');

  // Active task bound to the `widgets` product — this is what pulls the product
  // knowledge file into the snapshot.
  writeFileSync(join(ctx, 'state', 'active-work.md'),
    '---\nname: Active widgets work\nstatus: in_progress\nproduct: widgets\n---\n\n## Why\n\nShip the widget pipeline.\n', 'utf-8');
  writeFileSync(join(ctx, 'state', 'quiet-work.md'),
    `---\nname: Quiet work\nstatus: in_progress\n${v}---\n\n## Why\n\nSECRET_TASK_WHY the plan nobody should see.\n`, 'utf-8');

  // Pin the active task deterministically: the heuristic picks the most recently
  // MODIFIED in_progress task, which in a test that writes both files in the same
  // millisecond is a coin flip — and the product injection only fires for the
  // task carrying `product:`.
  writeFileSync(join(ctx, 'state', '.active-task'), 'active-work', 'utf-8');

  writeFileSync(join(ctx, 'knowledge', 'products', 'widgets.md'),
    `---\nname: Widgets product\ndescription: product context\n${v}---\n\nSECRET_PRODUCT widget internals.\n`, 'utf-8');

  writeFileSync(join(ctx, 'knowledge', 'features', 'open-prd.md'),
    '---\nname: Open PRD\nstatus: active\n---\n\n## Why\n\nA feature everyone may see.\n', 'utf-8');
  writeFileSync(join(ctx, 'knowledge', 'features', 'quiet-prd.md'),
    `---\nname: Quiet PRD\nstatus: active\n${v}---\n\n## Why\n\nSECRET_PRD_WHY unannounced feature.\n`, 'utf-8');

  return ctx;
}

describe('visibility: false — snapshot (auto-loaded agent context)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(join(r, '..'), { recursive: true, force: true });
  });

  function snapshotOf(hide: boolean): string {
    const ctx = buildVault(hide);
    roots.push(ctx);
    return generateSnapshot(ctx);
  }

  it('keeps a hidden task out of the Active Tasks roster', () => {
    expect(snapshotOf(false)).toContain('Quiet work');   // control: it IS rendered
    expect(snapshotOf(true)).not.toContain('Quiet work');
  });

  it('keeps a hidden feature PRD out of the features roster', () => {
    expect(snapshotOf(false)).toContain('quiet-prd');
    expect(snapshotOf(true)).not.toContain('quiet-prd');
  });

  it('never injects a hidden product knowledge file (the direct-read back door)', () => {
    expect(snapshotOf(false)).toContain('SECRET_PRODUCT');
    expect(snapshotOf(true)).not.toContain('SECRET_PRODUCT');
  });

  it('leaves the visible siblings untouched', () => {
    const text = snapshotOf(true);
    expect(text).toContain('Active widgets work');
    expect(text).toContain('open-prd');
  });

  it('refuses to make a hidden task THE active task even via the .active-task override', () => {
    const ctx = buildVault(true);
    roots.push(ctx);
    // Point the override at the hidden task AND give it the product binding, so
    // an unguarded override would inject the hidden product file.
    writeFileSync(join(ctx, 'state', 'quiet-work.md'),
      '---\nname: Quiet work\nstatus: in_progress\nproduct: widgets\nvisibility: false\n---\n\n## Why\n\nSECRET_TASK_WHY.\n', 'utf-8');
    writeFileSync(join(ctx, 'state', '.active-task'), 'quiet-work', 'utf-8');

    const text = generateSnapshot(ctx);
    expect(text).not.toContain('SECRET_PRODUCT');
    expect(text).not.toContain('Quiet work');
  });
});

describe('visibility: false — brain graph', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(join(r, '..'), { recursive: true, force: true });
  });

  function nodeIdsOf(hide: boolean): string[] {
    const ctx = buildVault(hide);
    roots.push(ctx);
    return buildGraph(ctx).nodes.map((n) => n.id);
  }

  it('drops hidden task and feature nodes, exactly as it already drops hidden knowledge', () => {
    const control = nodeIdsOf(false);
    expect(control).toContain('task/quiet-work');
    expect(control).toContain('feature/quiet-prd');

    const hidden = nodeIdsOf(true);
    expect(hidden).not.toContain('task/quiet-work');
    expect(hidden).not.toContain('feature/quiet-prd');
    // The visible siblings still render — hiding is per-file, not per-section.
    expect(hidden).toContain('task/active-work');
    expect(hidden).toContain('feature/open-prd');
  });
});

describe('visibility: false — peer summary (cross-vault read)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(join(r, '..'), { recursive: true, force: true });
  });

  function summaryOf(hide: boolean) {
    const ctx = buildVault(hide);
    roots.push(ctx);
    // Make the hidden task the ONLY active one, so the assertion is decisive.
    rmSync(join(ctx, 'state', 'active-work.md'));
    return buildPeerSummary(ctx, 'peer');
  }

  it("a peer's hidden task never becomes our ambient awareness", () => {
    expect(summaryOf(false).activeTask).toBe('Quiet work');
    expect(summaryOf(true).activeTask).toBe('');
  });
});
