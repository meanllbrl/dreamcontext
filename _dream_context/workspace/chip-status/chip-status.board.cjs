/* Design board: chip/tab durum renkleri — bugünkü çakışma ve dört seçenek.
 * Regenerate:  node _dream_context/workspace/chip-status/chip-status.board.cjs
 */
const path = require('path');
const SKILL = path.resolve(__dirname, '../../../.claude/skills/excalidraw/scripts');
const { buildExcalidraw } = require(path.join(SKILL, 'build_excalidraw.js'));
const S = require(path.join(SKILL, 'lib/style.js'));
const C = require(path.join(SKILL, 'lib/charts.js'));

const {
  PALETTE, WIRE, INK, measureText, box, stack, row,
  sectionTitle, prose, bullets, connector,
} = S;
const { callout, table, quadrant } = C;

let GID = 0;
const gid = (p) => `${p}-${++GID}`;

/* ── Uygulamanın gerçek token'ları (dashboard/src/styles/tokens.css) ───────── */
const T = {
  accent: '#7b68ee',     // --color-accent
  success: '#1ba94c',    // --color-success  hsl(142 71% 40%)
  warning: '#ff7a00',    // --color-warning / --color-caution
  error: '#dc3535',      // --color-error    hsl(0 72% 51%)
  waiting: '#ff5fc4',    // --mood-waiting
  sleeping: '#7d8cff',   // --mood-sleeping
  neutral: '#474747',    // --color-text-tertiary
};

/* ── Durum noktası — dolu / halka / dönen yay / nabız ─────────────────────── */
function statusDot({ x, y, r = 6, color = T.neutral, style = 'solid', group = null }) {
  const g = group || gid('dot');
  const out = [];
  const cx = x + r, cy = y + r;
  if (style === 'ring') {
    out.push({
      type: 'ellipse', x, y, width: r * 2, height: r * 2,
      strokeColor: color, backgroundColor: 'transparent', strokeWidth: 2.5, group: g,
    });
  } else {
    out.push({
      type: 'ellipse', x, y, width: r * 2, height: r * 2,
      strokeColor: color, backgroundColor: color, fillStyle: 'solid', strokeWidth: 1, group: g,
    });
  }
  if (style === 'pulse') {
    // opaklık nabzının statik gösterimi: soluk ikinci halka
    const R = r * 1.9;
    out.push({
      type: 'ellipse', x: cx - R, y: cy - R, width: R * 2, height: R * 2,
      strokeColor: color, backgroundColor: 'transparent', strokeWidth: 1, group: g,
    });
  }
  if (style === 'arc') {
    // noktanın çevresinde 270° yay — hareketin bir YÖNÜ olduğunu gösterir
    const R = r * 2.1;
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const a = (-Math.PI / 2) + (i / 24) * (Math.PI * 1.5);
      pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
    out.push({ type: 'line', points: pts, strokeColor: color, strokeWidth: 2.5, group: g });
  }
  const span = style === 'solid' || style === 'ring' ? r * 2 : r * 4.2;
  const off = style === 'solid' || style === 'ring' ? 0 : (span - r * 2) / 2;
  return box(out, x - off, y - off, span, span);
}

