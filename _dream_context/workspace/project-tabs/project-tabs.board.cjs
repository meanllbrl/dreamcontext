/* Design board: one window, many projects — the title-bar project chip bar.
 * Regenerate:  node _dream_context/workspace/project-tabs/project-tabs.board.cjs
 */
const path = require('path');
const SKILL = path.resolve(__dirname, '../../../.claude/skills/excalidraw/scripts');
const { buildExcalidraw } = require(path.join(SKILL, 'build_excalidraw.js'));
const S = require(path.join(SKILL, 'lib/style.js'));
const C = require(path.join(SKILL, 'lib/charts.js'));
const W = require(path.join(SKILL, 'lib/wireframe.js'));

const {
  PALETTE, WIRE, INK, pal, measureText, box, stack, row,
  sectionTitle, prose, bullets, card, connector, windowFrame, divider,
} = S;
const { callout, table } = C;

let GID = 0;
const gid = (p) => `${p}-${++GID}`;

// ── a project chip: status dot · name · attention badge · close ───────────────
function projChip({ x, y, name, active = false, dot = 'gray', count = 0, close = true, scale = 1 }) {
  const fs = Math.round(13 * scale);
  const h = Math.round(30 * scale);
  const padX = Math.round(12 * scale);
  const dotR = Math.round(5 * scale);
  const gap = Math.round(8 * scale);
  const badgeW = count ? Math.round(20 * scale) : 0;
  const closeW = close ? Math.round(12 * scale) : 0;
  const nameW = measureText(name, fs);
  const w = Math.round(
    padX + dotR * 2 + gap + nameW + (count ? gap + badgeW : 0) + (close ? gap + closeW : 0) + padX,
  );
  const p = pal(active ? 'purple' : 'gray');
  const g = gid('chip');
  const out = [];
  out.push({
    type: 'rectangle', x, y, width: w, height: h,
    strokeColor: active ? p.stroke : WIRE.line,
    backgroundColor: active ? p.fill : WIRE.paper,
    fillStyle: 'solid', strokeWidth: active ? 2 : 1.5, roundness: true, group: g,
  });
  let cx = x + padX;
  const dc = pal(dot);
  out.push({
    type: 'ellipse', x: cx, y: y + h / 2 - dotR, width: dotR * 2, height: dotR * 2,
    strokeColor: dc.stroke, backgroundColor: dot === 'gray' ? WIRE.line : dc.stroke,
    fillStyle: 'solid', strokeWidth: 1, group: g,
  });
  cx += dotR * 2 + gap;
  out.push({
    type: 'text', x: cx, y: y + h / 2 - fs * 0.62, text: name, fontSize: fs,
    color: active ? INK : WIRE.text, width: nameW + 4, fontFamily: 5, group: g,
  });
  cx += nameW + gap;
  if (count) {
    const bh = Math.round(18 * scale);
    out.push({
      type: 'ellipse', x: cx, y: y + h / 2 - bh / 2, width: badgeW, height: bh,
      strokeColor: PALETTE.red.stroke, backgroundColor: PALETTE.red.stroke,
      fillStyle: 'solid', strokeWidth: 1, group: g,
    });
    out.push({
      type: 'text', x: cx, y: y + h / 2 - fs * 0.58, text: String(count),
      fontSize: Math.round(11 * scale), color: '#ffffff', width: badgeW, align: 'center',
      fontFamily: 5, group: g,
    });
    cx += badgeW + gap;
  }
  if (close) {
    out.push({
      type: 'text', x: cx, y: y + h / 2 - fs * 0.62, text: '×', fontSize: fs,
      color: WIRE.hint, width: closeW, align: 'center', fontFamily: 5, group: g,
    });
  }
  return box(out, x, y, w, h);
}

// the "+" button at the end of the chip strip
function plusChip({ x, y, scale = 1 }) {
  const s = Math.round(30 * scale);
  const g = gid('plus');
  return box([
    {
      type: 'rectangle', x, y, width: s, height: s, strokeColor: WIRE.line,
      backgroundColor: WIRE.paper, fillStyle: 'solid', strokeWidth: 1.5, roundness: true, group: g,
    },
    {
      type: 'text', x, y: y + s / 2 - 9 * scale, text: '+', fontSize: Math.round(17 * scale),
      color: WIRE.text, width: s, align: 'center', fontFamily: 5, group: g,
    },
  ], x, y, s, s);
}

