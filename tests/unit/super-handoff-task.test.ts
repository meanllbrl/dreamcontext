/**
 * In a Super Agent session the context-handoff nudge sends the super to its OWN handoff file
 * through `dreamcontext super handoff`, never to a task (task super-agent-devrini-…; the owner,
 * 2026-10-22: "Super agent'a task açılmamalı"). A non-super session's nudge is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeNudge, renderNudge } from '../../src/lib/context-watch.js';
import { superHandoffContext } from '../../src/lib/super/handoff-task.js';
import * as handoffTask from '../../src/lib/super/handoff-task.js';
import { SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { resolveContextHandoff } from '../../src/lib/setup-config.js';

const SUPER = '11111111-2222-3333-4444-555555555555';
const SES = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let projectRoot: string;
let contextRoot: string;

const task = (slug: string, name: string, status: string, updated: string) =>
  writeFileSync(join(contextRoot, 'state', `${slug}.md`), `---\nname: '${name}'\nstatus: ${status}\nupdated_at: '${updated}'\ntags: []\n---\n\n## Why\nx\n`);
const superRecord = (enabled: boolean) => writeFileSync(join(contextRoot, SUPER_STATE_REL), JSON.stringify({
  session: SUPER, enabled,
  children: { c1: { sessionId: 'c1', task: 'odev-ver-akisi' }, c2: { sessionId: 'c2' }, c3: { sessionId: 'c3', endedAt: 5 } },
}));

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-super-handoff-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1', contextHandoff: { enabled: true, nudgeAt: 3000, remindEvery: 2000 } }));
  superRecord(true);
  // Three open tasks, one of which reads like a coordination list: none of them is the super's.
  task('odev-ver-akisi', 'Ödev Ver akışı', 'in_progress', '2026-10-21');
  task('giris-ekrani-duzeltmesi', 'Giriş ekranı düzeltmesi', 'in_progress', '2026-10-20');
  task('super-koordinasyon', 'Super koordinasyon', 'in_progress', '2026-10-22');
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

function nudge(env: Record<string, string>, session = SES): string | null {
  const p = join(projectRoot, 't.jsonl');
  writeFileSync(p, `${JSON.stringify({ message: { usage: { cache_read_input_tokens: 3500 } } })}\n`);
  return maybeNudge(contextRoot, { transcript_path: p, session_id: session }, env as never);
}

describe('the super session\'s handoff nudge', () => {
  it('names `super handoff` and the file, lists live children, and names no task at all', () => {
    const text = nudge({ DREAMCONTEXT_TAB_SESSION: SUPER })!;
    expect(text).toContain('dreamcontext super handoff --done');
    expect(text).toContain('_dream_context/state/.super/handoff.md');
    expect(text).toContain('your handoff file');
    expect(text).toContain('c1, c2');
    expect(text).not.toContain('c3');
    expect(text).not.toContain('tasks handoff');
    expect(text).not.toContain('tasks create');
    expect(text).not.toContain('super-koordinasyon');
  });

  it('a non-super session keeps the newest active task, byte-identical to the plain renderer', () => {
    const text = nudge({ DREAMCONTEXT_TAB_SESSION: 'c2' }, 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee')!;
    expect(text).toContain('dreamcontext tasks handoff super-koordinasyon');
    expect(text).not.toContain('Super Agent');
    expect(text).toBe(renderNudge(3500, resolveContextHandoff({ enabled: true, nudgeAt: 3000, remindEvery: 2000 }), 'super-koordinasyon'));
  });

  it('a taken-back super is not the Super Agent: its nudge is a plain one', () => {
    superRecord(false);
    expect(superHandoffContext(contextRoot, [SUPER])).toBeNull();
    const text = nudge({ DREAMCONTEXT_TAB_SESSION: SUPER })!;
    expect(text).toContain('tasks handoff');
    expect(text).not.toContain('super handoff');
  });

  it('the coordination-task finder is gone', () => {
    expect((handoffTask as Record<string, unknown>).superCoordinationTask).toBeUndefined();
  });

  it('no super record, or another session: not a super context', () => {
    expect(superHandoffContext(contextRoot, ['c1'])).toBeNull();
    expect(superHandoffContext(contextRoot, [SUPER])).toEqual({ children: ['c1', 'c2'] });
    rmSync(join(contextRoot, SUPER_STATE_REL));
    expect(superHandoffContext(contextRoot, [SUPER])).toBeNull();
  });
});
