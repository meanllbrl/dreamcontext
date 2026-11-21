/**
 * The member-carry exam (Doc, `sinav-seti.md`, 21 Nov): does a correction said once to a global
 * AI Team member reach that member's next turn in EVERY project, and nowhere else?
 *
 * 16 cases. Must arrive: E1-E12, K1 (the rule id is on the surface probed). Must not leak: N1, N2,
 * U1 (it is not). Delivery only (text present or absent), no model. The built CLI is spawned with a
 * fake HOME and a clean env, as Doc's `replay.sh` does; B (the member chat briefing) is built in
 * process from the same files.
 *
 * Cases waiting for W2 (his words relayed to the member, the member amending its own instruction)
 * are `todo(W2)` until their lane lands; `MEMBER_CARRY_ALL=1` runs every case (the baseline).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  crewEnv, dc, learnedId, learnedStatus, makeWorld, memberEnv, newSid, ownerSays, plainEnv,
  sessionStart, surfaceC, surfaceF, surfaceS, surfaceT, type World,
} from '../helpers/member-carry-world.js';
import { prepareAgentChat } from '../../src/lib/whiteboards/card-chat.js';

const ALL = process.env.MEMBER_CARRY_ALL === '1';
const W2_TODO = new Set<string>(['E4', 'E10', 'E12']);
const exam = (id: string, title: string, fn: () => void): void => {
  if (!ALL && W2_TODO.has(id)) it.todo(`${id} ${title} (W2)`);
  else it(`${id} ${title}`, fn, 120_000);
};

let w: World;
let prevHome: string | undefined;

/** B: the member's chat briefing in a project, as the server spawns it. */
function surfaceB(project: string, slug: string): string {
  const prep = prepareAgentChat(w.context(project), slug, w.home);
  return prep.ok ? prep.briefing : `NOT OK: ${prep.reason}`;
}

/** The part of B that tells it who it is (its approved prompt). */
function whoYouAre(b: string): string {
  const s = b.indexOf('--- WHO YOU ARE');
  const e = b.indexOf('--- END WHO YOU ARE');
  return s >= 0 && e > s ? b.slice(s, e) : '';
}

/** The pattern (lessons) block of B, framed as observations. */
function patternBlock(b: string): string {
  const s = b.indexOf('--- YOUR PATTERN');
  const e = b.indexOf('--- END PATTERN');
  return s >= 0 && e > s ? b.slice(s, e) : '';
}

/** B without its pattern block: what B carries as an instruction or a rule. */
function bAsInstruction(b: string): string {
  const p = patternBlock(b);
  return p ? b.replace(p, '') : b;
}

/** Mira's own chat in a project writes a rule from his words in that chat. */
function miraLearns(project: string, rule: string, quote: string, extra: string[] = []): { id: string | null; status: string | null; out: string; sid: string } {
  const sid = newSid(`mira-${project}`);
  ownerSays(w, quote, [sid], { vault: w.project(project), surface: 'member' });
  const r = dc(w, w.project(project), ['learn', rule, '--scope', 'member', '--quote', quote, ...extra], memberEnv('mira', sid));
  return { id: learnedId(r), status: learnedStatus(r), out: `${r.out}\n${r.err}`, sid };
}

beforeAll(() => {
  w = makeWorld();
  prevHome = process.env.HOME;
  process.env.HOME = w.home;
}, 180_000);

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  w?.dispose();
});

