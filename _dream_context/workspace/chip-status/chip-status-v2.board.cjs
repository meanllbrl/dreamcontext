/* Design board v2: çip kaç sohbet olduğunu ve kaçının çalıştığını SÖYLESİN.
 * v1 rollup'ı güzelleştiriyordu; bu board kompozisyonu geri getiriyor.
 * Regenerate:  node _dream_context/workspace/chip-status/chip-status-v2.board.cjs
 */
const path = require('path');
const SKILL = path.resolve(__dirname, '../../../.claude/skills/excalidraw/scripts');
const { buildExcalidraw } = require(path.join(SKILL, 'build_excalidraw.js'));
const S = require(path.join(SKILL, 'lib/style.js'));
const C = require(path.join(SKILL, 'lib/charts.js'));

const {
  WIRE, INK, measureText, box, stack, row,
  sectionTitle, prose, connector,
} = S;
const { callout, table } = C;

let GID = 0;
const gid = (p) => `${p}-${++GID}`;

const T = {
  work: '#1ba94c',      // çalışıyor
  ask: '#ff5fc4',       // seni bekliyor
  idle: '#c3c6cf',      // boşta
  track: '#e6e8ee',     // süpürme çizgisinin yatağı
  ink: '#474747',
  accent: '#7b68ee',
};
const COL = { working: T.work, asking: T.ask, idle: T.idle };

/* ── Çip · üç kompozisyon biçimi + ortak süpürme çizgisi ──────────────────── */
function chipV2({
  x, y, name, sessions = [], mode = 'pips', sweep = null, active = false, scale = 1,
}) {
  const s = scale;
  const fs = Math.round(13 * s);
  const padX = Math.round(12 * s);
  const gap = Math.round(8 * s);
  const h = Math.round((mode === 'bar' ? 40 : 30) * s);
  const g = gid('chip');
  const out = [];

  const nWork = sessions.filter((k) => k === 'working').length;
  const nAsk = sessions.filter((k) => k === 'asking').length;
  const N = sessions.length;

  /* genişlik hesabı */
  const nameW = measureText(name, fs);
  const pipR = Math.round(4 * s);
  const pipGap = Math.round(5 * s);
  const pipsW = N ? N * pipR * 2 + (N - 1) * pipGap : 0;
  const fracTxt = `${nWork}/${N}`;
  const fracW = Math.round(measureText(fracTxt, fs) + 16 * s);
  let w;
  if (mode === 'pips') w = Math.round(padX + nameW + (N ? gap + pipsW : 0) + padX);
  else if (mode === 'fraction') w = Math.round(padX + pipR * 2 + gap + nameW + gap + fracW + padX);
  else w = Math.round(padX + Math.max(nameW, 90 * s) + padX);

  /* gövde */
  out.push({
    type: 'rectangle', x, y, width: w, height: h,
    strokeColor: active ? T.accent : WIRE.line,
    backgroundColor: active ? '#f3f0ff' : WIRE.paper,
    fillStyle: 'solid', strokeWidth: active ? 2 : 1.5, roundness: true, group: g,
  });

  if (mode === 'pips') {
    out.push({
      type: 'text', x: x + padX, y: y + h / 2 - fs * 0.62, text: name, fontSize: fs,
      color: INK, width: nameW + 4, fontFamily: 5, group: g,
    });
    let px = x + padX + nameW + gap;
    sessions.forEach((k) => {
      out.push({
        type: 'ellipse', x: px, y: y + h / 2 - pipR, width: pipR * 2, height: pipR * 2,
        strokeColor: COL[k], backgroundColor: COL[k], fillStyle: 'solid', strokeWidth: 1, group: g,
      });
      px += pipR * 2 + pipGap;
    });
  } else if (mode === 'fraction') {
    const dc = nAsk ? T.ask : nWork ? T.work : T.idle;
    out.push({
      type: 'ellipse', x: x + padX, y: y + h / 2 - pipR, width: pipR * 2, height: pipR * 2,
      strokeColor: dc, backgroundColor: dc, fillStyle: 'solid', strokeWidth: 1, group: g,
    });
    out.push({
      type: 'text', x: x + padX + pipR * 2 + gap, y: y + h / 2 - fs * 0.62, text: name,
      fontSize: fs, color: INK, width: nameW + 4, fontFamily: 5, group: g,
    });
    const bx = x + padX + pipR * 2 + gap + nameW + gap;
    const bh = Math.round(18 * s);
    out.push({
      type: 'rectangle', x: bx, y: y + h / 2 - bh / 2, width: fracW, height: bh,
      strokeColor: nAsk ? T.ask : T.ink, backgroundColor: nAsk ? T.ask : T.ink,
      fillStyle: 'solid', strokeWidth: 1, roundness: true, group: g,
    });
    out.push({
      type: 'text', x: bx, y: y + h / 2 - fs * 0.55, text: fracTxt,
      fontSize: Math.round(11 * s), color: '#ffffff', width: fracW, align: 'center',
      fontFamily: 5, group: g,
    });
  } else {
    /* bar — ad üstte, altında yığılmış kompozisyon şeridi */
    out.push({
      type: 'text', x: x + padX, y: y + Math.round(6 * s), text: name, fontSize: fs,
      color: INK, width: nameW + 6, fontFamily: 5, group: g,
    });
    const bw = w - padX * 2;
    const bh = Math.round(6 * s);
    const by = y + h - Math.round(11 * s);
    let cx = x + padX;
    const seg = (n, color) => {
      if (!n) return;
      const sw = Math.round((bw * n) / Math.max(1, N));
      out.push({
        type: 'rectangle', x: cx, y: by, width: sw, height: bh,
        strokeColor: color, backgroundColor: color, fillStyle: 'solid', strokeWidth: 1,
        roundness: true, group: g,
      });
      cx += sw;
    };
    seg(nAsk, T.ask);
    seg(nWork, T.work);
    seg(N - nAsk - nWork, T.idle);
  }

  /* ortak: alt kenarda süpüren yükleme çizgisi */
  if (sweep !== null) {
    const ly = y + h - Math.round(2.5 * s);
    const lw = w - Math.round(10 * s);
    const lx = x + Math.round(5 * s);
    out.push({
      type: 'line', points: [[lx, ly], [lx + lw, ly]],
      strokeColor: T.track, strokeWidth: Math.round(3 * s), group: g,
    });
    const runW = Math.round(lw * 0.38);
    const head = Math.round(lx + (lw + runW) * sweep);
    const tail = Math.max(lx, head - runW);
    if (head > lx) {
      out.push({
        type: 'line', points: [[tail, ly], [Math.min(head, lx + lw), ly]],
        strokeColor: T.work, strokeWidth: Math.round(3 * s), group: g,
      });
    }
  }
  return box(out, x, y, w, h);
}

