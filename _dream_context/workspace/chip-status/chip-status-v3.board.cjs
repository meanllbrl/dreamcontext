/* Design board v3: statü başına TEK baloncuk, içinde sayı, sıfır olan çizilmez.
 * N sohbet → en fazla 3 baloncuk. Yükleme, çalışan baloncuğun çevresinde dönen halka.
 * Regenerate:  node _dream_context/workspace/chip-status/chip-status-v3.board.cjs
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

/* Statü paleti — dolgu açık, yazı/halka koyu, “seni bekliyor” tek dolu olan */
const ST = {
  asking: { fill: '#ff5fc4', text: '#ffffff', ring: '#ff5fc4', word: 'seni bekliyor' },
  working: { fill: '#d3f4de', text: '#12813a', ring: '#1ba94c', word: 'çalışıyor' },
  idle: { fill: '#eceef3', text: '#6b7280', ring: '#c3c6cf', word: 'boşta' },
};
const ORDER = ['asking', 'working', 'idle'];
const ACCENT = '#7b68ee';

/* ── Tek baloncuk: sayı + (çalışıyorsa) çevresinde dönen halka ────────────── */
function bubble({ x, y, count, state, spin = null, scale = 1, group = null }) {
  const s = scale;
  const d = Math.round(20 * s);
  const ringR = Math.round(d / 2 + 4.5 * s);
  const span = spin === null ? d : ringR * 2 + Math.round(3 * s);
  const g = group || gid('bub');
  const p = ST[state];
  const cx = x + span / 2, cy = y + span / 2;
  const out = [];

  if (spin !== null) {
    /* 260°lik yay; `spin` 0..1 başlangıç açısını döndürür */
    const pts = [];
    const start = -Math.PI / 2 + spin * Math.PI * 2;
    for (let i = 0; i <= 26; i++) {
      const a = start + (i / 26) * (Math.PI * 2 * 0.72);
      pts.push([cx + ringR * Math.cos(a), cy + ringR * Math.sin(a)]);
    }
    out.push({
      type: 'line', points: pts, strokeColor: p.ring,
      strokeWidth: Math.max(2, Math.round(2.4 * s)), group: g,
    });
  }
  out.push({
    type: 'ellipse', x: cx - d / 2, y: cy - d / 2, width: d, height: d,
    strokeColor: p.fill, backgroundColor: p.fill, fillStyle: 'solid',
    strokeWidth: 1, group: g,
  });
  const fs = Math.round(11 * s);
  out.push({
    type: 'text', x: cx - d / 2, y: cy - fs * 0.58, text: String(count), fontSize: fs,
    color: p.text, width: d, align: 'center', fontFamily: 5, group: g,
  });
  return box(out, x, y, span, span);
}

/* Baloncuk kümesi — sıfır olan statü hiç çizilmez */
function bubbles({ x, y, counts, spin = null, scale = 1, group = null }) {
  const gap = Math.round(5 * scale);
  const live = ORDER.filter((st) => counts[st]);
  // Halkalı baloncuğun kapladığı alan daha geniş — her baloncuğu kendi alanı içinde
  // dikey ortalamazsak daireler farklı hizalarda oturur ve satır eğri okunur.
  const maxSpan = Math.max(0, ...live.map((st) => bubble({
    x: 0, y: 0, count: 1, state: st, scale,
    spin: st === 'working' && spin !== null ? spin : null,
  }).h));
  const out = [];
  let cx = x;
  for (const st of live) {
    const el = bubble({
      x: cx, y, count: counts[st], state: st, scale, group,
      spin: st === 'working' && spin !== null ? spin : null,
    });
    const dy = (maxSpan - el.h) / 2;
    out.push(...el.map((e) => Object.assign({}, e, {
      y: e.y + dy,
      points: e.points ? e.points.map(([px, py]) => [px, py + dy]) : undefined,
    })));
    cx += el.w + gap;
  }
  return box(out, x, y, Math.max(0, cx - gap - x), maxSpan);
}

