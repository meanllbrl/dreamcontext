/**
 * A question card stands on its own (owner 2026-11-08: "bak örnek yok ama örnekteki gibi diyor").
 * Fixtures are the real field cards' SHAPES with a fictional school, teacher and amounts
 * (`pattern-synthetic-fixtures-for-published-artifacts`): the field card pointed at an example
 * that lived only in the asking agent's thinking.
 */
import { describe, expect, it } from 'vitest';
import { offCardQuestionFrame, offCardReferences, offCardRefusal } from '../../src/lib/card-standalone.js';
import { routeChildLine } from '../../src/lib/mcp-live.js';

const OPTIONS = [
  { label: 'Paket hep programdan okunsun (Önerilen)', description: 'Ders, haftalık programda yazan paketin tutarını alır. Programın paketini yalnız kurum değiştirir.' },
  { label: 'Bırak, yönetici uyarıyı görsün', description: 'Bu yol açık kalır; yöneticinin ekranında bir uyarı çıkar, tutarı elle düzeltir.' },
];

/** The field card that came back "hangi örnek göstermedin ki". */
const POINTS_OFF = {
  title: 'Lale Atölyesi hakediş planı: hoca paketten kaçıp yüksek ücret alabiliyor',
  questions: [{
    question: 'Örnekteki gibi hoca, dersin süresini ya da fiyatını oynatarak paketli dersi paketsiz gösterip 40 ₺ yerine 80 ₺ hakediş alabiliyor. Bunu nasıl kapatalım?',
    header: 'Paket',
    multiSelect: false,
    description: "Yalnız 'pakete göre ödeme' kuralını etkiliyor. Özel/grup, yüzde ve ders başı kurallarında bu sorun yok.",
    options: OPTIONS,
  }],
};

/** The card the owner then answered: the example itself, on the card. */
const STANDS_ALONE = {
  ...POINTS_OFF,
  questions: [{
    ...POINTS_OFF.questions[0],
    question: "Örnek: Defne'nin 8 derslik 320 ₺ paketi var; kural 'paketli ders 40 ₺, paketsiz ders 80 ₺'. (1) Hoca dersi 1 saatten 13 saate çeker. (2) Paket yenilenir, sistem uzun dersi paketin dışında bırakır. (3) Hoca dersi yeniden 1 saate çeker. (4) Ders işlenir: hakediş 80 ₺, olması gereken 40 ₺. Bunu nasıl kapatalım?",
  }],
};

const card = (question: string, description = '', options: unknown[] = OPTIONS) => ({ questions: [{ question, description, options }] });

describe('offCardReferences: a card that points at what is not on it', () => {
  it('the field card: "örnekteki gibi" with no example on the card', () => {
    const f = offCardReferences(POINTS_OFF);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'example', phrase: 'örnekteki gibi' });
  });

  it('the same card with the example written on it passes', () => {
    expect(offCardReferences(STANDS_ALONE)).toEqual([]);
  });

  it('"the text is above in my message" (a Super\'s own ask in the field)', () => {
    const f = offCardReferences(card("Bu 6 balon Ayşe Hoca'ya senin WhatsApp'ından gönderilsin mi?", 'Metin yukarıda mesajımda. Gönderilen mesaj geri alınamaz.', [{ label: 'Gönder' }, { label: 'Bekle' }]));
    expect(f.map((x) => x.kind)).toEqual(['earlier']);
  });

  it('English pointers: "as I showed above", "the table above"', () => {
    expect(offCardReferences(card('Go with the plan as I showed above?')).length).toBeGreaterThan(0);
    expect(offCardReferences(card('Which row of the table above ships first?')).length).toBeGreaterThan(0);
  });

  it('casing and ASCII spelling still match: "YUKARIDAKİ", "ornekteki"', () => {
    expect(offCardReferences(card('YUKARIDAKİ taslak gitsin mi?'))).toHaveLength(1);
    expect(offCardReferences(card('ornekteki gibi olsun mu?'))).toHaveLength(1);
  });

  it('a pointer is answered by a preview or by --show cards', () => {
    const withPreview = card('Örnekteki gibi mi olsun?', '', [{ label: 'A', preview: '<div>mock</div>' }, { label: 'B', preview: '<div>mock</div>' }]);
    expect(offCardReferences(withPreview)).toEqual([]);
    expect(offCardReferences(POINTS_OFF, { shows: true })).toEqual([]);
  });

  it('an example marker anywhere on the card answers "the example"', () => {
    expect(offCardReferences(card('Örnekteki gibi kapatalım mı?', "Örneğin Defne'nin dersi 80 ₺ yazıyor, olması gereken 40 ₺."))).toEqual([]);
  });
});

