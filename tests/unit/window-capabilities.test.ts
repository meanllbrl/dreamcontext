import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { vaultWindowLabel } from '../../dashboard/src/lib/desktop.js';
import { checklistWindowLabel } from '../../dashboard/src/lib/checklistStore.js';

/**
 * EVERY WINDOW THE APP CAN OPEN MUST BE COVERED BY A TAURI CAPABILITY.
 *
 * Tauri v2 scopes permissions by window LABEL: a capability lists `windows`
 * globs, and a window whose label matches none of them gets NOTHING. There is no
 * error, no console line and no crash — the window simply opens, and then every
 * `core:*` call it makes is denied.
 *
 * That is not hypothetical. The Meeting Room shipped in 0.26.1 with the label
 * `meeting-room`, while `default` scoped to the launcher, vault and sleepy
 * windows and `checklist` to the checklist ones. It matched neither. The symptom
 * anyone could see was that its title bar refused to drag — `startDragging()` was
 * ACL-denied and the rejection was swallowed by a bare catch. A human found it by
 * trying to move a window; 8,000 passing tests had nothing to say about it.
 *
 * So this test asserts the thing that was actually missing: the join between the
 * labels the FRONTEND mints and the globs the CAPABILITIES grant.
 */

const CAP_DIR = join(__dirname, '../../desktop/src-tauri/capabilities');

/** One representative label per KIND of window the app can create. */
const LABELS: Record<string, string> = {
  // The persistent launcher, created by Rust at startup.
  launcher: 'main',
  // One per open project.
  vault: vaultWindowLabel('acme-storefront'),
  // A vault name that needs sanitising still has to land inside `vault-*`.
  'vault (sanitised)': vaultWindowLabel('weird name.with/chars'),
  checklist: checklistWindowLabel('acme-storefront', 'asc-key'),
  meetingRoom: 'meeting-room',
  sleepy: 'sleepy',
  sleepyPerch: 'sleepy-perch',
};

/** Tauri capability `windows` entries are globs with `*` as the only wildcard. */
function globMatches(glob: string, label: string): boolean {
  const rx = new RegExp(
    `^${glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
  );
  return rx.test(label);
}

interface Capability {
  identifier?: unknown;
  windows?: unknown;
  permissions?: unknown;
}

function readCapabilities(): { file: string; cap: Capability }[] {
  if (!existsSync(CAP_DIR)) return [];
  return readdirSync(CAP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, cap: JSON.parse(readFileSync(join(CAP_DIR, f), 'utf8')) as Capability }));
}

describe('tauri window capabilities', () => {
  const caps = readCapabilities();

  it('has capability files to check', () => {
    // A consumer checkout with no desktop/ shell would make every assertion below
    // vacuously true, which is exactly the failure mode this whole file exists to
    // prevent. Fail loudly instead.
    expect(existsSync(CAP_DIR), `${CAP_DIR} is missing`).toBe(true);
    expect(caps.length).toBeGreaterThan(0);
  });

  const globs = caps.flatMap(({ file, cap }) =>
    (Array.isArray(cap.windows) ? (cap.windows as string[]) : []).map((g) => ({ file, glob: g })),
  );

  it.each(Object.entries(LABELS))(
    'the %s window (%s) is covered by a capability',
    (_kind, label) => {
      const hit = globs.filter((g) => globMatches(g.glob, label));
      expect(
        hit.map((h) => `${h.file}:${h.glob}`),
        `window label "${label}" matches NO capability — it would open with zero permissions`,
      ).not.toEqual([]);
    },
  );

  /**
   * A source tripwire, because the list above is hand-maintained and the whole
   * point is to catch the window somebody adds LATER. Every `new WebviewWindow(`
   * in the frontend is one kind of window; if that count moves, this list has to
   * be revisited rather than silently left behind.
   */
  it('has a representative label for every window the frontend creates', () => {
    const src = readFileSync(join(__dirname, '../../dashboard/src/lib/desktop.ts'), 'utf8');
    const created = (src.match(/new WebviewWindow\(/g) ?? []).length;
    expect(
      created,
      'desktop.ts creates a different number of window kinds than this test knows about — ' +
        'add the new label to LABELS above and give it a capability in desktop/src-tauri/capabilities/',
    ).toBe(4); // vault, checklist, meeting-room, main(re-open)
  });

  it('grants the Meeting Room the drag permission its title bar needs', () => {
    // The specific regression: the room's own title bar is the only way to move a
    // window created with `dragDropEnabled: false`, and that needs start-dragging.
    const forRoom = caps.filter(({ cap }) =>
      (Array.isArray(cap.windows) ? (cap.windows as string[]) : []).some((g) =>
        globMatches(g, 'meeting-room'),
      ),
    );
    const perms = forRoom.flatMap(({ cap }) =>
      (Array.isArray(cap.permissions) ? cap.permissions : []).filter(
        (p): p is string => typeof p === 'string',
      ),
    );
    expect(perms).toContain('core:window:allow-start-dragging');
  });
});