// Lay a chip strip (chips + the trailing "+") out CENTERED in a bar of width `w`
// starting at `x`, clamped so it never slides under the macOS traffic lights.
function chipStrip({ x, y, w, chips, gap = 8, lights = 86 }) {
  const measured = chips.map((c) => projChip(Object.assign({ x: 0, y: 0 }, c)));
  const plusW = 30;
  const stripW = measured.reduce((s, e) => s + e.w + gap, 0) + plusW;
  const startX = Math.max(x + lights, x + Math.round((w - stripW) / 2));
  let cx = startX;
  const out = [];
  for (const c of chips) {
    const el = projChip(Object.assign({}, c, { x: cx, y }));
    out.push(...el);
    cx += el.w + gap;
  }
  const plus = plusChip({ x: cx, y });
  out.push(...plus);
  const res = box(out, startX, y, stripW, 30);
  res.plusX = plus.x;
  return res;
}

// ── a mac-ish app window whose title bar carries the chip strip ──────────────
function tabWindow({ x, y, w, h, chips, body, dropdown = null }) {
  const BAR = 52;
  const out = [];
  const frame = windowFrame({ x, y, w, h, kind: 'app', bar: BAR, title: '' });
  out.push(...frame);

  const cy = y + (BAR - 30) / 2;
  const strip = chipStrip({ x, y: cy, w, chips });
  out.push(...strip);
  const plus = { x: strip.plusX };

  // body: a thin rail + the active project's name, so switching is legible
  const inner = frame.inner;
  out.push({
    type: 'rectangle', x: inner.x, y: inner.y, width: 62, height: inner.h,
    strokeColor: WIRE.line, backgroundColor: WIRE.fill, fillStyle: 'solid',
    strokeWidth: 1.5, roundness: true,
  });
  out.push(...W.textRows({ x: inner.x + 14, y: inner.y + 20, w: 34, rows: 5, lineH: 8, gap: 14 }));
  // With the palette open the body is covered by it — drawing content underneath
  // would be an overlap the eye reads as a bug (and the audit as one too).
  if (!dropdown) {
    out.push({
      type: 'text', x: inner.x + 90, y: inner.y + 30, text: body,
      fontSize: 19, color: WIRE.text, width: inner.w - 110, fontFamily: 5,
    });
    out.push(...W.textRows({ x: inner.x + 90, y: inner.y + 76, w: inner.w - 140, rows: 4, lineH: 15, gap: 15 }));
  }

  if (dropdown) {
    const dw = 340, dh = 218;
    const dx = Math.min(plus.x - 60, x + w - dw - 24);
    const dy = y + BAR + 10;
    out.push({
      type: 'rectangle', x: dx, y: dy, width: dw, height: dh, strokeColor: PALETTE.purple.stroke,
      backgroundColor: '#ffffff', fillStyle: 'solid', strokeWidth: 2, roundness: true,
    });
    out.push(...W.searchField({ x: dx + 12, y: dy + 12, w: dw - 24, placeholder: 'Go to project…' }));
    let ry = dy + 62;
    for (const r of dropdown) {
      out.push(...W.listRow({
        x: dx + 8, y: ry, w: dw - 16, h: 38,
        title: r.title, subtitle: r.sub, trailing: r.hint,
      }));
      ry += 38;
    }
  }
  return box(out, x, y, w, h);
}

// a horizontal flow of cards with arrows between them
function flow({ x, y, items, cw = 250, ch = 104, gap = 78 }) {
  const out = [];
  items.forEach((it, i) => {
    const bx = x + i * (cw + gap);
    out.push(...card({ x: bx, y, w: cw, h: ch, text: it.text, color: it.color, fontSize: 15 }));
    if (i > 0) {
      out.push(...connector({
        from: [bx - gap, y + ch / 2], to: [bx - 8, y + ch / 2], strokeWidth: 2,
      }));
    }
  });
  return box(out, x, y, items.length * cw + (items.length - 1) * gap, ch);
}

