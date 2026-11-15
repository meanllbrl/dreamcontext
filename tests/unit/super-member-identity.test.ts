/**
 * Task ajanda-gunluk C4, criterion 11: a member's agenda days follow its record. A new member
 * taking an old name moves the earlier member's days to the same trash folder as its record and
 * read marks, a folder left without its record too. Fictional project (synthetic fixtures).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent, removeAgent } from '../../src/lib/agents/store.js';
import { settleMemberIdentity } from '../../src/lib/super/member-identity.js';
import { resetSuperIndex, superAgendaDaysDir, superRecordPath } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';

let dir: string;
let home: string;
let root: string;
const NOW = new Date('2026-11-14T09:00:00.000Z');

beforeEach(() => {
  resetSuperIndex();
  dir = mkdtempSync(join(tmpdir(), 'member-identity-days-'));
  home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'automations'), { recursive: true });
  mkdirSync(join(root, 'state', '.super', 'members'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function days(): void {
  mkdirSync(superAgendaDaysDir(root, 'm:writer'), { recursive: true });
  writeFileSync(join(superAgendaDaysDir(root, 'm:writer'), '2026-11-13.json'), JSON.stringify({ v: 1, day: '2026-11-13', lines: [] }));
}
async function takeOver(): Promise<string | null> {
  createAgent(root, { slug: 'writer', title: 'Writer', prompt: 'Write.' }, { approve: { now: NOW } });
  await settleMemberIdentity(root, 'writer', { home, now: NOW });
  removeAgent(root, 'writer');
  createAgent(root, { slug: 'writer', title: 'Writer again', prompt: 'Write more.' }, { approve: { now: NOW } });
  return (await settleMemberIdentity(root, 'writer', { home, now: NOW })).archived;
}

describe('a new member taking an old name', () => {
  it('moves the days folder to the same trash folder as the record', async () => {
    writeFileSync(superRecordPath(root, 'm:writer'), JSON.stringify({ ...emptySuperState(), member: 'writer' }));
    days();
    const archived = await takeOver();
    expect(archived).not.toBeNull();
    expect(existsSync(superAgendaDaysDir(root, 'm:writer'))).toBe(false);
    const trash = join(dir, 'acme', archived!);
    expect(readdirSync(trash)).toEqual(expect.arrayContaining(['writer.json', 'writer.agenda-days']));
    expect(existsSync(join(trash, 'writer.agenda-days', '2026-11-13.json'))).toBe(true);
  });

  it('a days folder left without its record moves too', async () => {
    days();
    const archived = await takeOver();
    expect(archived).not.toBeNull();
    expect(existsSync(superAgendaDaysDir(root, 'm:writer'))).toBe(false);
  });
});