/* Yatay çip dizisi */
function strip({ x, y, chips, gap = 12 }) {
  const out = [];
  let cx = x, h = 0;
  for (const c of chips) {
    const el = chipV2(Object.assign({}, c, { x: cx, y }));
    out.push(...el);
    cx += el.w + gap;
    h = Math.max(h, el.h);
  }
  return box(out, x, y, cx - gap - x, h);
}

/* Bir animasyonu durağan anlatmanın yolu: üç kare */
function filmstrip({ x, y, make, frames, labels, gap = 34, caption = null }) {
  const out = [];
  let cx = x, h = 0;
  frames.forEach((f, i) => {
    const el = make(cx, y, f);
    out.push(...el);
    out.push({
      type: 'text', x: cx, y: y + el.h + 10, text: labels[i], fontSize: 13,
      color: WIRE.hint, width: el.w, align: 'center', fontFamily: 5,
    });
    h = Math.max(h, el.h + 30);
    cx += el.w + gap;
    if (i < frames.length - 1) {
      out.push(...connector({
        from: [cx - gap + 6, y + el.h / 2], to: [cx - 8, y + el.h / 2], strokeWidth: 1.5,
      }));
    }
  });
  let bottom = y + h;
  if (caption) {
    const t = prose({ x, y: bottom + 8, width: 660, fontSize: 14, text: caption });
    out.push(...t);
    bottom = t.y + t.h;
  }
  return box(out, x, y, cx - gap - x, bottom - y);
}