// ── the board ────────────────────────────────────────────────────────────────
const X = 60;
const els = [];
const P = (a) => els.push(...a);

const s1 = stack({
  x: X, y: 60, gap: 34, items: [
    (x, y) => sectionTitle({ x, y, text: 'Tek pencere, çok proje — title-bar project chips', fontSize: 46, maxWidth: 1500 }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 17,
      text: 'Bugün her proje kendi OS penceresinde açılıyor. İstenen: pencerenin üst şeridinde çip olarak duran projeler, aralarında tek tıkla geçiş, ve arka plandaki bir projede chat soru sorduğunda o çipin zıplayıp bekleyen soru sayısını göstermesi. Çoklu pencere kaybolmuyor — kaçış kapısı olarak kalıyor.',
    }),
  ],
});
P(s1);

// ── 1 · three states ─────────────────────────────────────────────────────────
const WINW = 660, WINH = 400;
const capW = WINW;

const stateCol = (mk, caption) => (x, y) => stack({
  x, y, gap: 18, items: [
    (xx, yy) => mk(xx, yy),
    (xx, yy) => prose({ x: xx, y: yy, width: capW, fontSize: 15, text: caption }),
  ],
});

const s2 = stack({
  x: X, y: s1.nextY + 70, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: '1 · Üç durum', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 56, valign: 'top', items: [
        stateCol((xx, yy) => tabWindow({
          x: xx, y: yy, w: WINW, h: WINH, body: 'dreamcontext · Tasks',
          chips: [{ name: 'dreamcontext', active: true, dot: 'purple', close: false }],
        }), 'Tek proje açık — bugünkü pencere, sadece başlığı çip oldu. Aktif çip DOLU ve seçili. Yanındaki + yeni sekme açar.'),

        stateCol((xx, yy) => tabWindow({
          x: xx, y: yy, w: WINW, h: WINH, body: 'dreamcontext · Tasks',
          chips: [{ name: 'dreamcontext', active: true, dot: 'purple', close: false }],
          dropdown: [
            { title: 'Launcher', sub: 'home', hint: '←' },
            { title: 'dreamcontext', sub: '~/projects/dreamcontext', hint: 'current' },
            { title: 'tilki', sub: '~/projects/tilki', hint: '⌘2' },
          ],
        }), '+ basıldığında açılan şey ⌘P’nin ta kendisi — aynı ProjectSwitcher. Tek fark: seçim yeni OS penceresi açmıyor, bu pencereye çip ekliyor.'),

        stateCol((xx, yy) => tabWindow({
          x: xx, y: yy, w: WINW, h: WINH, body: 'tilki · Lab',
          chips: [
            { name: 'dreamcontext', active: false, dot: 'red', count: 4 },
            { name: 'tilki', active: true, dot: 'purple' },
          ],
        }), 'İki proje aynı pencerede CANLI. Arka plandaki dreamcontext’te 4 chat cevap bekliyor: çipin noktası kırmızıya döner, rozet sayıyı verir, çip bir kez zıplar.'),
      ],
    }),
  ],
});
P(s2);

// ── 2 · centred alignment, and the shift it costs ────────────────────────────
// A bare title bar (no window body) so the two rows can be compared directly.
function barOnly({ x, y, w, chips, label }) {
  const BAR = 52;
  const out = [{
    type: 'rectangle', x, y, width: w, height: BAR, strokeColor: WIRE.edge,
    backgroundColor: WIRE.chrome, fillStyle: 'solid', strokeWidth: 2, roundness: true,
  }];
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => out.push({
    type: 'ellipse', x: x + 16 + i * 20, y: y + BAR / 2 - 5, width: 10, height: 10,
    strokeColor: c, backgroundColor: c, fillStyle: 'solid', strokeWidth: 1,
  }));
  const strip = chipStrip({ x, y: y + (BAR - 30) / 2, w, chips });
  out.push(...strip);
  out.push({
    type: 'text', x: x + w + 16, y: y + BAR / 2 - 9, text: label, fontSize: 14,
    color: WIRE.text, width: 150, fontFamily: 5,
  });
  const res = box(out, x, y, w + 170, BAR);
  res.firstChipX = strip.x;
  return res;
}