/* ── Bir proje çipi: nokta · ad · (kelime) · rozet ────────────────────────── */
function chipEl({
  x, y, name, active = false, dot = T.neutral, dotStyle = 'solid',
  badge = null, badgeColor = T.neutral, word = null, scale = 1,
}) {
  const fs = Math.round(13 * scale);
  const h = Math.round(30 * scale);
  const padX = Math.round(12 * scale);
  const r = Math.round(5 * scale);
  const gap = Math.round(8 * scale);
  const dotSpan = dotStyle === 'solid' || dotStyle === 'ring' ? r * 2 : Math.round(r * 4.2);
  const label = word ? `${name} · ${word}` : name;
  const nameW = measureText(label, fs);
  const badgeW = badge ? Math.round(20 * scale) : 0;
  const w = Math.round(padX + dotSpan + gap + nameW + (badge ? gap + badgeW : 0) + padX);
  const g = gid('chip');
  const out = [];
  out.push({
    type: 'rectangle', x, y, width: w, height: h,
    strokeColor: active ? T.accent : WIRE.line,
    backgroundColor: active ? '#f3f0ff' : WIRE.paper,
    fillStyle: 'solid', strokeWidth: active ? 2 : 1.5, roundness: true, group: g,
  });
  let cx = x + padX;
  out.push(...statusDot({
    x: cx + (dotSpan - r * 2) / 2, y: y + h / 2 - r, r, color: dot, style: dotStyle, group: g,
  }));
  cx += dotSpan + gap;
  out.push({
    type: 'text', x: cx, y: y + h / 2 - fs * 0.62, text: label, fontSize: fs,
    color: active ? INK : WIRE.text, width: nameW + 4, fontFamily: 5, group: g,
  });
  cx += nameW + gap;
  if (badge) {
    const bh = Math.round(18 * scale);
    out.push({
      type: 'ellipse', x: cx, y: y + h / 2 - bh / 2, width: badgeW, height: bh,
      strokeColor: badgeColor, backgroundColor: badgeColor, fillStyle: 'solid',
      strokeWidth: 1, group: g,
    });
    out.push({
      type: 'text', x: cx, y: y + h / 2 - fs * 0.55, text: String(badge),
      fontSize: Math.round(11 * scale), color: '#ffffff', width: badgeW, align: 'center',
      fontFamily: 5, group: g,
    });
  }
  return box(out, x, y, w, h);
}

/* Bir sohbet sekmesi — nokta · ◆ · başlık (alt şerit) */
function tabEl({ x, y, title, dot = T.accent, dotStyle = 'solid', glyph = '◆', active = true }) {
  const fs = 13, h = 30, padX = 12, r = 5, gap = 7;
  const dotSpan = dotStyle === 'solid' || dotStyle === 'ring' ? r * 2 : Math.round(r * 4.2);
  const label = `${glyph}  ${title}`;
  const nameW = measureText(label, fs);
  const w = Math.round(padX + dotSpan + gap + nameW + padX);
  const g = gid('tab');
  const out = [{
    type: 'rectangle', x, y, width: w, height: h,
    strokeColor: active ? T.accent : WIRE.line,
    backgroundColor: active ? '#f3f0ff' : WIRE.paper,
    fillStyle: 'solid', strokeWidth: active ? 2 : 1.5, roundness: true, group: g,
  }];
  out.push(...statusDot({
    x: x + padX + (dotSpan - r * 2) / 2, y: y + h / 2 - r, r, color: dot, style: dotStyle, group: g,
  }));
  out.push({
    type: 'text', x: x + padX + dotSpan + gap, y: y + h / 2 - fs * 0.62, text: label,
    fontSize: fs, color: INK, width: nameW + 4, fontFamily: 5, group: g,
  });
  return box(out, x, y, w, h);
}

/* Yatay çip dizisi */
function strip({ x, y, chips, gap = 10, make = chipEl }) {
  const out = [];
  let cx = x;
  let h = 0;
  for (const c of chips) {
    const el = make(Object.assign({}, c, { x: cx, y }));
    out.push(...el);
    cx += el.w + gap;
    h = Math.max(h, el.h);
  }
  return box(out, x, y, cx - gap - x, h);
}

/* Etiketli tek örnek: nokta + altında adı */
function dotSpec({ x, y, color, style, caption, w = 190 }) {
  const d = statusDot({ x: x + w / 2 - 20, y, r: 10, color, style });
  const t = prose({ x, y: d.y + d.h + 18, width: w, fontSize: 14, text: caption });
  return box([...d, ...t], x, y, w, (t.y + t.h) - y);
}

/* ── Board ───────────────────────────────────────────────────────────────── */
const X = 60;
const els = [];
const P = (a) => els.push(...a);

const s0 = stack({
  x: X, y: 60, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: 'Durum renkleri — bugün ve dört seçenek', fontSize: 46, maxWidth: 1500 }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 17,
      text: 'Şikayet: “buradaki loading state’ler anlaşılmıyor”. Kodda sorun animasyonun zayıflığı değil — üst üste duran iki şeridin iki AYRI renk sözlüğü var, üstelik projenin gerçek yükleniyor hali hiç çizilmiyor.',
    }),
  ],
});
P(s0);