/* Hover peek — çipin altında açılan oturum listesi */
function peek({ x, y, rows, w = 300 }) {
  const g = gid('peek');
  const rh = 34, padY = 10;
  const h = padY * 2 + rows.length * rh;
  const out = [{
    type: 'rectangle', x, y, width: w, height: h, strokeColor: T.accent,
    backgroundColor: '#ffffff', fillStyle: 'solid', strokeWidth: 2, roundness: true, group: g,
  }];
  rows.forEach((r, i) => {
    const ry = y + padY + i * rh;
    out.push({
      type: 'ellipse', x: x + 14, y: ry + rh / 2 - 4, width: 8, height: 8,
      strokeColor: COL[r.state], backgroundColor: COL[r.state], fillStyle: 'solid',
      strokeWidth: 1, group: g,
    });
    out.push({
      type: 'text', x: x + 32, y: ry + rh / 2 - 8, text: r.title, fontSize: 13,
      color: INK, width: 150, fontFamily: 5, group: g,
    });
    out.push({
      type: 'text', x: x + w - 118, y: ry + rh / 2 - 8, text: r.word, fontSize: 12,
      color: COL[r.state] === T.idle ? WIRE.hint : COL[r.state], width: 104, align: 'right',
      fontFamily: 5, group: g,
    });
  });
  return box(out, x, y, w, h);
}

/* ── Board ───────────────────────────────────────────────────────────────── */
const X = 60;
const els = [];
const P = (a) => els.push(...a);
const BIG = 2.2;

const s0 = stack({
  x: X, y: 60, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: 'Çip, kaç sohbet olduğunu ve kaçının çalıştığını söylesin', fontSize: 44, maxWidth: 1500 }),
    (x, y) => prose({
      x, y, width: 700, fontSize: 17,
      text: 'İlk board yanlış soruyu çözüyordu: tek noktanın rengini düzeltmek, o noktanın N sohbeti tek renge indirmesini düzeltmiyor. Asıl kayıp kompozisyon — “üç sohbet var, ikisi çalışıyor, biri seni bekliyor” cümlesi çipe hiç girmiyor. İki ayrı iş var ve ayrı ayrı çözülmeleri gerekiyor.',
    }),
    (x, y) => table({
      x, y, fontSize: 14, maxColW: 330,
      headers: ['Soru', 'Bugün çip ne diyor', 'Eksik olan'],
      rows: [
        ['Kaç sohbet var?', 'Rozetteki sayı — 3', { text: 'cevap veriyor', color: 'green' }],
        ['Kaçı çalışıyor?', 'Hiçbir şey', { text: 'tamamen kayıp', color: 'red' }],
        ['Kaçı beni bekliyor?', 'Tek seferlik zıplama', { text: 'kaçırırsan kayıp', color: 'red' }],
        ['Bir şey yükleniyor mu?', '8px noktada opaklık nabzı', { text: 'fark edilmiyor', color: 'red' }],
      ],
    }),
  ],
});
P(s0);

/* ── 1 · Yükleme: alt kenarda süpüren çizgi ──────────────────────────────── */
const s1 = stack({
  x: X, y: s0.nextY + 65, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: '1 · Yükleme — nokta değil, çipin alt kenarı', fontSize: 30 }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 16,
      text: 'Nokta yükleme anlatmak için fazla küçük: 8 pikselde nabız da yay da fark edilmiyor. Çipin alt kenarı ise 150 piksel uzunluğunda ve zaten orada duruyor — tarayıcı sekmelerinin yükleme çizgisiyle aynı fikir. Yeni yer istemez, gözden kaçmaz.',
    }),
    (x, y) => filmstrip({
      x, y, frames: [0, 0.42, 0.85],
      labels: ['0,0 sn', '0,5 sn', '1,0 sn'],
      make: (cx, cy, f) => chipV2({
        x: cx, y: cy, name: 'dreamcontext', scale: BIG, sweep: f,
        sessions: ['working', 'working', 'idle'], mode: 'pips',
      }),
      caption: 'Çizgi soldan sağa süpürür ve başa döner. Herhangi bir sohbet çalışıyorken görünür, hepsi durunca kaybolur. Tek animasyon — N sohbet için N ayrı dönen halka değil.',
    }),
    (x, y) => row({
      x, y, gap: 44, valign: 'top', items: [
        (a, b) => callout({
          x: a, y: b, w: 600, color: 'green', title: 'Neden bu okunuyor',
          text: 'Hareket eden şeyin uzunluğu var, yani gözün çevresel görüşü yakalıyor — bir noktanın parlaklık oynaması yakalamıyor. Ayrıca yön taşıyor: soldan sağa akan bir çizgi “ilerliyor” demek, nabız atan bir nokta “bir şey var” demek.',
        }),
        (a, b) => callout({
          x: a, y: b, w: 600, color: 'yellow', title: 'reduced-motion',
          text: 'Hareket kapalıyken çizgi süpürmez; sabit ve kesikli durur. Yani “çalışıyor” hâlâ görünür bir işaret, sadece kıpırdamaz. Bilgi asla yalnızca animasyonda durmaz.',
        }),
      ],
    }),
  ],
});
P(s1);