const BARW = 620;
const barA = barOnly({
  x: X, y: 0, w: BARW, label: 'iki çip',
  chips: [{ name: 'dreamcontext', active: true, dot: 'purple' }, { name: 'tilki', dot: 'gray' }],
});
const barB = barOnly({
  x: X, y: 0, w: BARW, label: 'üçüncüsü eklendi',
  chips: [
    { name: 'dreamcontext', active: true, dot: 'purple' },
    { name: 'tilki', dot: 'gray' },
    { name: 'kasa', dot: 'red', count: 2 },
  ],
});
const shift = barA.firstChipX - barB.firstChipX;

const s2b = stack({
  x: X, y: s2.nextY + 70, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: '2 · Merkez hizalama — evet, ama iki kuralla', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 70, valign: 'top', items: [
        (xx, yy) => {
          const a = barOnly({
            x: xx, y: yy, w: BARW, label: 'iki çip',
            chips: [{ name: 'dreamcontext', active: true, dot: 'purple' }, { name: 'tilki', dot: 'gray' }],
          });
          const b = barOnly({
            x: xx, y: yy + 96, w: BARW, label: 'üçüncüsü eklendi',
            chips: [
              { name: 'dreamcontext', active: true, dot: 'purple' },
              { name: 'tilki', dot: 'gray' },
              { name: 'kasa', dot: 'red', count: 2 },
            ],
          });
          const out = [...a, ...b];
          out.push(...connector({
            from: [a.firstChipX, yy + 62], to: [b.firstChipX, yy + 84],
            strokeColor: PALETTE.red.stroke, strokeWidth: 2, dashed: true,
            label: `${Math.abs(shift)}px kayıyor`, fontSize: 13, labelColor: PALETTE.red.stroke,
          }));
          return box(out, xx, yy, BARW + 170, 96 + 52);
        },
        (xx, yy) => callout({
          x: xx, y: yy, w: 600, color: 'yellow', title: 'Kayma bedeli',
          text: 'Merkezde her ekleme/kapatma tüm şeridi kaydırır. × üstündeyken komşu çip parmağın altına gelir → yanlışlıkla ikinci kapatma. Tarayıcılar bu yüzden sekmeleri sola hizalar.',
        }),
      ],
    }),
    (x, y) => row({
      x, y, gap: 40, items: [
        (xx, yy) => callout({
          x: xx, y: yy, w: 600, color: 'green', title: 'Kural 1 · etkileşimde dondur',
          text: 'İmleç şeridin içindeyken yerleşim sabitlenir; kapatılan çipin yeri boş kalır. İmleç ayrılınca yeniden ortalanır (Chrome’un sekme genişliği dondurması).',
        }),
        (xx, yy) => callout({
          x: xx, y: yy, w: 600, color: 'green', title: 'Kural 2 · sığmayınca sola geç',
          text: 'Şerit sağdaki kontrol kümesine değene kadar ortada. Değdiği anda sola sabitlenir ve yatay kaydırmaya döner — kırpılmış bir merkez şerit asimetrik görünür.',
        }),
      ],
    }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 16,
      text: 'Merkez zaten bugünkü Header’ın davranışı: vault adı orada duruyor, çip şeridi onun yerine geçiyor. Traffic-light’lar solda 86px yer tuttuğu için şerit gerçek pencere merkezine değil, o eşiğe kenetlenmiş merkeze oturur.',
    }),
  ],
});
P(s2b);

