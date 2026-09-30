/**
 * DRIFT: every link the Node writer (`src/lib/app-link.ts`) produces must parse, to the same
 * target, in the dashboard reader (`dashboard/src/lib/appLink.ts`), and the dashboard's own
 * writer must agree with Node's byte for byte. Validation is duplicated on purpose; this is the
 * test that keeps the two copies saying the same thing.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildAppLink as nodeBuild, type AppLinkTarget } from '../../src/lib/app-link.js';

vi.mock('../../dashboard/src/lib/desktop', () => ({
  isDesktop: () => false,
  openInboxWindow: vi.fn(), openVaultWindow: vi.fn(), openViewerWindow: vi.fn(),
  vaultWindowLabel: (v: string) => `vault-${v}`,
}));
vi.mock('../../dashboard/src/lib/windowRegistry', () => ({ thisWindowLabel: async () => '', resolveLiveWindowForVault: async () => null }));
const { parseAppLink, buildAppLink: dashBuild } = await import('../../dashboard/src/lib/appLink');

const TR = 'Çalışma Öğrenim şğü İı';
const targets: AppLinkTarget[] = [
  { kind: 'inbox' },
  { kind: 'project', vault: TR },
  { kind: 'project', vault: 'my vault (2)' },
  { kind: 'session', vault: TR, claudeId: '0b1d3c97-6daf-4943-96d5-8614e7d0960e' },
  { kind: 'automation', vault: TR, slug: 'daily-brief' },
  { kind: 'automation', vault: TR, slug: 'daily-brief', file: 'automations/output/daily brief/2026-09-29 +ö&=.md' },
  { kind: 'page', vault: TR, page: 'sleep' },
  { kind: 'page', vault: TR, page: 'tasks', id: 'fix-the-login' },
  { kind: 'page', vault: TR, page: 'core', id: '0.soul.md' },
  { kind: 'view', vault: TR, path: '_dream_context/knowledge/grafik ö?x.md' },
];

/** The Node target as the dashboard reader returns it (optional fields made explicit). */
function expected(t: AppLinkTarget): unknown {
  if (t.kind === 'automation') return { ...t, file: t.file ?? null };
  if (t.kind === 'page') return { ...t, id: t.id ?? null };
  return t;
}

describe('Node writer ↔ dashboard reader', () => {
  for (const t of targets) {
    it(`${t.kind} ${JSON.stringify(t).slice(0, 80)}`, () => {
      const raw = nodeBuild(t);
      expect(parseAppLink(raw)).toEqual(expected(t));
      expect(dashBuild(expected(t) as never)).toBe(raw);
    });
  }
});
