/**
 * The golden set of "Telegram'da Super sade konuşur" (Doc 2026-11-21, section 4): four real
 * conversations from the owner's export, rewritten with fictional names and numbers (published
 * artifact rule), fed through the hub as the Super wrote them under the OLD writing rule. What
 * reaches the phone must stay under Doc's bar: one message per turn, no line that only says
 * "I am looking", no raw relative link, the visible part of an answer short with the rest folded.
 *
 * TG_GOLDEN_OUT=<dir> also writes what each conversation sent (text, buttons, silent) as JSON,
 * for the before/after screenshots.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTelegram, textUpdate } from '../helpers/fake-telegram.js';
import { TelegramHub } from '../../src/server/telegram/hub.js';
import * as reg from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import { parseTelegramPrefix } from '../../src/lib/telegram/contract.js';
import { telegramHtmlToPlain } from '../../src/lib/telegram/format.js';
import { resetWindowControl } from '../../src/lib/window-control.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 777;
const SID = '11111111-2222-4333-8444-555555555555';
let home: string; let project: string; let root: string; let tg: FakeTelegram; let hub: TelegramHub;
const drained = () => new Promise((r) => setTimeout(r, 40));
const quiet = () => new Promise((r) => setTimeout(r, 80));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tg-golden-home-'));
  project = mkdtempSync(join(tmpdir(), 'tg-golden-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));
  reg._resetChatRegistry(); resetWindowControl();
  tg = new FakeTelegram(); tg.addBot(TOKEN, 'acme_super_bot');
  hub = new TelegramHub({
    textGraceMs: 5_000, sadeTickMs: 0, home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: async () => {}, now: () => new Date(2026, 10, 21, 14).getTime(),
    vaults: () => [{ name: 'acme', contextRoot: root }], openLink: () => {}, injectorWaitMs: 300,
  });
  await hub.start();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SID, enabled: true }));
  resetSuperIndex(); await readSuperState(root);
  const s = await hub.beginPairing({ scope: scopeOfContextRoot(root), target: 'super', token: TOKEN, projectName: 'acme', contextRoot: root });
  await drained();
  tg.push(TOKEN, textUpdate(OWNER, `/start ${new URL(s.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(hub.pairingPreview(s.pairingId)).not.toBeNull(), { timeout: 5000 });
  await hub.confirmPairing(s.pairingId, { botId: 123456, userId: OWNER });
  await drained();
});
afterEach(async () => {
  await hub.stop();
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

/** One step of a Super turn as the old export shows it: a text, or a tool call between texts. */
type Step = string | { tool: true };
interface Golden { name: string; owner: string; turn: Step[]; maxMessages: number; maxVisible: number }