// ── 3 · chip anatomy ─────────────────────────────────────────────────────────
const s3 = stack({
  x: X, y: s2b.nextY + 70, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: '3 · Çip anatomisi', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 70, valign: 'top', items: [
        (xx, yy) => stack({
          x: xx, y: yy, gap: 26, items: [
            (a, b) => projChip({ x: a, y: b, name: 'dreamcontext', active: true, dot: 'red', count: 4, scale: 2.2 }),
            (a, b) => bullets({
              x: a, y: b, width: 560, fontSize: 16, items: [
                'Durum noktası — gri: sakin · mor: agent çalışıyor · kırmızı: seni bekliyor',
                'Proje adı — vault adı, ⌘P’dekiyle birebir aynı',
                'Rozet — SAYI: projedeki aktif chat adedi · RENK: bekleyen varsa kırmızı, çalışan varsa mor',
                '× — sekmeyi kapatır; proje kapanmaz, oturumları uykuya alır',
                'Aktif çip dolu + çerçeveli; diğerleri sade kontur',
              ],
            }),
          ],
        }),
        (xx, yy) => stack({
          x: xx, y: yy, gap: 22, items: [
            (a, b) => prose({ x: a, y: b, width: 420, fontSize: 16, text: 'Üç durum, tek şerit:' }),
            (a, b) => row({
              x: a, y: b, gap: 16, items: [
                (c, d) => projChip({ x: c, y: d, name: 'sozluk', dot: 'gray' }),
                (c, d) => projChip({ x: c, y: d, name: 'tilki', dot: 'purple' }),
                (c, d) => projChip({ x: c, y: d, name: 'kasa', dot: 'red', count: 3 }),
              ],
            }),
            (a, b) => bullets({
              x: a, y: b, width: 420, fontSize: 15, items: [
                'sakin — hiçbir şey olmuyor',
                'çalışıyor — nokta mor, nabız atar, rozet yok',
                'seni bekliyor — nokta kırmızı, rozet sayar, çip zıplar',
              ],
            }),
          ],
        }),
      ],
    }),
  ],
});
P(s3);

// ── 3 · attention pipeline ───────────────────────────────────────────────────
const s4 = stack({
  x: X, y: s3.nextY + 70, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: '4 · Dikkat sinyali nereden geliyor', fontSize: 30 }),
    (x, y) => flow({
      x, y, items: [
        { text: 'ChatSession\nasking / attention', color: 'yellow' },
        { text: 'AgentSurface roster\nprojenin özeti', color: 'blue' },
        { text: 'ProjectTabs bus\npencere seviyesi', color: 'purple' },
        { text: 'Çip\nnokta + rozet + zıplama', color: 'red' },
      ],
    }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 16,
      text: 'Bu sinyal zaten var: agentSession.ts ve chatSession.ts her oturum için asking/attention tutuyor, AgentTabs bunu sekme rozetiyle gösteriyor. Yeni olan tek şey, bu özeti proje seviyesine toplayıp pencerenin çip şeridine yayınlamak.',
    }),
  ],
});
P(s4);

// ── 4 · today's architecture + the hard constraint ───────────────────────────
const s5 = stack({
  x: X, y: s4.nextY + 70, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: '5 · Bugünkü mimari — işi zorlaştıran altı şey', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 60, valign: 'top', items: [
        (xx, yy) => S.column({
          x: xx, y: yy, color: 'red', w: 420, h: 74, fontSize: 15, items: [
            { text: '?vault= modül yüklenirken BİR kez okunuyor  (App.tsx)' },
            { text: 'activeVault tek bir modül değişkeni  (api/client.ts)' },
            { text: 'Tek QueryClient — query key’lerinde vault yok' },
            { text: 'localStorage anahtarları vault’suz (activePage, zoom, rail)' },
            { text: 'AgentSurface pencere başına BİR tane' },
            { text: 'PTY canlı WebSocket’e bağlı — bağlantı kopunca oturum ölür' },
          ],
        }),
        (xx, yy) => stack({
          x: xx, y: yy, gap: 24, items: [
            (a, b) => callout({
              x: a, y: b, w: 700, color: 'red', title: 'Taşıyıcı kısıt',
              text: 'Arka plandaki sekme UNMOUNT edilirse o projenin chat’leri ölür. Sunucu sadece roster metadata’sını saklıyor (agent-sessions.ts) — geri dönüşte “Resume” yazan uykudaki sekmeler geliyor, canlı konuşma değil.',
            }),
            (a, b) => callout({
              x: a, y: b, w: 700, color: 'green', title: 'Sonuç',
              text: 'Arka plandaki projeler GİZLENMELİ, sökülmemeli. Yani bir çip = ayakta duran bir proje instance’ı; geçiş sadece görünürlük değiştirir.',
            }),
          ],
        }),
      ],
    }),
  ],
});
P(s5);

