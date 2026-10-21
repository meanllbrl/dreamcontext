/**
 * In a Super Agent session the context-handoff nudge names the super's OWN coordination task
 * (or says to make one), never a child's task (task super-oturumunda-baglam-devri-kancasi-…).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeNudge } from '../../src/lib/context-watch.js';
import { superCoordinationTask, superHandoffContext } from '../../src/lib/super/handoff-task.js';
import { SUPER_STATE_REL } from '../../src/lib/super/store.js';

const SUPER = '11111111-2222-3333-4444-555555555555';
const SES = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let projectRoot: string;
let contextRoot: string;

const task = (slug: string, name: string, status: string, updated: string) =>
  writeFileSync(join(contextRoot, 'state', `${slug}.md`), `---\nname: '${name}'\nstatus: ${status}\nupdated_at: '${updated}'\ntags: []\n---\n\n## Why\nx\n`);

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-super-handoff-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1', contextHandoff: { enabled: true, nudgeAt: 3000, remindEvery: 2000 } }));
  writeFileSync(join(contextRoot, SUPER_STATE_REL), JSON.stringify({
    session: SUPER, enabled: true,
    children: { c1: { sessionId: 'c1', task: 'odev-ver-akisi' }, c2: { sessionId: 'c2' }, c3: { sessionId: 'c3', endedAt: 5 } },
  }));
  // Three open tasks: a child's (newest), an unrelated one, and the super's own list (oldest).
  task('odev-ver-akisi', 'Ödev Ver akışı', 'in_progress', '2026-10-21');
  task('giris-ekrani-duzeltmesi', 'Giriş ekranı düzeltmesi', 'in_progress', '2026-10-20');
  task('bugunku-acik-isler-21-ekim', 'Bugünkü açık işler 21 Ekim', 'in_progress', '2026-10-19');
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

function nudge(env: Record<string, string>, session = SES): string | null {
  const p = join(projectRoot, 't.jsonl');
  writeFileSync(p, `${JSON.stringify({ message: { usage: { cache_read_input_tokens: 3500 } } })}\n`);
  return maybeNudge(contextRoot, { transcript_path: p, session_id: session }, env as never);
}

describe('the super session\'s handoff nudge', () => {
  it('names the super\'s coordination task, never a child\'s or an unrelated one, and lists its live children', () => {
    const text = nudge({ DREAMCONTEXT_TAB_SESSION: SUPER });
    expect(text).toContain('dreamcontext tasks handoff bugunku-acik-isler-21-ekim');
    expect(text).not.toContain('tasks handoff odev-ver-akisi');
    expect(text).not.toContain('tasks handoff giris-ekrani-duzeltmesi');
    expect(text).toContain('You are the Super Agent');
    expect(text).toContain('c1, c2');
    expect(text).not.toContain('c3');
  });

  it('with no coordination task it says to make one, and still names no child task', () => {
    rmSync(join(contextRoot, 'state', 'bugunku-acik-isler-21-ekim.md'));
    const text = nudge({ DREAMCONTEXT_TAB_SESSION: SUPER });
    expect(text).toContain('tasks handoff <task-slug>');
    expect(text).toContain('tasks create "Super koordinasyon"');
    expect(text).not.toContain('tasks handoff odev-ver-akisi');
  });

  it('a non-super session keeps the newest active task', () => {
    const text = nudge({ DREAMCONTEXT_TAB_SESSION: 'c2' }, 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(text).toContain('dreamcontext tasks handoff odev-ver-akisi');
    expect(text).not.toContain('Super Agent');
  });

  it('a child\'s task is never the coordination task, even when its name reads like one', () => {
    task('super-koordinasyon', 'Super koordinasyon', 'in_progress', '2026-10-22');
    expect(superCoordinationTask(contextRoot, new Set(['super-koordinasyon']))?.slug).toBe('bugunku-acik-isler-21-ekim');
    expect(superCoordinationTask(contextRoot)?.slug).toBe('super-koordinasyon');
  });

  it('no super record, or another session: not a super context', () => {
    expect(superHandoffContext(contextRoot, ['c1'])).toBeNull();
    rmSync(join(contextRoot, SUPER_STATE_REL));
    expect(superHandoffContext(contextRoot, [SUPER])).toBeNull();
  });
});