describe('member-carry exam', () => {
  // ── must arrive ────────────────────────────────────────────────────────────

  exam('E1', 'a correction in kestrel reaches Mira in lumen (S, T)', () => {
    // At 0.41.23 the agent wrote `--scope project` (one project). The fix: in a member session the
    // directive says `--scope member` and `--member` defaults to the session's member (D11).
    const b = surfaceB('kestrel', 'mira');
    expect(b, 'the member is told a correction of how it works is --scope member').toMatch(/--scope member/);
    const r = miraLearns('kestrel', 'Fiyat ekranında gövde en çok iki satır', 'ekranlar çok yazı dolu, gövde iki satırı geçmesin');
    expect(r.id, r.out).not.toBeNull();
    expect(r.status, r.out).toBe('active');
    const sid = newSid('mira-lumen');
    expect(surfaceS(w, 'lumen', memberEnv('mira', sid))).toContain(r.id!);
    expect(surfaceT(w, 'lumen', memberEnv('mira', sid))).toContain(r.id!);
  });

  exam('E2', 'scope member from a project Super reaches lumen S, T and B as an instruction', () => {
    const sup = newSid('super-kestrel');
    const quote = 'her turda baştan sona yürüme, sadece değişen ekrana bak';
    ownerSays(w, quote, [sup], { vault: w.project('kestrel'), surface: 'super' });
    const r = dc(w, w.project('kestrel'), ['learn', 'Tur içinde yalnız değişen ekranları aç, uçtan uca yürüme', '--scope', 'member', '--member', 'mira', '--quote', quote], plainEnv(sup));
    const id = learnedId(r);
    expect(id, `${r.out}\n${r.err}`).not.toBeNull();
    expect(learnedStatus(r)).toBe('active');
    expect(`${r.out}`).toMatch(/Kaydedildi: .*Mira'nın kuralı, her projede · yanlışsa geri al de|mira'nın kuralı, her projede · yanlışsa geri al de/);
    const sid = newSid('mira-lumen');
    expect(surfaceS(w, 'lumen', memberEnv('mira', sid))).toContain(id!);
    expect(surfaceT(w, 'lumen', memberEnv('mira', sid))).toContain(id!);
    expect(bAsInstruction(surfaceB('lumen', 'mira'))).toContain(id!);
  });

  exam('E3', 'after 21 more lessons the correction is still in B and T, and no lesson is lost', () => {
    const r = miraLearns('kestrel', 'Önce mevcut funnel verisini oku, sonra öner', 'önce verine bak, sonra öner');
    expect(r.id, r.out).not.toBeNull();
    for (let i = 1; i <= 21; i++) {
      const l = dc(w, w.project('kestrel'), ['automations', 'learn', 'mira', '--lesson', `Ders ${String(i).padStart(2, '0')}: kurgusal çalışma notu ${i}`]);
      expect(l.code, l.err).toBe(0);
    }
    const b = surfaceB('lumen', 'mira');
    expect(bAsInstruction(b)).toContain(r.id!);
    expect(surfaceT(w, 'lumen', memberEnv('mira', newSid('mira-lumen')))).toContain(r.id!);
    const pattern = dc(w, w.project('lumen'), ['automations', 'pattern', 'mira']).out;
    expect(pattern, 'the oldest of the 21 lessons is still kept').toContain('Ders 01');
    expect(pattern).toContain('Ders 21');
  });

  exam('E4', 'his words relayed by a Super through team ask make Mira\'s rule active in lumen T', () => {
    const sup = newSid('super-kestrel');
    const quote = 'Mira\'ya söyle: raporda önce sonuç yazsın';
    ownerSays(w, quote, [sup], { vault: w.project('kestrel'), surface: 'super' });
    // The relay (W2): the team ask carries his message's ref; the member's conversation gets a
    // relay ledger line. Before W2 nothing of his words reaches Mira's conversation.
    const sid = newSid('mira-kestrel');
    const relay = dc(w, w.project('kestrel'), ['super', 'relay-test-hook', '--from', sup, '--to', sid], plainEnv(sup));
    void relay;
    const r = dc(w, w.project('kestrel'), ['learn', 'Raporda önce sonuç yazılır', '--scope', 'member', '--quote', quote], memberEnv('mira', sid));
    expect(learnedStatus(r), `${r.out}\n${r.err}`).toBe('active');
    expect(surfaceT(w, 'lumen', memberEnv('mira', newSid('mira-lumen')))).toContain(learnedId(r)!);
  });

  exam('E5', 'a rule written while Mira\'s session is open is in that session\'s next T and F', () => {
    const open = newSid('mira-lumen-open');
    sessionStart(w, 'lumen', memberEnv('mira', open));
    const r = miraLearns('kestrel', 'Fiyat tablosunda yıllık plan en solda', 'yıllık planı en sola koy');
    expect(r.id, r.out).not.toBeNull();
    const t = surfaceT(w, 'lumen', memberEnv('mira', open));
    expect(t).toContain(r.id!);
    expect(t).toContain('New since this session started');
    expect(surfaceF(w, 'lumen', memberEnv('mira', open))).toContain(r.id!);
  });

  exam('E6', 'Mira\'s child gets her rule: sub-agent start, dispatch, and a super delegate child', () => {
    const r = miraLearns('kestrel', 'Kopya metninde ünlem kullanma', 'ünlem koyma metne');
    expect(r.id, r.out).not.toBeNull();
    const sid = newSid('mira-lumen');
    const c = surfaceC(w, 'lumen', memberEnv('mira', sid));
    expect(c.start).toContain(r.id!);
    expect(c.dispatch).toContain(r.id!);
    const child = newSid('mira-crew');
    expect(surfaceS(w, 'lumen', crewEnv('mira', child))).toContain(r.id!);
    expect(surfaceT(w, 'lumen', crewEnv('mira', child), 'Rewrite the pricing copy as the brief says')).toContain(r.id!);
  });

  exam('E7', 'the same correction in three words on three occasions is one rule said again', () => {
    const first = miraLearns('kestrel', 'CTA düğmesinde tek fiil olsun', 'düğmede tek fiil olsun');
    expect(first.id, first.out).not.toBeNull();
    for (const q of ['CTA tek kelime fiil, başka bir şey değil', 'butonda yine uzun yazmışsın, tek fiil']) {
      const sid = newSid('mira-kestrel');
      ownerSays(w, q, [sid], { vault: w.project('kestrel'), surface: 'member' });
      const r = dc(w, w.project('kestrel'), ['learn', 'CTA düğmesinde tek fiil olsun', '--scope', 'member', '--same', first.id!, '--quote', q], memberEnv('mira', sid));
      expect(learnedId(r), `${r.out}\n${r.err}`).toBe(first.id);
    }
    const list = dc(w, w.project('lumen'), ['learn', 'show', first.id!, '--json']).out;
    const v = JSON.parse(list) as { sayings: unknown[]; repeats: number; hot: boolean };
    expect(v.sayings.length).toBe(3);
    expect(v.repeats).toBe(2);
    expect(surfaceT(w, 'lumen', memberEnv('mira', newSid('mira-lumen')))).toMatch(new RegExp(`${first.id}, said again`));
  });

  exam('E8', 'an untagged "write to him in Turkish" rule rides a Super event turn (F)', () => {
    const sup = newSid('super-kestrel');
    const quote = 'bana her zaman Türkçe yaz';
    ownerSays(w, quote, [sup], { vault: w.project('kestrel'), surface: 'super' });
    const r = dc(w, w.project('kestrel'), ['learn', 'Sahibe Türkçe yaz', '--scope', 'me', '--quote', quote], plainEnv(sup));
    const id = learnedId(r);
    expect(id, `${r.out}\n${r.err}`).not.toBeNull();
    expect(learnedStatus(r)).toBe('active');
    expect(surfaceF(w, 'lumen', memberEnv('mira', newSid('mira-lumen')))).toContain(id!);
  });

  exam('E9', 'a build-tagged member rule is on the report turn after 250,000 chars of work', () => {
    const r = miraLearns('kestrel', 'Değişen her ekranın ekran görüntüsünü al', 'her değişen ekranın görüntüsünü al', ['--at', 'build']);
    expect(r.id, r.out).not.toBeNull();
    const sid = newSid('mira-lumen');
    const transcript = join(w.root, `transcript-${sid}.jsonl`);
    const filler = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5_000) }] } });
    writeFileSync(transcript, `${Array.from({ length: 50 }, () => filler).join('\n')}\n`);
    expect(surfaceT(w, 'lumen', memberEnv('mira', sid), 'Bitti mi? Raporu yaz', transcript)).toContain(r.id!);
  });

  exam('E10', 'Mira amends her own instruction on his word in her own chat; it holds in lumen B', () => {
    const sid = newSid('mira-kestrel');
    const quote = 'bunu talimatına yaz: fiyat ekranında önce faydayı yaz';
    ownerSays(w, quote, [sid], { vault: w.project('kestrel'), surface: 'member' });
    const show = dc(w, w.project('kestrel'), ['agents', 'show', 'mira', '--json']);
    const prompt = (JSON.parse(show.out) as { prompt: string }).prompt;
    const r = dc(w, w.project('kestrel'), ['agents', 'edit', 'mira', '--prompt', `${prompt}\nFiyat ekranında önce faydayı yaz.`, '--quote', quote], memberEnv('mira', sid));
    expect(`${r.out}\n${r.err}`).toMatch(/AMENDED \S+/);
    expect(whoYouAre(surfaceB('lumen', 'mira'))).toContain('Fiyat ekranında önce faydayı yaz.');
  });

  exam('E11', 'no me.json and no git email: a "every project" rule is stored and reaches fjord S and T', () => {
    const bare = makeWorld({ withEmail: false, members: false });
    try {
      const open = newSid('fjord-open');
      sessionStart(bare, 'fjord', plainEnv(open));
      const quote = 'her projede böyle yap: önce özet, sonra ayrıntı';
      ownerSays(bare, quote, [open], { vault: bare.project('fjord') });
      const r = dc(bare, bare.project('fjord'), ['learn', 'Önce özet, sonra ayrıntı', '--scope', 'me', '--quote', quote], plainEnv(open));
      const id = learnedId(r);
      expect(id, `${r.out}\n${r.err}`).not.toBeNull();
      expect(surfaceT(bare, 'fjord', plainEnv(open))).toContain(id!);
      expect(surfaceS(bare, 'fjord', plainEnv(newSid('fjord')))).toContain(id!);
    } finally { bare.dispose(); }
  });

  exam('E12', 'a new rule against her old instruction line: the line is named, then amended away', () => {
    const r = miraLearns('kestrel', '1 doların altındaki harcamayı sorma', 'bir doların altını bana sorma, harcamayı yap');
    expect(r.id, r.out).not.toBeNull();
    expect(r.out, 'the receipt names the instruction line it touches').toContain('Harcama ve staging her zaman sorulur');
    const show = dc(w, w.project('kestrel'), ['agents', 'show', 'mira', '--json']);
    const prompt = (JSON.parse(show.out) as { prompt: string }).prompt;
    const ed = dc(w, w.project('kestrel'), ['agents', 'edit', 'mira', '--prompt', prompt.replace(' Harcama ve staging her zaman sorulur.', ' Harcama 1 doların altındaysa sorulmaz.'), '--quote', 'bir doların altını bana sorma, harcamayı yap'], memberEnv('mira', r.sid));
    expect(`${ed.out}\n${ed.err}`).toMatch(/AMENDED \S+/);
    const b = surfaceB('lumen', 'mira');
    expect(whoYouAre(b)).not.toContain('her zaman sorulur');
    expect(surfaceT(w, 'lumen', memberEnv('mira', newSid('mira-lumen')))).toContain(r.id!);
  });

  exam('K1', 'a project rule said again (--same) is hot on three separate turns', () => {
    const s1 = newSid('plain-kestrel');
    const q1 = 'kestrel\'de fiyatları TL yaz';
    ownerSays(w, q1, [s1], { vault: w.project('kestrel') });
    const r = dc(w, w.project('kestrel'), ['learn', 'Fiyatlar TL ile yazılır', '--scope', 'project', '--quote', q1], plainEnv(s1));
    const id = learnedId(r);
    expect(id, `${r.out}\n${r.err}`).not.toBeNull();
    const s2 = newSid('plain-kestrel');
    const q2 = 'yine dolar yazmışsın, fiyatlar TL';
    ownerSays(w, q2, [s2], { vault: w.project('kestrel') });
    const again = dc(w, w.project('kestrel'), ['learn', 'Fiyatlar TL ile yazılır', '--scope', 'project', '--same', id!, '--quote', q2], plainEnv(s2));
    expect(learnedId(again), `${again.out}\n${again.err}`).toBe(id);
    for (let i = 0; i < 3; i++) expect(surfaceT(w, 'kestrel', plainEnv(newSid('plain-kestrel')))).toContain(id!);
  });

  // ── must not leak ──────────────────────────────────────────────────────────

  exam('N1', 'Mira\'s rule is not in Oren\'s lumen session nor a plain fjord session', () => {
    const text = 'Başlıkta soru cümlesi kullanma';
    const r = miraLearns('kestrel', text, 'başlık soru olmasın');
    // Precision: neither its id (once there is a store) nor its text leaks.
    const leaks = (s: string): boolean => s.includes(text) || (!!r.id && s.includes(r.id));
    const oren = newSid('oren-lumen');
    expect(leaks(surfaceS(w, 'lumen', memberEnv('oren', oren)))).toBe(false);
    expect(leaks(surfaceT(w, 'lumen', memberEnv('oren', oren)))).toBe(false);
    const plain = newSid('plain-fjord');
    expect(leaks(surfaceS(w, 'fjord', plainEnv(plain)))).toBe(false);
    expect(leaks(surfaceT(w, 'fjord', plainEnv(plain)))).toBe(false);
  });

  exam('N2', 'kestrel\'s own product rule is not in Mira\'s lumen turn', () => {
    const s = newSid('plain-kestrel');
    const q = 'kestrel\'de yıllık plan yok, unut onu';
    ownerSays(w, q, [s], { vault: w.project('kestrel') });
    const r = dc(w, w.project('kestrel'), ['learn', 'Kestrel\'de yıllık plan yok', '--scope', 'project', '--quote', q, '--at', 'always'], plainEnv(s));
    const id = learnedId(r);
    expect(id, `${r.out}\n${r.err}`).not.toBeNull();
    expect(surfaceT(w, 'kestrel', plainEnv(newSid('plain-kestrel'))), 'it rides in kestrel').toContain(id!);
    expect(surfaceT(w, 'lumen', memberEnv('mira', newSid('mira-lumen')))).not.toContain(id!);
  });

  exam('U1', 'a Mira rule he undid reaches no turn in lumen or kestrel', () => {
    const r = miraLearns('kestrel', 'Ekran metninde emoji kullan', 'metinlere emoji koy');
    expect(r.id, `not measurable: no member rule was stored\n${r.out}`).not.toBeNull();
    expect(surfaceT(w, 'lumen', memberEnv('mira', newSid('mira-lumen'))), 'delivered before the undo').toContain(r.id!);
    const u = dc(w, w.project('lumen'), ['learn', 'undo', r.id!]);
    expect(u.code, `${u.out}\n${u.err}`).toBe(0);
    expect(surfaceT(w, 'lumen', memberEnv('mira', newSid('mira-lumen')))).not.toContain(r.id!);
    expect(surfaceT(w, 'kestrel', memberEnv('mira', newSid('mira-kestrel')))).not.toContain(r.id!);
  });
});