// ── 5 · two routes ───────────────────────────────────────────────────────────
const s6 = stack({
  x: X, y: s5.nextY + 70, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: '6 · İki yol', fontSize: 30 }),
    (x, y) => table({
      x, y, maxColW: 340, fontSize: 14,
      headers: ['', 'A · React çoklu instance', 'B · Proje başına webview'],
      rows: [
        ['nasıl', 'Tek webview, N tane <ProjectInstance>', 'Tauri child webview, chrome ayrı'],
        ['değişecek kod', 'Geniş: singleton temizliği', 'Neredeyse sıfır uygulama kodu'],
        ['chat canlılığı', 'Mount kalır → canlı', 'Doğal olarak canlı, tam izolasyon'],
        ['rozet iletimi', 'Aynı JS heap — bedava', 'Webview’lar arası Tauri event'],
        ['tarayıcı dashboard', 'Çalışır', 'Çalışmaz — sadece desktop'],
        ['ana risk', 'activeVault / cache / storage sızıntısı', 'Native yerleşim + drag region'],
        ['bellek', 'N × React ağacı', 'N × webview (daha ağır)'],
      ],
    }),
    (x, y) => prose({
      x, y, width: 660, fontSize: 16,
      text: 'Önerim A: uzun vadede doğru olan bu, çünkü çip şeridi tarayıcı dashboard’unda da çalışır ve rozet için native köprü gerekmez. Bedeli, activeVault’u context’e çevirmek + QueryClient ve localStorage’ı vault başına ayırmak.',
    }),
  ],
});
P(s6);

// ── 6 · escape hatch + open questions ────────────────────────────────────────
const s7 = stack({
  x: X, y: s6.nextY + 70, gap: 30, items: [
    (x, y) => sectionTitle({ x, y, text: '7 · Çoklu pencere kaçış kapısı + kararlar', fontSize: 30 }),
    (x, y) => row({
      x, y, gap: 70, valign: 'top', items: [
        (xx, yy) => callout({
          x: xx, y: yy, w: 620, color: 'blue', title: 'Eski davranış kayıp değil',
          text: 'Çip sağ tık → “Yeni pencerede aç”: çip bu pencereden çıkar, kendi OS penceresini alır.\nÇipi şeritten dışarı sürüklemek de aynı şey.\n⌘P her yerde duruyor; seçim varsayılan olarak SEKME açar, ⇧⌘P yeni pencere.\n⌘1-9 artık pencereleri değil bu pencerenin çiplerini geziyor.\nLauncher penceresi olduğu gibi kalıyor.',
        }),
        (xx, yy) => callout({
          x: xx, y: yy, w: 620, color: 'green', title: 'Kararlar — kapandı',
          text: '1. Sekme kalıcılığı YOK — her açılışta tek proje (?vault=).\n2. Aynı proje iki yerde açılamaz — roster tek yazar varsayıyor.\n3. Tavan 6 canlı instance; boş olan en eski sökülür, soğuk çipe döner.\n4. Arka planda chat CANLI, sayfa poll’u kapalı.\n5. Rozet = aktif chat sayısı; durum renkte (bekleyen → kırmızı + zıplar).\n6. Yol A — tek webview, N React instance.',
        }),
      ],
    }),
  ],
});
P(s7);

buildExcalidraw({
  out: path.resolve(__dirname, 'project-tabs.excalidraw.md'),
  name: 'project-tabs',
  description: 'Design board for collapsing dreamcontext’s window-per-project model into one window with a title-bar project chip bar: chip states, the + → ⌘P palette flow, the attention badge pipeline, the mount-vs-unmount constraint that keeps background chats alive, and the two implementation routes.',
  tags: ['design', 'desktop', 'excalidraw'],
  elements: els,
});