/* ── Çip ─────────────────────────────────────────────────────────────────── */
function chipV3({
  x, y, name, counts = {}, spin = null, active = false, scale = 1, bar = false,
}) {
  const s = scale;
  const fs = Math.round(13 * s);
  const padX = Math.round(12 * s);
  const gap = Math.round(9 * s);
  const g = gid('chip');
  const probe = bubbles({ x: 0, y: 0, counts, spin, scale });
  const h = Math.round((bar ? 40 : 34) * s);
  const nameW = measureText(name, fs);
  const w = Math.round(padX + nameW + (probe.w ? gap + probe.w : 0) + padX);
  const rowY = bar ? y + Math.round(4 * s) : y + h / 2 - probe.h / 2;
  const out = [];

  out.push({
    type: 'rectangle', x, y, width: w, height: h,
    strokeColor: active ? ACCENT : WIRE.line,
    backgroundColor: active ? '#f3f0ff' : WIRE.paper,
    fillStyle: 'solid', strokeWidth: active ? 2 : 1.5, roundness: true, group: g,
  });
  out.push({
    type: 'text', x: x + padX, y: rowY + probe.h / 2 - fs * 0.62, text: name,
    fontSize: fs, color: INK, width: nameW + 6, fontFamily: 5, group: g,
  });
  out.push(...bubbles({ x: x + padX + nameW + gap, y: rowY, counts, spin, scale, group: g }));

  if (bar) {
    const N = ORDER.reduce((a, k) => a + (counts[k] || 0), 0) || 1;
    const bw = w - padX * 2;
    const bh = Math.round(5 * s);
    const by = y + h - Math.round(10 * s);
    let cx = x + padX;
    for (const st of ORDER) {
      const n = counts[st] || 0;
      if (!n) continue;
      const sw = Math.round((bw * n) / N);
      out.push({
        type: 'rectangle', x: cx, y: by, width: sw, height: bh,
        strokeColor: ST[st].ring, backgroundColor: ST[st].ring, fillStyle: 'solid',
        strokeWidth: 1, roundness: true, group: g,
      });
      cx += sw;
    }
  }
  return box(out, x, y, w, h);
}

function strip({ x, y, chips, gap = 12 }) {
  const out = [];
  let cx = x, h = 0;
  for (const c of chips) {
    const el = chipV3(Object.assign({}, c, { x: cx, y }));
    out.push(...el);
    cx += el.w + gap;
    h = Math.max(h, el.h);
  }
  return box(out, x, y, cx - gap - x, h);
}

/* Etiketli örnek satırı: çip + sağında açıklama */
function caseRow({ x, y, chip, label, labelW = 300 }) {
  const el = chipV3(Object.assign({}, chip, { x, y }));
  const t = {
    type: 'text', x: x + el.w + 20, y: y + el.h / 2 - 9, text: label,
    fontSize: 14, color: WIRE.hint, width: labelW, fontFamily: 5,
  };
  return box([...el, t], x, y, el.w + 20 + labelW, el.h);
}

/* Animasyonu durağan anlatmak: kareler */
function filmstrip({ x, y, make, frames, labels, gap = 30 }) {
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
  });
  return box(out, x, y, cx - gap - x, h);
}

