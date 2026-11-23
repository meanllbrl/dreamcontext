import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { orphanCopies, reapOrphanCopies } from '../../src/server/orphan-chats.js';
import { parseProcTable } from '../../src/lib/orphan-processes.js';

const SID = '120b32cb-4a92-420e-82fd-364656a99687';
const OTHER = '06802bc7-e950-4225-bd1d-a2e0ebf41d90';
const chat = (flag: string, id: string) => `claude -p --input-format stream-json --output-format stream-json --verbose ${flag} ${id} --agents x`;

// The real `ps -axww -o uid=,pid=,ppid=,pgid=,lstart=,args=` shape (lstart padded); ids fictional.
const UID = 501;
const row = (uid: number, pid: number, ppid: number, args: string) => `  ${uid} ${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${String(pid).padStart(6)} Sun Nov 22 20:51:20 2026     ${args}`;
const TABLE = [
  row(UID, 18106, 1, chat('--session-id', SID)),
  row(UID, 54487, 30973, chat('--resume', SID)), // the server's live copy: never touched
  row(UID, 5880, 1, chat('--session-id', OTHER)), // another conversation's orphan: never touched
  row(UID, 7001, 1, `claude --resume ${SID}`), // not stream-json: an owner's own claude
  row(UID, 7002, 1, `/usr/local/bin/claude -p --input-format stream-json --resume ${SID}`),
  row(UID, 7003, 1, `grep --resume ${SID} stream-json`),
  row(502, 7004, 1, chat('--resume', SID)), // another user's
].join('\n');
const rows = () => parseProcTable(TABLE)!.values();

describe('orphanCopies', () => {
  it('finds only ppid-1 headless claude copies of the asked conversation', () => {
    expect(orphanCopies(rows(), [SID], UID)).toEqual([18106, 7002]);
  });
  it('an empty id never matches', () => {
    expect(orphanCopies(rows(), ['', ''], UID)).toEqual([]);
  });
  it('a token prefix is not a match', () => {
    expect(orphanCopies(rows(), [SID.slice(0, 8)], UID)).toEqual([]);
  });
  it('never returns the calling process', () => {
    expect(orphanCopies(rows(), [SID], UID, 18106)).toEqual([7002]);
  });
});

describe('reapOrphanCopies', () => {
  it('fails open when ps fails or its table does not parse', async () => {
    expect(await reapOrphanCopies([SID], { platform: 'darwin', runPs: async () => 'garbage line', uid: UID, cut: async () => { throw new Error('must not cut'); } })).toEqual([]);
  });
  it('fails open when the process table cannot be read', async () => {
    let cut = false;
    const r = await reapOrphanCopies([SID], { platform: 'darwin', runPs: async () => { throw new Error('ps failed'); }, cut: async () => { cut = true; } });
    expect(r).toEqual([]);
    expect(cut).toBe(false);
  });
  it('is a no-op on win32 and with no ids', async () => {
    const runPs = async () => TABLE;
    expect(await reapOrphanCopies([SID], { platform: 'win32', runPs, uid: UID, cut: async () => {} })).toEqual([]);
    expect(await reapOrphanCopies(['', ''], { platform: 'darwin', runPs, uid: UID, cut: async () => {} })).toEqual([]);
  });
  it('cuts exactly the orphaned copies', async () => {
    const cuts: number[][] = [];
    const r = await reapOrphanCopies([SID, ''], { platform: 'darwin', runPs: async () => TABLE, uid: UID, cut: async (p) => { cuts.push(p); }, log: () => {} });
    expect(r).toEqual([18106, 7002]);
    expect(cuts).toEqual([[18106, 7002]]);
  });

  it.skipIf(process.platform === 'win32')('ends a real process group end to end (default cut)', async () => {
    // A real group leader with a child of its own, standing in for an orphaned `claude` and its tools.
    const leader = spawn('/bin/sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' });
    leader.unref();
    const pid = leader.pid!;
    await new Promise((r) => setTimeout(r, 150));
    const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
    const groupAlive = () => { try { process.kill(-pid, 0); return true; } catch { return false; } };
    expect(alive(pid)).toBe(true);
    const runPs = async () => row(UID, pid, 1, chat('--resume', SID));
    try {
      const r = await reapOrphanCopies([SID], { platform: 'darwin', runPs, uid: UID, log: () => {} });
      expect(r).toEqual([pid]);
      // Give the exit a moment to be reaped by the test process.
      for (let i = 0; i < 40 && groupAlive(); i++) await new Promise((res) => setTimeout(res, 50));
      expect(groupAlive()).toBe(false);
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 15_000);
});