const GOLDEN: Golden[] = [
  {
    // Export dc-a: a status answer of four bold groups, then a second text after a tool call.
    name: 'dc-a', owner: 'Şu an ne yapıyorsun', maxMessages: 1, maxVisible: 1200,
    turn: [
      'Şu an iki iş çalışıyor, bir iş de senin onayını bekliyor.\n\n**Çalışanlar**\n- Karşılama ekranlarının yapımı sürüyor. Sunucu tarafı yazıldı, sırada testler, inceleme ve ekranlar var.\n- Ajandadaki bir satıra tıklayınca o konudaki tüm mesajların görünmesi düzeltiliyor.\n\n**Seni bekleyen**\n- Ana ekranın yeni maketleri. Sen "yap" diyene kadar bekliyor.\n\n**Bitenler, sonraki derlemeyi bekliyor**\n- Hafıza düzeltmesi: ajanda satırı yeniden aramaya giriyor.\n- Boş görünen sayfa kartı düzeltmesi.',
      { tool: true },
      'Karşılama yapımının birinci bölümü yazıldı ve testleri geçti. Sırada inceleme, sonra ekranların yapılacağı ikinci bölüm var. Hiçbir şey dışarı gönderilmedi.',
    ],
  },
  {
    // Export dc-b: three "I am looking" lines between tool calls, then a long answer with a
    // relative link to a PDF and two bold groups.
    name: 'dc-b', owner: 'Onaylattığım ve kodlanan değişiklikleri soruyorum', maxMessages: 1, maxVisible: 1200,
    turn: [
      'Ne istediğini doğru anlamak için önceki konuşmaya bakıyorum.', { tool: true },
      "Önceki oturumda ne istediğini buluyorum, sonra doğru PDF'i hazırlayacağım.", { tool: true },
      "Onayladığın karşılama değişikliklerinin PDF'ini hazırlıyorum.", { tool: true },
      "**Haklısın, yanlış anlamışım: onayladığın ve kodlanan değişikliklerin PDF'ini hazırladım (6 sayfa).**\n\n[Karşılama: değişenler](_dream_context/tmp/super/karsilama/degisenler.pdf)\n\n**Ne var**\n- Karşılama: kurulum listesi kalkıyor, tek düğme kalıyor\n- Proje açma: 3 ekran yerine 1, doğrudan ana ekrana iniyor\n- Depodan başlama: 5 ekran ve 7 tık yerine 3 ekran ve 3 tık\n- İlk sohbet: bugünkü ana ekran ve 4 dokunuş\n- İlk okuma: yalnız ilk projede, senin dokunuşunla başlıyor\n\n**Durum**\n- 1. dalga yazıldı, testler geçti: arka plan ve ana ekrandaki dokunuşlar\n- 2. dalga, yani karşılama, proje açma ve depo ekranları, şu an yapılıyor\n- Henüz senin uygulamanda yok; bitince gerçek ekran görüntülerini bu maketlerin yanına koyacağım\n\nMac'te PDF sunum sırasında bekliyor; şu an baktığın sunumu geçince açılacak.",
    ],
  },
  {
    // Export tilki-a: a check started, four bullets of what it does, "still running", a rule note.
    name: 'tilki-a', owner: 'Deniz Hoca ile ilgili eksik bir şey var mı, kontrol et', maxMessages: 1, maxVisible: 1200,
    turn: [
      "Deniz Hoca'nın kontrolünü başlattım. Ona hiçbir mesaj gitmeyecek, mesaj kartını da kapattım.\n\n**Kontrol ne yapıyor**\n- Kurumun bütün aktif öğrencilerinin bakiyesine, paketine, kalan dersine ve peşin derslerine bakıyor\n- Dünkü düzeltmeler (Ece, Bora, Selin, Kaan) hâlâ yerinde mi, hoca sonradan kayıtlarla oynamış mı, ona bakıyor\n- Canlıdaki hoca kartı ve Ödeme Geçmişi bu öğrencileri doğru gösteriyor mu, onu da kontrol ediyor\n- Hocaya verdiğimiz ama yapmadığımız bir söz ya da cevapsız kalmış bir sorusu var mı, onu da çıkarıyor\n\nKontrol yalnız okuyor: veri yazmıyor, mesaj göndermiyor. Hâlâ sürüyor. Bitince sonucu tek satırda yazacağım.\n\n**Kural**\n- \"Gece geç saatte hocaya, veliye ya da aday hocaya mesaj gönderilmez\" kuralını bu projeye kaydettim. Yanlışsa \"geri al\" demen yeterli.",
    ],
  },
  {
    // Export tilki-a, the check's result: five bold groups, 1.500 characters.
    name: 'tilki-b', owner: 'Sonuç ne oldu?', maxMessages: 1, maxVisible: 1200,
    turn: [
      "Kontrol bitti: veride ciddi bir hata yok, canlı ekran öğrencileri doğru gösteriyor. Ücreti yanlış kalmış iki öğrenci ve gitmemiş bir haber mesajı var.\n\n**Doğru olanlar**\n- 120 aktif öğrencinin hepsine bakıldı, yeni bir tutarsızlık çıkmadı\n- Dünkü düzeltmeler yerinde (Ece, Bora, Selin), hoca sonradan bu kayıtlara dokunmamış\n- Peşin ders ve \"N ders kaldı\" düzeltmeleri canlı sitenin kodunda var\n\n**Küçük hatalar**\n- Ece'nin kayıtlı ders ücreti 1.500 TL'de kalmış, doğrusu 1.300 TL\n- Bora'nınki 1.300 TL'de kalmış, doğrusu 1.500 TL\n- Bakiyeleri doğru. Ama hoca bu iki öğrenciye yeni ders açarsa yanlış fiyat gelir\n\n**Eksik kalan sözler**\n- Haber mesajı hâlâ gitmedi. Hoca dün 21:16'da \"sizden haber bekliyorum\" yazdı\n- Hocaya \"bir süre düzenli kontrol edeceğim\" denmiş, bunun için açılmış bir iş yok\n- Takvimde Excel'e döndüğünü söylemişti, buna cevap verilmedi\n\n**Dikkat**\n- Bir velinin aynı gece iki ödeme mesajı aldı, 23 saniye arayla\n- Bu bir hata değil, kurumun \"bakiye bitince hatırlat\" ayarından geliyor. Ama veli hocaya bunu sorabilir\n\nHiçbir şey göndermedim, hiçbir kaydı değiştirmedim.",
    ],
  },
];