/* Üstüne gelince açılan liste — statüye göre gruplu */
function peek({ x, y, groups, w = 330 }) {
  const g = gid('peek');
  const rh = 30, gh = 26, padY = 10;
  let h = padY * 2;
  groups.forEach((gr) => { h += gh + gr.rows.length * rh; });
  const out = [{
    type: 'rectangle', x, y, width: w, height: h, strokeColor: ACCENT,
    backgroundColor: '#ffffff', fillStyle: 'solid', strokeWidth: 2, roundness: true, group: g,
  }];
  let cy = y + padY;
  groups.forEach((gr) => {
    out.push(...bubble({ x: x + 12, y: cy + 2, count: gr.rows.length, state: gr.state, scale: 0.85, group: g }));
    out.push({
      type: 'text', x: x + 42, y: cy + 4, text: ST[gr.state].word, fontSize: 12,
      color: gr.state === 'idle' ? '#6b7280' : ST[gr.state].ring,
      width: 200, fontFamily: 5, group: g,
    });
    cy += gh;
    gr.rows.forEach((r) => {
      out.push({
        type: 'text', x: x + 42, y: cy + rh / 2 - 8, text: r, fontSize: 13,
        color: INK, width: w - 60, fontFamily: 5, group: g,
      });
      cy += rh;
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
  x: X, y: 60, gap: 28, items: [
    (x, y) => sectionTitle({ x, y, text: 'Statü başına tek baloncuk — sayı içinde, sıfır olan yok', fontSize: 42, maxWidth: 1500 }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 17,
      text: 'Kural tek cümle: aynı haldeki sohbetler tek baloncukta toplanır, baloncuğun içindeki sayı kaç tane olduğunu söyler, o halde hiç sohbet yoksa baloncuk hiç çizilmez. Yani üç hal var, en fazla üç baloncuk — sohbet sayısı ne olursa olsun.',
    }),
  ],
});
P(s0);

/* ── 1 · Kural, büyütülmüş ───────────────────────────────────────────────── */
const anat = (() => {
  const bx = X, by = s0.nextY + 100;
  const el = chipV3({
    x: bx, y: by, name: 'dreamcontext', scale: BIG, spin: 0.15,
    counts: { asking: 1, working: 2, idle: 3 },
  });
  const out = [...el];
  const cy = by + el.h;
  const anchors = [
    ['1 soru soran — tek dolu baloncuk, en solda', 0.53],
    ['2 çalışan — çevresinde halka döner', 0.70],
    ['3 boşta — sessiz gri', 0.87],
  ];
  anchors.forEach(([text, frac], i) => {
    const ax = bx + el.w * frac;
    const ty = cy + 46 + i * 34;
    out.push(...connector({
      from: [ax, cy + 4], to: [bx + el.w + 40, ty + 8], elbow: 'vh', strokeWidth: 1.4,
    }));
    out.push({
      type: 'text', x: bx + el.w + 52, y: ty, text, fontSize: 15,
      color: WIRE.text, width: 420, fontFamily: 5,
    });
  });
  return box(out, bx, by, el.w + 52 + 420, (cy + 46 + 3 * 34) - by);
})();
P(anat);

/* ── 2 · Ölçek kanıtı ────────────────────────────────────────────────────── */
const s2 = stack({
  x: X, y: anat.y + anat.h + 60, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: '1 · Kaç sohbet olursa olsun en fazla üç baloncuk', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 70, valign: 'top', items: [
        (a, b) => stack({
          x: a, y: b, gap: 14, items: [
            (c, d) => caseRow({ x: c, y: d, label: '1 sohbet, boşta', chip: { name: 'dreamcontext', scale: 1.6, counts: { idle: 1 } } }),
            (c, d) => caseRow({ x: c, y: d, label: '3 sohbet, ikisi çalışıyor', chip: { name: 'dreamcontext', scale: 1.6, spin: 0.15, counts: { working: 2, idle: 1 } } }),
            (c, d) => caseRow({ x: c, y: d, label: '10 sohbet, biri seni bekliyor', chip: { name: 'dreamcontext', scale: 1.6, spin: 0.15, counts: { asking: 1, working: 4, idle: 5 } } }),
            (c, d) => caseRow({ x: c, y: d, label: '24 sohbet — çip yine aynı boyda', chip: { name: 'dreamcontext', scale: 1.6, spin: 0.15, counts: { asking: 2, working: 9, idle: 13 } } }),
          ],
        }),
        (a, b) => stack({
          x: a, y: b, gap: 18, items: [
            (c, d) => callout({
              x: c, y: d, w: 600, color: 'green', title: 'Kazandığın şey',
              text: 'Sohbet sayısı arttıkça çip büyümüyor — sadece baloncukların içindeki sayı büyüyor. On sohbetle on nokta yan yana dizilmesi derdi tamamen ortadan kalkıyor, üstelik “kaç var” ile “kaçı ne halde” aynı anda okunuyor.',
            }),
            (c, d) => callout({
              x: c, y: d, w: 600, color: 'blue', title: 'Sıra sabit',
              text: 'Baloncuklar hep aynı sırada: seni bekleyen · çalışan · boşta. Sayılar değişince yer değiştirmiyorlar, çünkü sıra sayıya değil hale bağlı — böylece göz her seferinde aynı yere bakıyor.',
            }),
          ],
        }),
      ],
    }),
  ],
});
P(s2);

