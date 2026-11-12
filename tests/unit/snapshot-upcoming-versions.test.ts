/**
 * Upcoming Versions lists only what is still ahead (overnight audit MM-9): a
 * planning entry at or below the latest release is counted, not listed. Only a
 * NUMERIC version can be past; a sprint or milestone name always stays listed,
 * and the count line survives even when nothing upcoming is left. Fictional
 * vault, no real project.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSnapshot } from '../../src/cli/commands/snapshot.js';

let tmp: string;
let ctx: string;
const saved: Record<string, string | undefined> = {};
const cwd = process.cwd();

function releases(entries: Array<{ version: string; status: string }>): void {
  writeFileSync(join(ctx, 'core', 'RELEASES.json'), JSON.stringify(
    entries.map((e) => ({ ...e, date: '2026-01-01', summary: `Release ${e.version}` })), null, 2,
  ));
}

function upcoming(text: string): string {
  const at = text.indexOf('## Upcoming Versions');
  if (at === -1) return '';
  const next = text.indexOf('\n## ', at + 1);
  return text.slice(at, next === -1 ? undefined : next);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-upcoming-'));
  ctx = join(tmp, 'project', '_dream_context');
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: harbor-lantern\ntype: soul\n---\n\nA fictional app.\n');
  for (const k of ['HOME', 'DREAMCONTEXT_SNAPSHOT_BUDGET', 'DREAMCONTEXT_DRIFT_CHECK']) saved[k] = process.env[k];
  process.env.HOME = join(tmp, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = 'off';
  process.env.DREAMCONTEXT_DRIFT_CHECK = '0';
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwd);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('Upcoming Versions', () => {
  it('lists only versions above the latest release and counts the past ones', () => {
    releases([
      { version: '0.41.13', status: 'released' },
      { version: '0.41.12', status: 'planning' },
      { version: '0.41.1', status: 'planning' },
      { version: '0.41.14', status: 'planning' },
    ]);
    const block = upcoming(generateSnapshot(ctx));
    expect(block).toContain('- 0.41.14');
    expect(block).not.toContain('0.41.12');
    expect(block).not.toContain('- 0.41.1:');
    expect(block).toContain('(+2 planning entries at or below 0.41.13, not listed');
  });

  it('never treats a sprint name or a v-prefixed major as past', () => {
    releases([
      { version: 'v2.5.0', status: 'released' },
      { version: 'v3.0.0', status: 'planning' },
      { version: 'sprint-12', status: 'planning' },
      { version: 'v2.4.0', status: 'planning' },
    ]);
    const block = upcoming(generateSnapshot(ctx));
    expect(block).toContain('- v3.0.0');
    expect(block).toContain('- sprint-12');
    expect(block).not.toContain('- v2.4.0');
    expect(block).toContain('(+1 planning entry at or below v2.5.0');
  });

  it('keeps the count line under Latest Release when nothing upcoming is left', () => {
    releases([
      { version: '1.2.0', status: 'released' },
      { version: '1.1.0', status: 'planning' },
    ]);
    const text = generateSnapshot(ctx);
    expect(text).not.toContain('## Upcoming Versions');
    const latest = text.slice(text.indexOf('## Latest Release'));
    expect(latest).toContain('(+1 planning entry at or below 1.2.0, not listed');
  });
});