/* ── 0 · Bugün ───────────────────────────────────────────────────────────── */
const s1 = stack({
  x: X, y: s0.nextY + 60, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: '0 · Bugün — ekrandaki hal', fontSize: 30 }),
    (x, y) => stack({
      x, y, gap: 16, items: [
        (a, b) => strip({
          x: a, y: b, chips: [
            { name: 'h-f_dreamcontext', dot: T.neutral, badge: 1, badgeColor: T.neutral },
            { name: 'kitUP dreamcontext', dot: T.accent, badge: 1, badgeColor: T.accent },
            { name: 'dreamcontext', dot: T.neutral, badge: 2, badgeColor: T.neutral, active: true },
          ],
        }),
        (a, b) => strip({ x: a + 40, y: b, make: tabEl, chips: [{ title: 'Chat 19', dot: T.accent }] }),
      ],
    }),
    (x, y) => row({
      x, y, gap: 50, valign: 'top', items: [
        (a, b) => table({
          x: a, y: b, fontSize: 13, maxColW: 210, title: 'İki sözlük, aynı ekranda',
          headers: ['Hal', 'Proje şeridi', 'Sohbet şeridi'],
          rows: [
            ['seni bekliyor', { text: 'kırmızı', color: 'red' }, { text: 'magenta', color: 'red' }],
            ['çalışıyor', { text: 'MOR (accent)', color: 'purple' }, { text: 'yeşil', color: 'green' }],
            ['başlıyor', { text: 'nötr gri', color: 'gray' }, { text: 'turuncu', color: 'yellow' }],
            ['hazır (boşta)', { text: 'nötr gri', color: 'gray' }, { text: 'MOR (accent)', color: 'purple' }],
            ['kayıtlı', { text: 'nötr gri', color: 'gray' }, { text: 'indigo', color: 'blue' }],
            ['bitti', { text: 'nötr gri', color: 'gray' }, { text: 'kırmızı', color: 'red' }],
          ],
        }),
        (a, b) => stack({
          x: a, y: b, gap: 20, items: [
            (c, d) => callout({
              x: c, y: d, w: 660, color: 'red', title: 'Kusur 1 · mor iki zıt şey diyor',
              text: 'Üstteki şeritte accent moru “çalışıyor”, 40px altındaki şeritte aynı mor “boşta”. Aynı hue, ters anlam. (ProjectTabs.css:278 ↔ AgentTerminal.css:708)',
            }),
            (c, d) => callout({
              x: c, y: d, w: 660, color: 'red', title: 'Kusur 2 · loading çizilmiyor',
              text: 'ProjectTabs.css:255 tek satırda dört hali aynı nötr griye eşliyor: hazır / başlıyor / kayıtlı / bitti. Yani PTY+WebSocket bağlanırken proje, ölmüş bir projeyle birebir aynı görünüyor.',
            }),
            (c, d) => callout({
              x: c, y: d, w: 660, color: 'red', title: 'Kusur 3 · renk tek taşıyıcı',
              text: 'Ekranda tek kelime yok — durum metni sadece aria-label’da. Rozet de noktayla aynı rengi tekrar ediyor, yani iki eleman tek kanal taşıyor; “kaçı seni bekliyor” hiçbir yerde yok.',
            }),
          ],
        }),
      ],
    }),
  ],
});
P(s1);

/* ── A ───────────────────────────────────────────────────────────────────── */
const sA = stack({
  x: X, y: s1.nextY + 70, gap: 28, items: [
    (x, y) => sectionTitle({ x, y, text: 'Seçenek A · Tek sözlük, üç anlam', fontSize: 30 }),
    (x, y) => prose({
      x, y, width: 700, fontSize: 16,
      text: 'Haritayı agentStatus.ts’e taşı, iki CSS de oradan beslensin. Şeridin işi triage — altı halin tamamı zaten sekmede ve dock’ta duruyor, şeritte üç anlama iniyor.',
    }),
    (x, y) => row({
      x, y, gap: 50, valign: 'top', items: [
        (a, b) => table({
          x: a, y: b, fontSize: 13, maxColW: 240,
          headers: ['Anlam', 'Kapsadığı haller', 'Renk', 'Hareket'],
          rows: [
            [{ text: 'seni bekliyor', color: 'red' }, 'asking + attention', 'magenta', 'sabit halka'],
            [{ text: 'çalışıyor', color: 'green' }, 'working + starting', 'yeşil', 'dönen yay'],
            [{ text: 'sakin', color: 'gray' }, 'ready + saved + ended', 'nötr', 'yok'],
          ],
        }),
        (a, b) => stack({
          x: a, y: b, gap: 18, items: [
            (c, d) => strip({
              x: c, y: d, chips: [
                { name: 'h-f_dreamcontext', dot: T.neutral },
                { name: 'kitUP', dot: T.success, dotStyle: 'arc', badge: 1, badgeColor: T.neutral },
                { name: 'dreamcontext', dot: T.waiting, dotStyle: 'ring', badge: 2, badgeColor: T.waiting, active: true },
              ],
            }),
            (c, d) => callout({
              x: c, y: d, w: 620, color: 'green', title: 'Kazanç',
              text: 'Renk çakışması kökten biter ve iki şerit tek dilde konuşur. Bedeli: sohbet sekmesi de üç renge iner, altı halin ayrımı sadece tooltip ve dock’ta kalır.',
            }),
          ],
        }),
      ],
    }),
  ],
});
P(sA);