/* ── 3 · Yükleme halkası ─────────────────────────────────────────────────── */
const s3 = stack({
  x: X, y: s2.nextY + 60, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: '2 · Yükleme — çalışan baloncuğun çevresinde dönen halka', fontSize: 30 }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 16,
      text: 'Halka tek: on sohbet çalışsa da dönen tek bir halka var, çünkü halka sohbetin değil BALONCUĞUN. Böylece “çalışıyor” dediğin an gerçekten dönen bir şey görüyorsun, ama on ayrı çember dönmüyor.',
    }),
    (x, y) => filmstrip({
      x, y, frames: [0, 0.25, 0.5, 0.75],
      labels: ['0,0 sn', '0,3 sn', '0,6 sn', '0,9 sn'],
      make: (cx, cy, f) => bubble({ x: cx, y: cy, count: 2, state: 'working', spin: f, scale: 2.6 }),
    }),
    (x, y) => row({
      x, y, gap: 44, valign: 'top', items: [
        (a, b) => callout({
          x: a, y: b, w: 600, color: 'green', title: 'Neden burada işe yarıyor',
          text: 'Halkanın çapı baloncuğun çapından büyük, yani hareket eden şey 30 piksel — 8 piksellik bir noktanın parlaklık oynamasından bambaşka bir görünürlük. Ayrıca sadece çalışan baloncukta var: dönen bir şey görüyorsan gerçekten bir şey çalışıyor demektir.',
        }),
        (a, b) => callout({
          x: a, y: b, w: 600, color: 'yellow', title: 'Bekleyen ve boşta olan dönmez',
          text: 'Seni bekleyen baloncuk dolu magenta ve sabit — dikkat çekmesi hareketten değil, tek dolu renk olmasından geliyor. Boştaki gri ise tamamen sessiz. Aynı anda birden çok şeyin kıpırdaması dikkati böler.',
        }),
      ],
    }),
  ],
});
P(s3);

/* ── 4 · Alt şerit opsiyonu ──────────────────────────────────────────────── */
const s4 = stack({
  x: X, y: s3.nextY + 60, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: '3 · Altta şerit — eklenir mi', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 60, valign: 'top', items: [
        (a, b) => stack({
          x: a, y: b, gap: 20, items: [
            (c, d) => caseRow({ x: c, y: d, labelW: 200, label: 'sadece baloncuklar', chip: { name: 'dreamcontext', scale: 1.8, spin: 0.15, counts: { asking: 1, working: 4, idle: 5 } } }),
            (c, d) => caseRow({ x: c, y: d, labelW: 200, label: 'baloncuklar + alt şerit', chip: { name: 'dreamcontext', scale: 1.8, spin: 0.15, bar: true, counts: { asking: 1, working: 4, idle: 5 } } }),
          ],
        }),
        (a, b) => callout({
          x: a, y: b, w: 620, color: 'red', title: 'Bence eklenmemeli',
          text: 'Şerit, baloncukların zaten sayıyla söylediği şeyi bir kez daha oran olarak söylüyor — aynı bilgi iki kanalda. Karşılığında çip 10 piksel uzuyor ve alt kenar dolduğu için ileride oraya gerçek bir ilerleme çubuğu koyma imkânı kapanıyor. Baloncuklar sayıyı verdiği sürece şeridin ekleyeceği bir şey yok.',
        }),
      ],
    }),
  ],
});
P(s4);