const OUT = process.env.TG_GOLDEN_OUT;

describe('the golden set (Doc 2026-11-21): four real conversations, fictional names', () => {
  for (const g of GOLDEN) {
    it(`${g.name}: at most ${g.maxMessages} message, at most ${g.maxVisible} visible characters, nothing that only says "I am looking"`, async () => {
      const h = reg.registerChat({ sessionId: SID, conversationId: null, vault: 'acme', mode: 'super' });
      const sent: string[] = [];
      reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: vi.fn(async (t: string) => { sent.push(t); return { ok: true as const }; }), interrupt: vi.fn() });
      tg.push(TOKEN, textUpdate(OWNER, g.owner));
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000 });
      const ref = parseTelegramPrefix(sent[0]).ref!;
      const n = tg.sent().length;
      g.turn.forEach((step, i) => {
        if (typeof step === 'string') h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: i === 0 ? `<!-- re:${ref} -->\n${step}` : step }] } });
        else h.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'ls' } }] } });
      });
      h.observe({ type: 'result', subtype: 'success', is_error: false, result: '' });
      await vi.waitFor(() => expect(tg.sent().length).toBeGreaterThan(n), { timeout: 5000 });
      await quiet();
      const out = tg.sent().slice(n).filter((c) => !String(c.params.text).startsWith('ℹ️'));
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, `${g.name}.json`), JSON.stringify({ owner: g.owner, sent: out.map((c) => ({ text: c.params.text, silent: !!c.params.disable_notification })) }, null, 2));
      }
      expect(out.length).toBeLessThanOrEqual(g.maxMessages);
      const html = out.map((c) => String(c.params.text)).join('\n');
      // The visible part: everything outside the folded quote.
      const visible = telegramHtmlToPlain(html.replace(/<blockquote expandable>[\s\S]*?<\/blockquote>/g, ''));
      expect(Array.from(visible).length).toBeLessThanOrEqual(g.maxVisible);
      expect(visible).not.toMatch(/bakıyorum\.|buluyorum, sonra|hazırlıyorum\./);
      expect(html).not.toContain('](_dream_context');
      // Nothing is lost: every bullet of the old answer is still in the message, folded or not.
      for (const step of g.turn) {
        if (typeof step !== 'string' || /bakıyorum\.|buluyorum, sonra|hazırlıyorum\./.test(step)) continue;
        for (const line of step.split('\n').filter((l) => l.startsWith('- '))) expect(telegramHtmlToPlain(html)).toContain(line.slice(2, 40));
      }
    });
  }
});