/* ── B ───────────────────────────────────────────────────────────────────── */
const sB = stack({
  x: X, y: sA.nextY + 70, gap: 28, items: [
    (x, y) => sectionTitle({ x, y, text: 'Seçenek B · Loading’i opaklıkla değil, yönle söyle', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 40, valign: 'top', items: [
        (a, b) => dotSpec({ x: a, y: b, color: T.accent, style: 'pulse', caption: 'BUGÜN — opacity 1 ↔ 0,45 nabzı. 8 pikselde ilerleme değil titreme gibi okunuyor.' }),
        (a, b) => dotSpec({ x: a, y: b, color: T.warning, style: 'arc', caption: 'başlıyor — kısa, belirsiz yay. Bir şey bağlanıyor, ne kadar sürdüğü belli değil.' }),
        (a, b) => dotSpec({ x: a, y: b, color: T.success, style: 'arc', caption: 'çalışıyor — 270° dönen yay. Hareketin bir yönü var, o yüzden “ilerliyor” okunuyor.' }),
        (a, b) => dotSpec({ x: a, y: b, color: T.success, style: 'ring', caption: 'reduced-motion — yay durur ama KALIR. Bilgi animasyonun içinde saklanmaz.' }),
      ],
    }),
    (x, y) => callout({
      x, y, w: 900, color: 'green', title: 'Neden yay',
      text: 'Nabız bir hal değişimi değil, sadece parlaklık oynaması: “çalışıyor” ile “bozuk” arasında ayrım kurmuyor. Yayın açısal ilerlemesi ise evrensel olarak süreç okunuyor ve durdurulduğunda bile geriye görünür bir işaret bırakıyor.',
    }),
  ],
});
P(sB);

/* ── C ───────────────────────────────────────────────────────────────────── */
const sC = stack({
  x: X, y: sB.nextY + 70, gap: 28, items: [
    (x, y) => sectionTitle({ x, y, text: 'Seçenek C · Rozet ikinci kanalı taşısın', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 60, valign: 'top', items: [
        (a, b) => stack({
          x: a, y: b, gap: 14, items: [
            (c, d) => prose({ x: c, y: d, width: 420, fontSize: 15, text: 'BUGÜN — nokta ve rozet aynı rengi tekrar eder:' }),
            (c, d) => strip({ x: c, y: d, chips: [{ name: 'dreamcontext', dot: T.accent, badge: 3, badgeColor: T.accent }] }),
            (c, d) => prose({ x: c, y: d, width: 420, fontSize: 15, text: 'ÖNERİ — nokta = en kötü hal, rozet = bekleyen sayısı:' }),
            (c, d) => strip({
              x: c, y: d, chips: [
                { name: 'dreamcontext', dot: T.waiting, dotStyle: 'ring', badge: 1, badgeColor: T.waiting },
                { name: 'kitUP', dot: T.success, dotStyle: 'arc', badge: 3, badgeColor: T.neutral },
              ],
            }),
          ],
        }),
        (a, b) => callout({
          x: a, y: b, w: 620, color: 'blue', title: 'Ne çözüyor',
          text: '“3 canlı ama 1’i seni bekliyor” tek bakışta okunur. Bugün bekleyen sayısı yalnızca bir kerelik zıplamayla söyleniyor — o an ekrana bakmıyorsan bilgi tamamen kayboluyor. waiting = 0 iken rozet nötr canlı sayısına döner.',
        }),
      ],
    }),
  ],
});
P(sC);