/* ── 2 · Kompozisyon: üç seçenek ─────────────────────────────────────────── */
const CASES = [
  { label: 'tek sohbet, boşta', sessions: ['idle'] },
  { label: 'üç sohbet, ikisi çalışıyor', sessions: ['working', 'working', 'idle'] },
  { label: 'yedi sohbet, biri seni bekliyor', sessions: ['asking', 'working', 'working', 'working', 'idle', 'idle', 'idle'] },
];

function optionBlock({ x, y, title, mode, note }) {
  return stack({
    x, y, gap: 22, items: [
      (a, b) => sectionTitle({ x: a, y: b, text: title, fontSize: 24, maxWidth: 700 }),
      (a, b) => stack({
        x: a, y: b, gap: 14, items: CASES.map((c) => (cx, cy) => {
          const chip = chipV2({
            x: cx, y: cy, name: 'dreamcontext', scale: 1.6, mode,
            sessions: c.sessions,
            sweep: c.sessions.some((k) => k === 'working') ? 0.45 : null,
          });
          const t = {
            type: 'text', x: cx + chip.w + 18, y: cy + chip.h / 2 - 9, text: c.label,
            fontSize: 14, color: WIRE.hint, width: 260, fontFamily: 5,
          };
          return box([...chip, t], cx, cy, chip.w + 18 + 260, chip.h);
        }),
      }),
      (a, b) => prose({ x: a, y: b, width: 480, fontSize: 15, text: note }),
    ],
  });
}

const s2 = stack({
  x: X, y: s1.nextY + 65, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: '2 · Kompozisyon — “kaç var, kaçı çalışıyor”', fontSize: 30 }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 16,
      text: 'Üç aday. Hepsi aynı üç durumla çiziliyor ki ölçeklenmeleri karşılaştırılabilsin: tek boş sohbet, üç sohbetin ikisi çalışırken, ve yedi sohbetin biri seni beklerken.',
    }),
    (x, y) => row({
      x, y, gap: 56, valign: 'top', items: [
        (a, b) => optionBlock({
          x: a, y: b, title: 'A · Nokta sırası', mode: 'pips',
          note: 'Her sohbet bir nokta, rengi kendi hali. Sayı doğrudan sayılabiliyor ve hangi halden kaç tane olduğu görünüyor. Bedeli: yedi noktadan sonra saymak zorlaşıyor ve çip uzuyor.',
        }),
        (a, b) => optionBlock({
          x: a, y: b, title: 'B · Kesir', mode: 'fraction',
          note: 'Rozet “2/3” diyor: iki çalışan, toplam üç. Sorunun harfi harfine cevabı ve N ne olursa olsun genişlik sabit. Bedeli: bekleyen sohbet sayıya girmiyor, sadece rengi kırmızıya çeviriyor.',
        }),
        (a, b) => optionBlock({
          x: a, y: b, title: 'C · Yığılmış şerit', mode: 'bar',
          note: 'Adın altında ince bir şerit; oranlar hallere göre bölünüyor. Yedi sohbette bile tek bakışta okunuyor. Bedeli: kesin sayıyı vermiyor, oran veriyor — ve çip 10px uzuyor.',
        }),
      ],
    }),
  ],
});
P(s2);