/* ── 5 · Gerçek şerit ────────────────────────────────────────────────────── */
const s5 = stack({
  x: X, y: s4.nextY + 60, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: '4 · Üç proje, gerçek boyutta', fontSize: 30 }),
    (x, y) => strip({
      x, y, chips: [
        { name: 'h-f_dreamcontext', counts: { idle: 1 } },
        { name: 'kitUP dreamcontext', spin: 0.15, counts: { working: 1 } },
        { name: 'dreamcontext', active: true, spin: 0.15, counts: { asking: 1, working: 2, idle: 3 } },
      ],
    }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 16,
      text: 'Ekran görüntündeki şeridin aynısı, yeni kuralla. Soldaki iki proje sakin duruyor; sağdaki aktif projede bir sohbet seni bekliyor, iki tanesi çalışıyor, üçü boşta — ve bunu okumak için hiçbir yere tıklaman gerekmiyor.',
    }),
  ],
});
P(s5);

/* ── 6 · Hangisi olduğu ──────────────────────────────────────────────────── */
const s6 = stack({
  x: X, y: s5.nextY + 60, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: '5 · Hangi sohbet olduğu — baloncuğa gelince', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 60, valign: 'top', items: [
        (a, b) => stack({
          x: a, y: b, gap: 8, items: [
            (c, d) => chipV3({
              x: c, y: d, name: 'dreamcontext', scale: 1.6, spin: 0.15, active: true,
              counts: { asking: 1, working: 2, idle: 3 },
            }),
            (c, d) => peek({
              x: c, y: d + 8, w: 340, groups: [
                { state: 'asking', rows: ['Chat 19'] },
                { state: 'working', rows: ['Chat 21', 'sleep-tasks'] },
                { state: 'idle', rows: ['Chat 12', 'Chat 15', 'terminal'] },
              ],
            }),
          ],
        }),
        (a, b) => callout({
          x: a, y: b, w: 620, color: 'blue', title: 'Baloncuk toplar, liste açar',
          text: 'Baloncuk “kaç” sorusunu cevaplıyor, “hangisi” sorusunu ise üstüne gelince açılan liste. Liste de aynı sırayla gruplu, yani baloncuklarla birebir aynı yapı — gözün öğrendiği düzen bozulmuyor. Baloncuğa tıklamak o gruptaki ilk sohbete götürür.',
        }),
      ],
    }),
  ],
});
P(s6);

/* ── 7 · Kararlar ────────────────────────────────────────────────────────── */
const s7 = stack({
  x: X, y: s6.nextY + 60, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: '6 · Kapatılması gereken sorular', fontSize: 30 }),
    (x, y) => table({
      x, y, fontSize: 14, maxColW: 420,
      headers: ['Soru', 'Önerim'],
      rows: [
        ['“başlıyor” hali nereye?', 'Çalışan baloncuğa katılır — halka zaten dönüyor, ayrı bir baloncuk dördüncü hal demek olur'],
        ['“bitti / kayıtlı” sohbetler?', 'Boşta baloncuğuna girmez, hiç sayılmaz — canlı olmayan şey “var” diye sayılmamalı'],
        ['Hiç sohbet yoksa?', 'Tek bir baloncuk bile çizilmez; çip sadece proje adı olur'],
        ['Tek sohbet varsa sayı yazsın mı?', 'Yazsın — “1” tutarlı, sayının bazen olup bazen olmaması okumayı bozar'],
        ['Sayı iki haneye çıkarsa?', 'Baloncuk elipse dönüşür, yükseklik sabit kalır (13 gibi)'],
        ['Zıplama kalsın mı?', 'Kalsın ama sadece bekleyen baloncuk 0→1 olduğunda, bir kez'],
      ],
    }),
  ],
});
P(s7);

buildExcalidraw({
  out: path.resolve(__dirname, 'chip-status-v3.excalidraw.md'),
  name: 'chip-status-v3',
  description: 'dreamcontext proje çipinin sohbet durumunu statü başına tek baloncukla göstermesi: aynı haldeki sohbetler tek baloncukta toplanır, içindeki sayı adedi verir, sıfır olan hal hiç çizilmez, çalışan baloncuğun çevresinde tek bir yükleme halkası döner. Ölçek kanıtı, alt şerit değerlendirmesi, üstüne gelince açılan gruplu liste ve kapatılacak kararlar.',
  tags: ['design', 'desktop', 'excalidraw'],
  elements: els,
});