/* ── D ───────────────────────────────────────────────────────────────────── */
const sD = stack({
  x: X, y: sC.nextY + 70, gap: 28, items: [
    (x, y) => sectionTitle({ x, y, text: 'Seçenek D · Aktif çipte kelime', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 60, valign: 'top', items: [
        (a, b) => stack({
          x: a, y: b, gap: 16, items: [
            (c, d) => strip({
              x: c, y: d, chips: [
                { name: 'h-f', dot: T.neutral },
                { name: 'kitUP', dot: T.success, dotStyle: 'arc', badge: 1, badgeColor: T.neutral },
                { name: 'dreamcontext', dot: T.success, dotStyle: 'arc', word: 'çalışıyor', badge: 2, badgeColor: T.neutral, active: true },
              ],
            }),
            (c, d) => prose({
              x: c, y: d, width: 560, fontSize: 15,
              text: 'Kelime sadece AKTİF çipte. Pasif çipler nokta + sayı olarak kalır, yani şerit uzamaz ve merkez hizalama bozulmaz.',
            }),
          ],
        }),
        (a, b) => callout({
          x: a, y: b, w: 620, color: 'green', title: 'Neden değer',
          text: 'Renk tek taşıyıcı olmaktan çıkar — WCAG 1.4.1’in istediği şey bu. Renk körlüğünde, düşük parlaklıkta ve reduced-motion açıkken durum hâlâ okunur. Aktif segment zaten geniş, yeni yer istemiyor.',
        }),
      ],
    }),
  ],
});
P(sD);

/* ── Karar ───────────────────────────────────────────────────────────────── */
const sE = stack({
  x: X, y: sD.nextY + 70, gap: 28, items: [
    (x, y) => sectionTitle({ x, y, text: 'Hangisi önce — etki × kolaylık', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 50, valign: 'top', items: [
        (a, b) => quadrant({
          x: a, y: b, w: 520, h: 420,
          xAxis: 'kolaylık →', yAxis: 'etki →',
          quadrantLabels: { tl: 'değerli ama pahalı', tr: 'ÖNCE', bl: 'sonraya', br: 'ucuz kazanç' },
          items: [
            { label: 'A · tek sözlük', x: 0.44, y: 0.94 },
            { label: 'B · yay', x: 0.8, y: 0.82 },
            { label: 'C · rozet', x: 0.84, y: 0.46 },
            { label: 'D · kelime', x: 0.9, y: 0.6 },
          ],
        }),
        (a, b) => stack({
          x: a, y: b, gap: 20, items: [
            (c, d) => table({
              x: c, y: d, fontSize: 13, maxColW: 300,
              headers: ['Seçenek', 'Ne çözer', 'Dokunulan yer'],
              rows: [
                ['A · tek sözlük', 'mor çakışması + görünmez starting', 'agentStatus.ts + 2 CSS'],
                ['B · dönen yay', 'loading okunmuyor', 'ProjectTabs.css, AgentTerminal.css'],
                ['C · rozet kanalı', 'zıplamayı kaçırınca bilgi kaybı', 'ProjectTabs.tsx'],
                ['D · aktif kelime', 'renk tek taşıyıcı (WCAG)', 'ProjectTabs.tsx + .css'],
              ],
            }),
            (c, d) => callout({
              x: c, y: d, w: 660, color: 'purple', title: 'Önerim',
              text: 'A + B birlikte gidiyor: sözlüğü tek yere alırken hareketi de aynı anda düzeltmek, iki şeridi tek seferde aynı dile çeviriyor. Şikayetin karşılığı bu ikisi. C ve D ucuz ve bağımsız — ayrı, küçük bir turda eklenebilir.',
            }),
          ],
        }),
      ],
    }),
  ],
});
P(sE);

buildExcalidraw({
  out: path.resolve(__dirname, 'chip-status.excalidraw.md'),
  name: 'chip-status',
  description: 'Neden dreamcontext masaüstündeki proje çipi ve sohbet sekmesi durumları okunmuyor — üst üste duran iki şeridin çakışan renk sözlükleri, çizilmeyen starting hali, ve bunu düzeltmek için dört seçenek (tek sözlük / dönen yay / rozetin ikinci kanalı / aktif çipte kelime) etki-efor değerlendirmesiyle.',
  tags: ['design', 'desktop', 'excalidraw'],
  elements: els,
});