/* ── 3 · Kesin sayı nerede ───────────────────────────────────────────────── */
const s3 = stack({
  x: X, y: s2.nextY + 65, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: '3 · Kesin liste — çipin üstüne gelince', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 60, valign: 'top', items: [
        (a, b) => stack({
          x: a, y: b, gap: 10, items: [
            (c, d) => chipV2({
              x: c, y: d, name: 'dreamcontext', scale: 1.6, mode: 'pips',
              sessions: ['asking', 'working', 'working'], sweep: 0.45, active: true,
            }),
            (c, d) => peek({
              x: c, y: d + 6, w: 320, rows: [
                { title: 'Chat 19', state: 'asking', word: 'seni bekliyor' },
                { title: 'Chat 21', state: 'working', word: 'çalışıyor' },
                { title: 'sleep-tasks', state: 'working', word: 'çalışıyor' },
              ],
            }),
          ],
        }),
        (a, b) => callout({
          x: a, y: b, w: 640, color: 'blue', title: 'Neden gerekli',
          text: 'Çip 150 piksel: kaç tane ve kaçı çalışıyor sığar, hangisi olduğu sığmaz. O yüzden hangi sohbetin hangi halde olduğu üstüne gelince açılan listede duruyor. Üç adayın hepsiyle çalışır — seçimden bağımsız olarak eklenmeli.',
        }),
      ],
    }),
  ],
});
P(s3);

/* ── 4 · Karar ───────────────────────────────────────────────────────────── */
const s4 = stack({
  x: X, y: s3.nextY + 65, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: '4 · Hangisi', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 50, valign: 'top', items: [
        (a, b) => table({
          x: a, y: b, fontSize: 13, maxColW: 200,
          headers: ['', 'A · noktalar', 'B · kesir', 'C · şerit'],
          rows: [
            ['kaç sohbet var', 'sayılabiliyor', 'yazıyor', 'oran olarak'],
            ['kaçı çalışıyor', 'sayılabiliyor', 'yazıyor', 'oran olarak'],
            ['biri bekliyor mu', 'ayrı renkte nokta', 'rozet rengi', 'ayrı dilim'],
            ['N = 7 olunca', 'saymak zorlaşır', 'değişmez', 'değişmez'],
            ['çip genişliği', 'N ile büyür', 'sabit', 'sabit'],
            ['çip yüksekliği', 'değişmez', 'değişmez', '+10px'],
          ],
        }),
        (a, b) => stack({
          x: a, y: b, gap: 18, items: [
            (c, d) => callout({
              x: c, y: d, w: 640, color: 'purple', title: 'Önerim · B + süpürme çizgisi',
              text: 'Kesir sorduğun soruyu kelimesi kelimesine cevaplıyor ve kaç sohbet açarsan aç çip aynı genişlikte kalıyor. Noktalar üç sohbete kadar daha güzel ama yedide dağılıyor, şerit ise kesin sayıyı hiç vermiyor — asıl şikayetin “kaç” olduğu için oranın yeterli olmadığını düşünüyorum.',
            }),
            (c, d) => callout({
              x: c, y: d, w: 640, color: 'green', title: 'Yine de A güçlü bir seçim',
              text: 'Sende genelde proje başına iki-üç sohbet varsa noktalar daha okunur: sayı ve dağılım tek bakışta, okumaya gerek yok. Beşten sonra “5+” ile kısaltmak da mümkün. Kaç sohbetle çalıştığını sen bilirsin — karar bu.',
            }),
          ],
        }),
      ],
    }),
  ],
});
P(s4);

buildExcalidraw({
  out: path.resolve(__dirname, 'chip-status-v2.excalidraw.md'),
  name: 'chip-status-v2',
  description: 'dreamcontext masaüstü proje çipinin N sohbeti tek noktaya indirmesi yerine kompozisyonu göstermesi için tasarım: yükleme için çipin alt kenarında süpüren çizgi, ve kaç sohbet olduğu / kaçının çalıştığı için üç aday (nokta sırası, kesir rozeti, yığılmış şerit) ile üstüne gelince açılan kesin oturum listesi.',
  tags: ['design', 'desktop', 'excalidraw'],
  elements: els,
});
