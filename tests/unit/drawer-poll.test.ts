/**
 * The drawer's fan-out (task codex-tarzi-yeni-kabuk W2-A, D7): it reads only expanded projects
 * this window has not mounted, polls only while the drawer is visible and the window focused,
 * at most eight of them, and never asks for a roster body (`?summary=1`, no drafts).
 * Plus the server half: `GET /agent/sessions?summary=1` answers counts and nothing else.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const asked: Array<[string | null, string]> = [];
vi.mock('../../dashboard/src/api/client.js', () => ({
  ApiClient: class {
    constructor(private vault: string | null) {}
    async get(path: string) {
      asked.push([this.vault, path]);
      if (path.startsWith('/agent/sessions')) return { windows: 1, tabs: 4, superOn: true };
      if (path === '/agents') return { agents: [{ slug: 'digest', title: 'Digest', hasPhoto: false, roleLine: '', description: '', approvedForChat: true, approvedToRun: true }] };
      if (path === '/automations') return { automations: [] };
      return { messages: [], unreadBySlug: {}, runSlots: {}, working: { digest: { since: 1 } } };
    }
  },
}));

const { fanoutTargets, DRAWER_POLL_CAP } = await import('../../dashboard/src/components/layout/newshell/drawerModel.js');
const { readFanoutFacts } = await import('../../dashboard/src/hooks/useDrawerProjects.js');

describe('which projects the drawer polls', () => {
  it('only expanded projects that are not mounted', () => {
    expect(fanoutTargets(['a', 'b', 'c'], ['b'], true)).toEqual({ poll: ['a', 'c'], once: [] });
  });

  it('nothing polls while the drawer is hidden or the window unfocused: a read once instead', () => {
    expect(fanoutTargets(['a', 'c'], [], false)).toEqual({ poll: [], once: ['a', 'c'] });
  });

  it('at most eight poll; the rest are read once', () => {
    const many = Array.from({ length: 11 }, (_, i) => `p${i}`);
    const t = fanoutTargets(many, [], true);
    expect(DRAWER_POLL_CAP).toBe(8);
    expect(t.poll).toHaveLength(8);
    expect(t.once).toEqual(['p8', 'p9', 'p10']);
  });
});

describe('a far project\'s facts', () => {
  it('come from that project\'s own client, the summary roster and the team inputs', async () => {
    asked.length = 0;
    const f = await readFanoutFacts('globex');
    expect(f).toEqual({ tabs: 4, superOn: true, superMarks: { working: 0, asking: false }, team: [{ slug: 'digest', title: 'Digest', hasPhoto: false, status: 'working' }] });
    expect(asked.every(([v]) => v === 'globex')).toBe(true);
    expect(asked.map(([, p]) => p).sort()).toEqual(['/agent/sessions?summary=1', '/agents', '/automations', '/automations/threads']);
  });
});

describe('GET /agent/sessions?summary=1', () => {
  it('answers the window and tab counts and the Super flag, never titles or drafts', async () => {
    const { handleAgentSessionsGet } = await import('../../src/server/routes/agent-sessions.js');
    const realDesktop = process.env.DREAMCONTEXT_DESKTOP;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    // A registered prefix (super-disk-leftovers): `super clean` may remove what a test leaves.
    const home = mkdtempSync(join(tmpdir(), 'hf-roster-gen-'));
    const root = join(home, 'proj', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', '.agent-sessions.json'), JSON.stringify({
      sessions: [
        { id: 's1', title: 'Secret plan', kind: 'chat', bypass: false, sessionId: '11111111-1111-4111-8111-111111111111' },
        { id: 's2', title: 'Other', kind: 'agent', bypass: false },
      ],
      drafts: { s1: 'a private draft' },
    }));
    let status = 0;
    let body = '';
    const res = { setHeader() {}, writeHead(s: number) { status = s; }, end(b?: string) { body = b ?? ''; } } as any;
    try {
      await handleAgentSessionsGet({ url: '/api/agent/sessions?summary=1' } as any, res, {}, root, home);
    } finally {
      if (realDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
      else process.env.DREAMCONTEXT_DESKTOP = realDesktop;
      rmSync(home, { recursive: true, force: true });
    }
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // plan-r10 1: each AI Team member's owner-facing facts ride along; this project has none.
    expect(json).toEqual({ windows: 1, tabs: 2, superOn: false, superWorking: 0, superAsking: false, perWindow: [{ id: 'main', name: 'Chat', tabs: 2 }], members: [] });
    expect(body).not.toContain('Secret plan');
    expect(body).not.toContain('private draft');
  });
});
