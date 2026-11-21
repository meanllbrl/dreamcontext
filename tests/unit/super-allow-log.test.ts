/**
 * Plan super-v3 K5 (D8): a child's allow log. Each entry is the redacted one-line command (or a
 * tool and its target, never content), capped at 300 chars; the log is bounded by stored bytes
 * (64 KB, oldest dropped), not by count; it is gone once the child ends; it never travels in the
 * remote view; the window's line says "inside this job's own folder" only when EVERY logged
 * command stayed there. Fictional project "acme".
 */
import { describe, it, expect } from 'vitest';
import { allowEntry, allowsLine, appendAllow } from '../../src/lib/super/allow-log.js';
import { sanitizeSuperState } from '../../src/lib/super/store.js';
import { MAX_ALLOWS_BYTES, MAX_ALLOW_SUMMARY, emptySuperState, type SuperChild } from '../../src/lib/super/types.js';
import { superRemoteView } from '../../src/lib/super/remote-view.js';

const KID = '32345678-1234-4234-8234-123456789abc';
const WT = '/Users/someone/.claude-worktrees/acme-pricing';
const child = (over: Partial<SuperChild> = {}): SuperChild => ({ sessionId: KID, brief: 'Acme pricing page', adopted: false, startedAt: 1, ...over });

describe('one entry', () => {
  it('a shell command is one line, redacted and capped', () => {
    const e = allowEntry('Bash', 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"\n  https://acme.example/api', WT, 10);
    expect(e.summary).not.toContain('\n');
    expect(e.summary).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(e.at).toBe(10);
    expect(e.inFolder).toBeUndefined();
    expect(allowEntry('Bash', 'x'.repeat(2000), WT, 1).summary.length).toBe(MAX_ALLOW_SUMMARY);
  });

  it('a file tool is its name and target; inFolder only inside the job\'s own worktree', () => {
    expect(allowEntry('Edit', `${WT}/src/price.ts`, WT, 1)).toEqual({ at: 1, summary: `Edit ${WT}/src/price.ts`, inFolder: true });
    expect(allowEntry('Edit', `${WT}/../other/x.ts`, WT, 1).inFolder).toBeUndefined();
    expect(allowEntry('Write', '/etc/hosts', WT, 1).inFolder).toBeUndefined();
    expect(allowEntry('Edit', `${WT}/a.ts`, undefined, 1).inFolder).toBeUndefined();
  });
});

describe('the log', () => {
  it('is bounded by bytes, oldest dropped, never by count', () => {
    const ch = child();
    for (let i = 0; i < 400; i++) appendAllow(ch, { at: i, summary: `npm run step-${i} ${'y'.repeat(250)}` });
    const bytes = Buffer.byteLength(JSON.stringify(ch.allows), 'utf8');
    expect(bytes).toBeLessThanOrEqual(MAX_ALLOWS_BYTES + 400);
    expect(ch.allows!.at(-1)!.at).toBe(399);
    expect(ch.allows![0].at).toBeGreaterThan(0);
    // Small entries: many more than any count cap would keep.
    const small = child();
    for (let i = 0; i < 1500; i++) appendAllow(small, { at: i, summary: 'ls' });
    expect(small.allows).toHaveLength(1500);
  });

  it('survives a read while the child may run, and is gone once it ended', () => {
    const allows = [{ at: 5, summary: 'npm test' }, { at: 6, summary: 'bad', extra: 1 }, { at: 'x', summary: 'no' }];
    const live = sanitizeSuperState({ ...emptySuperState(), session: 'sup', children: { [KID]: child({ allows: allows as never }) } });
    expect(live.children[KID].allows).toEqual([{ at: 5, summary: 'npm test' }, { at: 6, summary: 'bad' }]);
    const ended = sanitizeSuperState({ ...emptySuperState(), session: 'sup', children: { [KID]: child({ allows: allows as never, endedAt: 9 }) } });
    expect(ended.children[KID].allows).toBeUndefined();
  });

  it('never travels in the remote view', () => {
    const s = { ...emptySuperState(), session: 'sup', enabled: true, children: { [KID]: child({ allows: [{ at: 5, summary: 'npm test' }] }) } };
    expect(JSON.stringify(superRemoteView(s, 'acme', null, false, {}))).not.toContain('npm test');
  });
});

describe('the window\'s line', () => {
  it('says "inside this job\'s own folder" only when every command stayed there', () => {
    const inside = { at: 1, summary: `Edit ${WT}/a.ts`, inFolder: true };
    const shell = { at: 2, summary: 'npm test' };
    expect(allowsLine([inside])).toBe('Claude allowed 1 command inside this job\'s own folder');
    expect(allowsLine([inside, inside])).toBe('Claude allowed 2 commands inside this job\'s own folder');
    expect(allowsLine([inside, shell])).toBe('Claude allowed 2 commands');
    expect(allowsLine([shell])).not.toContain('folder');
    expect(allowsLine([])).toBeNull();
    expect(allowsLine(undefined)).toBeNull();
  });
});
