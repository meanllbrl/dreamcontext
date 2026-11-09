/**
 * A bound bot carries its member's identity (identity.ts): name = the title as the app shows it,
 * a role line, the member's photo as a JPG; idempotent through identity.json; a refusal never
 * throws and leaves a one-line issue; the prompt never leaves the Mac.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTelegram } from '../helpers/fake-telegram.js';
import { TelegramTransport } from '../../src/lib/telegram/transport.js';
import { clip, displayNameFor, identityFor, identityIssue, syncBotIdentity, TG_NAME_MAX } from '../../src/server/telegram/identity.js';

const TOKEN = '333333:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
let home: string; let root: string; let tg: FakeTelegram; let transport: TelegramTransport;
let converted: string[];
const toJpeg = async (src: Buffer) => { converted.push(src.toString('hex')); return JPG; };
const bot = () => ({ scope: 'abcdef0123456789', target: 'galileo', botId: 333333, transport, contextRoot: root, projectName: 'acme' });

function member(title: string, photo?: string): void {
  writeFileSync(join(root, 'agents', 'galileo.md'),
    `---\ntitle: ${title}\n${photo ? `photo: ${photo}\n` : ''}---\n## Prompt\n\nSECRET-PROMPT watch the rivals.\n`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-id-home-'));
  root = join(mkdtempSync(join(tmpdir(), 'tg-id-proj-')), '_dream_context');
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'automations', 'photos'), { recursive: true });
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'galileo_bot');
  transport = new TelegramTransport({ token: TOKEN, fetchImpl: tg.fetch });
  converted = [];
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(join(root, '..'), { recursive: true, force: true }); });

describe('identityFor / clip', () => {
  it('a member takes its title; the role after · is the short line; the prompt never appears', () => {
    member('Galileo · Rakip gözcüsü');
    const id = identityFor(bot(), home)!;
    expect(id.name).toBe('Galileo · Rakip gözcüsü');
    expect(id.shortDescription).toBe('Rakip gözcüsü · acme projesinin AI Team üyesi.');
    expect(JSON.stringify(id)).not.toContain('SECRET-PROMPT');
    expect(displayNameFor({ ...bot(), target: 'nobody' }, home)).toBe('nobody');
  });

  it('the Super keeps "Super · <project>"', () => {
    expect(identityFor({ ...bot(), target: 'super' }, home)!.name).toBe('Super · acme');
  });

  it('a long title is cut cleanly at a word, within Telegram\'s 64', () => {
    const long = `Galileo · ${'çokuzunrol '.repeat(10)}`;
    const out = clip(long, TG_NAME_MAX);
    expect([...out].length).toBeLessThanOrEqual(TG_NAME_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });
});

describe('syncBotIdentity', () => {
  it('sets name, lines and a converted photo once; a second run calls nothing', async () => {
    member('Galileo · Rakip gözcüsü', 'automations/photos/galileo.png');
    writeFileSync(join(root, 'automations', 'photos', 'galileo.png'), PNG);
    expect(await syncBotIdentity(bot(), home, toJpeg)).toBeUndefined();
    expect(tg.sent('setMyName').map((c) => c.params.name)).toEqual(['Galileo · Rakip gözcüsü']);
    expect(tg.sent('setMyDescription')).toHaveLength(1);
    expect(converted).toEqual([PNG.toString('hex')]);
    const photo = tg.sent('setMyProfilePhoto');
    expect(photo).toHaveLength(1);
    expect(JSON.parse(String(photo[0].params.photo))).toEqual({ type: 'static', photo: 'attach://avatar' });
    expect(photo[0].params.avatar).toBe('[file]');
    const n = tg.calls.length;
    await syncBotIdentity(bot(), home, toJpeg);
    expect(tg.calls.length).toBe(n);
  });

  it('a JPG goes as is; a changed photo is uploaded again; a removed one is taken off', async () => {
    member('Galileo', 'automations/photos/galileo.jpg');
    writeFileSync(join(root, 'automations', 'photos', 'galileo.jpg'), JPG);
    await syncBotIdentity(bot(), home, toJpeg);
    expect(converted).toHaveLength(0);
    writeFileSync(join(root, 'automations', 'photos', 'galileo.jpg'), Buffer.concat([JPG, Buffer.from([7])]));
    await syncBotIdentity(bot(), home, toJpeg);
    expect(tg.sent('setMyProfilePhoto')).toHaveLength(2);
    unlinkSync(join(root, 'automations', 'photos', 'galileo.jpg'));
    member('Galileo');
    await syncBotIdentity(bot(), home, toJpeg);
    expect(tg.sent('removeMyProfilePhoto')).toHaveLength(1);
    expect(tg.sent('setMyName')).toHaveLength(1);
  });

  it('a photo set by hand is never removed: no photo of ours, no remove call', async () => {
    member('Galileo');
    await syncBotIdentity(bot(), home, toJpeg);
    expect(tg.sent('removeMyProfilePhoto')).toHaveLength(0);
  });

  it('a refusal never throws: the issue is kept for the row and the call is retried next time', async () => {
    member('Galileo · Rakip gözcüsü', 'automations/photos/galileo.png');
    writeFileSync(join(root, 'automations', 'photos', 'galileo.png'), PNG);
    tg.failing.set('setMyName', 429);
    expect(await syncBotIdentity(bot(), home, toJpeg)).toBe('name');
    expect(identityIssue('abcdef0123456789', 'galileo', 333333, home)).toBe('name');
    expect(tg.sent('setMyProfilePhoto')).toHaveLength(1);
    tg.failing.delete('setMyName');
    expect(await syncBotIdentity(bot(), home, toJpeg)).toBeUndefined();
    expect(tg.sent('setMyName')).toHaveLength(2);
    expect(identityIssue('abcdef0123456789', 'galileo', 333333, home)).toBeUndefined();
  });

  it('a photo that cannot become a JPG is an issue, not a crash', async () => {
    member('Galileo', 'automations/photos/galileo.png');
    writeFileSync(join(root, 'automations', 'photos', 'galileo.png'), PNG);
    expect(await syncBotIdentity(bot(), home, async () => null)).toBe('photo');
    expect(tg.sent('setMyProfilePhoto')).toHaveLength(0);
  });

  it('a project bot whose project is not found takes nothing (never a global agent of that slug)', async () => {
    member('Galileo');
    expect(identityFor({ ...bot(), contextRoot: null }, home)).toBeNull();
    expect(await syncBotIdentity({ ...bot(), contextRoot: null }, home, toJpeg)).toBeUndefined();
    expect(tg.calls).toHaveLength(0);
  });

  it('a binding removed meanwhile gets no photo and no state written', async () => {
    member('Galileo', 'automations/photos/galileo.png');
    writeFileSync(join(root, 'automations', 'photos', 'galileo.png'), PNG);
    let alive = true;
    const slowJpeg = async (b: Buffer) => { alive = false; return toJpeg(b); };
    await syncBotIdentity(bot(), home, slowJpeg, () => alive);
    expect(tg.sent('setMyProfilePhoto')).toHaveLength(0);
    expect(identityIssue('abcdef0123456789', 'galileo', 333333, home)).toBeUndefined();
    expect(existsSync(join(home, '.dreamcontext'))).toBe(false);
  });

  it('another bot on the same binding starts fresh (state is keyed by bot id)', async () => {
    member('Galileo');
    await syncBotIdentity(bot(), home, toJpeg);
    await syncBotIdentity({ ...bot(), botId: 444444 }, home, toJpeg);
    expect(tg.sent('setMyName')).toHaveLength(2);
  });
});