describe('offCardReferences: legitimate cards stay untouched (field shapes)', () => {
  it('"aşağıdaki mesajlar" with the messages right under it', () => {
    const q = "Selin Hoca'ya aşağıdaki mesajlar gönderilsin mi?\n\n1) Tamamdır hocam, buradan kayıt olabilirsiniz\n2) İlk ay ücretsiz, kart bilgisi istemiyor.";
    expect(offCardReferences(card(q, '', [{ label: 'Gönder' }, { label: 'Bekle' }]))).toEqual([]);
  });

  it('"each step below" when the options are the steps', () => {
    const c = card('Which production steps do you approve?', 'Each step below writes to production.', [
      { label: 'Seed demo data', description: 'Writes three demo classes to the live project.' },
      { label: 'Log in as demo admin', description: 'Uses the shared demo login once.' },
    ]);
    expect(offCardReferences(c)).toEqual([]);
  });

  it('"above" as a number, "planda" as a concept, a report path', () => {
    expect(offCardReferences(card('Keep CPU above 20% as the alarm line?'))).toEqual([]);
    expect(offCardReferences(card('Paket nereden okunsun?', 'Cevabın planda paket bilgisinin nereden okunacağını belirliyor.'))).toEqual([]);
    expect(offCardReferences(card('Hangi yolla gidelim?', 'Rapor: _dream_context/tmp/super/plan.html.'))).toEqual([]);
  });

  it('"which of the following" / "pick one below" mean the options; "yukarıda" as a place', () => {
    const plain = [{ label: 'Search' }, { label: 'Filters' }];
    expect(offCardReferences(card('Which of the following should we ship first?', '', plain))).toEqual([]);
    expect(offCardReferences(card('Pick one below.', '', plain))).toEqual([]);
    expect(offCardReferences(card('Arama çubuğu yukarıda mı kalsın?', '', [{ label: 'Evet' }, { label: 'Hayır' }]))).toEqual([]);
  });

  it('"below" with nothing below still counts', () => {
    expect(offCardReferences(card('Aşağıdaki 3 balon gitsin mi?', '', [{ label: 'Gönder' }, { label: 'Bekle' }])).map((x) => x.kind)).toEqual(['below']);
  });

  it('unrecognised shapes are never refused', () => {
    for (const x of [null, undefined, 'örnekteki gibi', {}, { questions: 'x' }, { questions: [null, 3] }]) {
      expect(offCardReferences(x)).toEqual([]);
    }
  });
});

describe('offCardRefusal', () => {
  it('names the words, says why, and says what to add', () => {
    const msg = offCardRefusal(offCardReferences(POINTS_OFF));
    expect(msg).toContain('"örnekteki gibi"');
    expect(msg).toMatch(/reads cards cold/);
    expect(msg).toMatch(/the example itself/);
    expect(msg).toMatch(/ask again/);
  });
});

describe('the chat relay hands an off-card question back to the agent', () => {
  const frame = (input: unknown, tool = 'AskUserQuestion') => ({
    type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: tool, input },
  });

  it('offCardQuestionFrame: AskUserQuestion that points off → deny words; others → null', () => {
    expect(offCardQuestionFrame(frame(POINTS_OFF))).toMatchObject({ requestId: 'req-1' });
    expect(offCardQuestionFrame(frame(STANDS_ALONE))).toBeNull();
    expect(offCardQuestionFrame(frame({ command: 'echo örnekteki gibi' }, 'Bash'))).toBeNull();
    expect(offCardQuestionFrame({ type: 'assistant' })).toBeNull();
    expect(offCardQuestionFrame(null)).toBeNull();
  });

  it('routeChildLine: an intercepted frame is relayed nowhere; the rest relays as before', () => {
    const sent: string[] = [];
    const mirrored: string[] = [];
    const answered: unknown[] = [];
    const sinks = {
      send: (l: string) => sent.push(l),
      mirror: (l: string) => mirrored.push(l),
      control: () => undefined,
      intercept: (o: Record<string, unknown>) => {
        const off = offCardQuestionFrame(o);
        if (off) answered.push(off);
        return !!off;
      },
    };
    expect(routeChildLine(JSON.stringify(frame(POINTS_OFF)), sinks)).toBeNull();
    expect(sent).toEqual([]);
    expect(mirrored).toEqual([]);
    expect(answered).toHaveLength(1);
    const ok = JSON.stringify(frame(STANDS_ALONE));
    expect(routeChildLine(ok, sinks)).toMatchObject({ type: 'control_request' });
    expect(sent).toEqual([ok]);
  });
});
