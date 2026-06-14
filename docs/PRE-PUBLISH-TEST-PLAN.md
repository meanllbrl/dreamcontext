# Yayın Öncesi Uçtan Uca Test Planı

**Sürüm:** v0.8.1 · **Tarih:** 2026-06-14 · **Kapsam:** son 7 günde (2026-06-08 → 06-14) eklenen ~90 commit

Bu döküman, `npm publish` öncesi sistemi **kendi ellerinle** uçtan uca test etmen için hazırlandı.
Her test bağımsız izlenebilir: **ne test edilir → adımlar/komut → beklenen sonuç → [ ] sonuç**.

> Yöntem: Üstten alta git. Bir alanda kırmızı görürsen not düş, ama bağımsız alanlara devam edebilirsin.
> Komutlarda `dreamcontext` = `node dist/index.js` (build sonrası) ya da global kurulu binary.

İşaretleme: `[ ]` = bekliyor · `[x]` = geçti · `[!]` = hata (not düş).

---

## 0. Önkoşullar ve ortam

- [ ] **0.1 Temiz çalışma ağacı** — `git status` temiz (ya da bilerek değiştirdiklerin).
- [ ] **0.2 Node sürümü** — `node -v` ≥ 18.
- [ ] **0.3 Rust/Tauri** (desktop testi yapacaksan) — `cargo --version` ≥ 1.86, `rustc` kurulu.
- [ ] **0.4 `claude` CLI PATH'te** (desktop Ask/Learn/Sleep ve enrichment için) — `which claude` çıktı veriyor.
- [ ] **0.5 İzole bir test vault'u** hazırla — gerçek projende kirletmemek için:
  ```bash
  mkdir -p /tmp/dctest && cd /tmp/dctest
  ```
  Aşağıdaki CLI testlerini çoğunlukla burada koşacağız.

---

## 1. Build + otomatik test (KAPI — burası geçmeden devam etme)

- [ ] **1.1 Build** — repo kökünde:
  ```bash
  npm run build
  ```
  **Beklenen:** Dashboard build + CLI build (`tsup`) ikisi de exit 0. `dist/index.js` ve `dist/dashboard/` oluştu.
- [ ] **1.2 Birim/entegrasyon testleri**:
  ```bash
  npm test -- --run
  ```
  **Beklenen:** Tüm testler yeşil, çıkış 0. Özellikle son hafta eklenen alanlar: tasks (M1–M5 conformance, golden fixtures), federation (cross-process concurrency), migration ledger.
- [ ] **1.3 Diyagramlar güncel** (publish-checklist gereği):
  ```bash
  npm run diagrams
  ```
  **Beklenen:** Hata yok; `git status` ile bak — diyagram PNG'leri beklenmedik şekilde değiştiyse README/DEEP-DIVE figürleri bayat demektir.

---

## 2. CLI çekirdeği — kurulum, snapshot, doctor

- [ ] **2.1 init** — `/tmp/dctest`'te:
  ```bash
  node /Users/mehmetnuraydin/projects/dreamcontext/dist/index.js init -y --name "DC Test" --description "test vault"
  ```
  **Beklenen:** `_dream_context/core/`, `state/`, `knowledge/` oluştu; soul/user/memory dosyaları var; `.sleep.json` başladı; tech stack auto-detect denendi.
- [ ] **2.2 doctor** — `dreamcontext doctor`
  **Beklenen:** Yapı geçerli; eksik dosya/frontmatter uyarısı yoksa exit 0.
- [ ] **2.3 snapshot** — `dreamcontext snapshot --tokens`
  **Beklenen:** Soul+User+Memory, görevler, knowledge index, sleep state, (varsa) federation inbox durumu ve auto-upgrade nudge'ı içeren brifing; sonda token tahmini.
- [ ] **2.4 config show** — `dreamcontext config show`
  **Beklenen:** platforms, packs, multiProduct, setupVersion görünüyor.

---

## 3. Görevler (Tasks) + ClickUp uzak backend — `#11` (en büyük alan)

### 3a. Yerel görev yaşam döngüsü
- [ ] **3.1 create + RICE** —
  ```bash
  dreamcontext tasks create "Login akışını yaz" -p high -t backend,auth --reach 8 --impact 4 --confidence 75 --effort 3
  ```
  **Beklenen:** `state/login-akisini-yaz.md` frontmatter ile yazıldı; RICE skoru hesaplandı; aktif planlama sürümüne iliştirildi.
- [ ] **3.2 list filtreleri** —
  ```bash
  dreamcontext tasks create "UI parlat" -p medium -t frontend
  dreamcontext tasks list --tag backend --priority high --group-by version --long
  dreamcontext tasks list --any-tag backend --any-tag frontend
  dreamcontext tasks tags
  ```
  **Beklenen:** `--tag` AND, `--any-tag` OR semantiği doğru; `--group-by` bölümler halinde; `tags` farklı etiketleri sayılarıyla listeler.
- [ ] **3.3 status geçişleri** — `dreamcontext tasks status login-akisini-yaz in_progress "başladım"`
  **Beklenen:** Durum değişti, changelog'a sebepli kayıt düştü.
- [ ] **3.4 due_date + backlog kuralı** —
  ```bash
  dreamcontext tasks tag ui-parlat backlog
  dreamcontext tasks due ui-parlat 2026-07-01
  ```
  **Beklenen:** Tarih atanınca **backlog etiketi otomatik kalkar** (tarihli görev = planlı). `due ui-parlat clear` ile geri al, sonra tekrar dene.
- [ ] **3.5 person tag tekilliği** (çok kişili projede) — `dreamcontext tasks tag ui-parlat person:ada` sonra `person:mehmet` ata.
  **Beklenen:** Aynı anda **tek** `person:*` etiketi; yeni atama eskisini düşürür.
- [ ] **3.6 doctor (workflow ↔ acceptance criteria)** — `dreamcontext tasks doctor`
  **Beklenen:** Mermaid `## Workflow` düğüm sayısı/durumu ile `## Acceptance Criteria` checkbox'ları uyumsuzsa drift bildirir (exit 1), temizse exit 0.
- [ ] **3.7 delete + onay** — `dreamcontext tasks delete ui-parlat` (onay sor); `--yes` ile sessiz sil.
  **Beklenen:** Yerel dosya silindi; uzak backend varsa silme bir sonraki sync'te yayılır.

### 3b. ClickUp uzak backend (token gerektirir — opsiyonel ama önemli)
> Önkoşul: ClickUp API token + bir test listesi. Token CLI argümanı yerine **pipe** edilmeli (review notu).
- [ ] **3.8 onboarding** — Advanced ayar olarak rehberli CLI akışını izle (list picker, connection test).
  **Beklenen:** Liste API'den çekiliyor, bağlantı testi geçiyor.
- [ ] **3.9 provision** — `dreamcontext tasks provision`
  **Beklenen:** urgency/summary/RICE/due_date özel alanları uzakta yoksa oluşturulur, mevcut görevlere backfill yapılır; idempotent (ikinci çalıştırma "already exist").
- [ ] **3.10 members** — `dreamcontext tasks members --json`
  **Beklenen:** Uzak konteynerdeki kişiler (assignee adayları) listelenir.
- [ ] **3.11 sync (both)** — `dreamcontext tasks sync both`
  **Beklenen:** `pushed N, pulled M, created K, deleted L, comments C` raporu. Çakışma olursa `state/.conflicts/` altına yazılır (otomatik çözülmez).
- [ ] **3.12 person ↔ assignee köprüsü** — `person:<slug>` etiketi uzakta assignee'ye dönüşüyor; uzaktan değişen assignee yerelde person etiketine dönüyor.
- [ ] **3.13 silme uzlaşması** — yerelde sil → sync → uzakta da silinmiş; uzakta sil → pull → yerelde uzlaştırıldı.
- [ ] **3.14 git hook sync** — `dreamcontext tasks sync-hooks install`, sonra bir commit at.
  **Beklenen:** post-commit best-effort sync (`--hook`, 15s timeout, git'i asla kırmaz). Mevcut yabancı hook varsa atlanır.
- [ ] **3.15 sync lock** — aynı projede iki sync'i üst üste tetikle.
  **Beklenen:** İkincisi "another sync running" ile geri çekilir (tek sync engine).

---

## 4. Taxonomy — faceted etiket sözlüğü

- [ ] **4.1 init + vocab** —
  ```bash
  dreamcontext taxonomy init
  dreamcontext taxonomy vocab --facet domain
  ```
  **Beklenen:** `core/taxonomy.json` oluştu (idempotent); vocab DEFAULT + proje birleşimi, facet filtreleniyor.
- [ ] **4.2 add + alias + resolve** —
  ```bash
  dreamcontext taxonomy add payments
  dreamcontext taxonomy alias auth authentication
  dreamcontext taxonomy resolve auth --json
  ```
  **Beklenen:** `resolve` normalize formu + sınıflandırma (faceted|alias|bare) + canonical karşılığı döner.
- [ ] **4.3 audit** — `dreamcontext taxonomy audit --json`
  **Beklenen:** Etiketsiz dokümanlar, canonical olmayan etiketler, orphan etiketler, yakın-tekrar çiftleri kovalar halinde; read-only, exit 0.

---

## 5. Features — PRD tazelik + doctor (`#13`)

- [ ] **5.1 create** — `dreamcontext features create auth -w "kimlik doğrulama" -t backend,security`
  **Beklenen:** `core/features/auth.md` şablon bölümleriyle.
- [ ] **5.2 set + insert** —
  ```bash
  dreamcontext features set auth status in_progress
  dreamcontext features insert auth acceptance_criteria "Token yenileme çalışır"
  ```
  **Beklenen:** Frontmatter güncellendi; acceptance_criteria `- [ ]` checkbox formatında, kayıpsız insert.
- [ ] **5.3 doctor** — `dreamcontext features doctor`
  **Beklenen:** STALE (30+ gün), ORPHANED (ilişkili görev yok), DANGLING (eksik PRD'ye işaret eden görev) raporu; sorun varsa exit 1.

---

## 6. Knowledge — excalidraw, data-structures SQL, fullscreen (`#20/#12/#21`)

- [ ] **6.1 create + index** —
  ```bash
  dreamcontext knowledge create mimari -d "sistem mimarisi" -t architecture
  dreamcontext knowledge index --tag architecture
  ```
  **Beklenen:** `knowledge/mimari.md`; index açıklama/etiket/tazelik gösterir.
- [ ] **6.2 data-structures SQL render** — bir data-structure dokümanına ` ```sql ` gövdesi ekle.
  **Beklenen:** Dashboard'da ER diyagramı olarak (entity kutuları + PK/FK + kardinalite) render olur (bkz. 10.6).
- [ ] **6.3 excalidraw board** — `knowledge/diagrams/` altına bir board koy.
  **Beklenen:** Board first-class knowledge; recall **çıkarılan metni** indeksler, asla scene JSON'u değil.
- [ ] **6.4 diagrams migration** — `dreamcontext migrations apply-diagrams`
  **Beklenen:** Düz `diagrams/<slug>.excalidraw.md` → `diagrams/<slug>/<slug>.excalidraw.md` klasörlenir; wikilink'ler atomik düzeltilir; zaten klasörlüler atlanır; ledger'a kayıt.

---

## 7. Federation — çoklu vault (`#25`)

> İki vault gerekir. İkinci bir test vault'u hazırla:
> ```bash
> mkdir -p /tmp/dctest2 && cd /tmp/dctest2 && dreamcontext init -y --name "DC Test 2"
> ```

- [ ] **7.1 vaults add/list/discover** —
  ```bash
  dreamcontext vaults add dctest /tmp/dctest
  dreamcontext vaults add dctest2 /tmp/dctest2
  dreamcontext vaults list
  dreamcontext vaults discover /tmp --register
  ```
  **Beklenen:** Global `~/.dreamcontext-vaults.json` güncellendi; discover idempotent, isim çakışması `-2/-3` ile çözülür.
- [ ] **7.2 cross-vault recall (Phase 1, read-only)** — `/tmp/dctest`'te:
  ```bash
  dreamcontext memory recall "mimari" --vault dctest2
  dreamcontext memory recall "mimari" --all-vaults
  ```
  **Beklenen:** Tek-vault modu federation'dan önceki davranışla **byte-identical**; çoklu-vault modu shareable peer'ları kapsar, stale olanları atlar (sayı/sebep raporu).
- [ ] **7.3 connect (Phase 2)** —
  ```bash
  dreamcontext connect dctest2 -d both --topics architecture
  dreamcontext connections list
  ```
  **Beklenen:** `state/.connections.json` kaydı; tablo yön/topic/durum gösterir.
- [ ] **7.4 digest sync (Phase 3)** —
  ```bash
  dreamcontext federation sync --dry-run    # önce kuru çalış
  dreamcontext federation sync
  dreamcontext federation status
  ```
  **Beklenen:** Dry-run hiçbir şey yazmaz, watermark ilerlemez; gerçek sync rıza veren peer'ın inbox'ına yazar, watermark ilerler.
- [ ] **7.5 drain** — alıcı vault'ta `dreamcontext federation drain`
  **Beklenen:** Pending inbox first-class knowledge olarak ingest edilir; çakışmalar bookmark olarak yüzeye çıkar (otomatik çözülmez); consumed'a taşınır.
- [ ] **7.6 dead peer** — peer vault'unu sil/taşı, sonra sync.
  **Beklenen:** Ölü peer **stale** işaretlenir; bir kez uyarır, sonra atlar (sync patlamaz).

---

## 8. Migration sistemi + setupVersion drift (`#23/#22`)

- [ ] **8.1 pending** — `dreamcontext migrations pending`
  **Beklenen:** setupVersion → güncel sürüm arası bekleyen agent task talimatları (varsa) yazılır.
- [ ] **8.2 sleep ile migration** — `dreamcontext sleep start`
  **Beklenen:** Epoch pinlendi; bekleyen 'code' migration'ları çalıştı; agent task talimatları depolandı.
- [ ] **8.3 setupVersion drift self-heal** — `state/.config.json` içindeki `setupVersion`'ı elle eski bir değere düşür, sonra `dreamcontext snapshot`.
  **Beklenen:** Snapshot setup drift'i tespit eder ve bayat proje varlıklarını self-heal eder / uyarır (değerler sanitize edilir).
- [ ] **8.4 ledger** — `dreamcontext migrations record --version 0.7.2 --step test-step --executor agent --summary "manuel"`
  **Beklenen:** `state/.migrations-ledger.json`'a zaman damgalı kayıt; dedup korunur.

---

## 9. Recall v3 + snapshot budget + multi-people (`v0.7.0`, `#8`)

- [ ] **9.1 recall v3** — `dreamcontext memory recall "login" --top 10 --types knowledge,feature,task`
  **Beklenen:** BM25 skorlu hit'ler; path/açıklama/etiket/snippet; tür filtresi uygulanır.
- [ ] **9.2 snapshot budget** — `dreamcontext snapshot --tokens` (büyük vault'ta)
  **Beklenen:** Pinned knowledge satır limiti (≤60, frontmatter `pinned_preview_lines` saygı) uygulanır; snapshot bütçe dahilinde.
- [ ] **9.3 multi-people attribution** —
  ```bash
  dreamcontext memory remember "ada API'yi yazdı" --person ada
  dreamcontext memory recall "ada"
  ```
  **Beklenen:** Kişi yazar olarak indekslenir; isimle recall edilebilir.

---

## 10. Dashboard (web UI)

- [ ] **10.1 başlatma** — `dreamcontext dashboard` (veya `--port 4173 --vault dctest`)
  **Beklenen:** Tarayıcı `http://localhost:4173` açılır; sidebar gruplı navigasyon (Brain/Tasks/Knowledge/Features/Core/Council/Taxonomy/Sleep · Packs/Settings).
- [ ] **10.2 Tasks — Kanban drag&drop** — kartı kolonlar arası sürükle.
  **Beklenen:** Durum `PATCH /api/tasks/:slug` ile güncellenir.
- [ ] **10.3 Eisenhower matrisi** — 2×2 ızgarada kartı quadrant'lar arası sürükle.
  **Beklenen:** `priority` + `urgency` atomik güncellenir; tamamlananlar bu görünümde yok.
- [ ] **10.4 Task detay paneli** — etiket chip ekle/sil (`×`), assignee/feature searchable select, due date, RICE bloğu; acceptance-criteria checkbox'ı işaretle.
  **Beklenen:** Checkbox toggle, `<!-- node:id -->` içeren satırda ilgili mermaid düğümünün `:::status` sınıfını senkron eder.
- [ ] **10.5 sağ-tık menü + delete danger zone** — kartı sağ-tıkla → Delete → onay diyaloğu.
  **Beklenen:** "remote backend'e sync'te yayılır" uyarısıyla siler.
- [ ] **10.6 Sync butonu** — yalnızca uzak backend'de görünür; tıkla.
  **Beklenen:** `↕ N up · M down` / `⚠ error` / `⏳ another sync running` notu.
- [ ] **10.7 ClickUp Settings** — Settings → Cloud Tasks: list picker, Test Connection, Provision fields, sync status badge, stale-server restart banner.
  **Beklenen:** Bağlantı ✓/✗; provision sonucu; `/api/health` capabilities ile bayat-server tespiti banner'ı.
- [ ] **10.8 Taxonomy görünümü** — facet chip kümeleri, kullanım sayıları, alias okları (read-only).
- [ ] **10.9 Knowledge fullscreen** — bir dokümanı aç → File/Preview → `⛶` fullscreen.
  **Beklenen:** In-app overlay (tarayıcı fullscreen değil); Esc kapatır; body scroll kilitli; Tab overlay içinde tuzaklı; kapanışta focus geri döner (review hardening).
- [ ] **10.10 data-structures SQL** — bir SQL knowledge dokümanını aç.
  **Beklenen:** ER diyagramı render (entity + PK/FK + kardinalite).
- [ ] **10.11 Federation control plane** — Settings → Connections: bağlantı ekle, "shareable" toggle (anında kalıcı).

---

## 11. Desktop app (Tauri 2, macOS) — launcher + onboarding + Sleepy

> Çalıştırma (dev): repo kökünde `npm run build` sonrası
> ```bash
> cd desktop && npm install
> DREAMCONTEXT_CLI=../dist/index.js DREAMCONTEXT_VAULT=/tmp/dctest npm run tauri dev
> ```
> Paketli (imzasız) build: `cd desktop && npm run tauri build -- --config /tmp/nosign.json --bundles app` → `src-tauri/target/release/bundle/macos/dreamcontext.app` (sağ-tık → Open ile Gatekeeper'ı aş).

- [ ] **11.1 launcher** — vault pinlenmemiş başlat.
  **Beklenen:** "Launcher · all projects", arama çubuğu, "+ Add Project", vault kart ızgarası; boş durumda "No projects yet".
- [ ] **11.2 vault aç** — bir kartta "Open →".
  **Beklenen:** Yeni WebviewWindow `?vault=<name>` ile açılır.
- [ ] **11.3 onboarding — yeni proje** — "+ Add Project" → Create new: name+klasör → açıklama → kullanıcı → stack → öncelik → **platforms** (Claude pre-checked) → **skill packs** (hiçbiri seçili değil) → Review.
  **Beklenen:** Wizard viewport içinde scroll olur (taşmaz, kompakt pack kartları); setup sonunda ✓ + handoff prompt + "Open project →".
- [ ] **11.4 onboarding — mevcut klasör** — `_dream_context` olan klasör için yalnız platforms+packs adımları; olmayan için tam quiz.
  **Beklenen:** Klasör problanır, name/stack auto-fill; doğru adım sayısı.
- [ ] **11.5 Sleepy notch — hotkey** — Settings'te Sleepy'i etkinleştir, `Alt+Cmd+S` bas.
  **Beklenen:** Menü çubuğundan notch paneli düşer (420×520, şeffaf); mascot paneli + capture bar.
- [ ] **11.6 mod toggle sırası ve default** — toggle **Ask · Learn · Sleep** sırasında ve **Ask default seçili**.
- [ ] **11.7 Ask modu** — soru yaz, Return.
  **Beklenen:** "Sleepy is thinking…" → markdown render edilmiş cevap (Sonnet + thinking); yan etki yok; markdown listeleri okunaklı.
- [ ] **11.8 Learn modu** — not yaz, Return.
  **Beklenen:** Anında "captured ✓" (not `CHANGELOG.json`'a kaydedildi) + fire-and-forget enrichment cevabı.
- [ ] **11.9 Sleep modu** — "💤 Sleep — consolidate <vault>" tıkla.
  **Beklenen:** Input kilitli, mascot **uykuda**, pencere açık kalır; consolidation bitince ✓ Slept + özet; debt sıfırlanır.
- [ ] **11.10 mascot moodları** — debt < 8 idle; **debt ≥ 8 drowsy**; Sleep sırasında asleep.
  **Beklenen:** Animasyonlu WebP WKWebView'de play-button olmadan otomatik oynar.
- [ ] **11.11 vault picker** — notch'taki dropdown projeyi değiştirir; mascot mood'u o projenin debt'ine göre güncellenir.
- [ ] **11.12 dismiss** — Esc kapatır; dışarı tık kapatır (consolidation uçuştayken kapanmaz).
- [ ] **11.13 config kalıcılığı** — hotkey'i değiştir, app'i yeniden başlat.
  **Beklenen:** `~/.dreamcontext/sleepy.json` server-side kalıcı; hotkey restart sonrası korunur (server-side config restart'ı atlatır — `3dcd0c2`).

---

## 12. CLI auto-upgrade + update nudge (`79b9546`)

- [ ] **12.1 check** — `dreamcontext upgrade --check`
  **Beklenen:** npm registry'den sürüm kontrolü; yeni sürüm varsa bildirir, kurmaz.
- [ ] **12.2 snapshot nudge guard** — `dreamcontext snapshot`
  **Beklenen:** Yeni sürüm nudge'ı görünür ama app-context içinde (desktop) nudge guard ile bastırılır (`79b9546`); default-on background auto-upgrade davranışını gözlemle.

---

## 13. install.sh (curl kurulum + macOS app) (`3077a02`)

> **Dikkat:** Bunu temiz bir kabukta / izole dizinde test et. Yayın öncesi yerel script'i çalıştırabilirsin.
- [ ] **13.1 yerel install.sh** — `sh install.sh` (test makinesinde)
  **Beklenen:** CLI kurulur; **macOS'ta desktop app da kurulur** (`3077a02`).
- [ ] **13.2 sürüm doğrula** — `dreamcontext --version`
  **Beklenen:** `0.8.1` yazar (package.json ile uyumlu).
- [ ] **13.3 curl yolu** — *yalnızca* repo public olduktan ve main'e merge sonrası aktif:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/meanllbrl/dreamcontext/main/install.sh | sh
  ```
  (Publish öncesi bu adım **N/A** — checklist'in 5–6 adımından sonra.)

---

## 14. Yayın öncesi son kontrol (publish-checklist ile)

- [ ] **14.1 sürüm doğru** — `package.json` `version` = `0.8.1`, `license` = `Apache-2.0`.
- [ ] **14.2 pack dry-run** — `npm pack --dry-run`
  **Beklenen:** `dist/`, `skill/`, `install.sh`, `README.md`, `LICENSE`, `NOTICE` listede.
- [ ] **14.3 README + DEEP-DIVE güncel** — son hafta eklenen yüzeyler (federation, ClickUp tasks, desktop app, Sleepy, taxonomy) dökümanlara yansımış.
- [ ] **14.4 build temiz** — `npm run build && npm test -- --run` tekrar yeşil.
- [ ] Ardından publish-checklist adım 3→6: `npm login` → `npm publish --access public` → main'e merge + repo public → curl smoke test.

---

## Hızlı kapsama özeti (son 7 gün → test bölümü)

| Alan | Commit teması | Bölüm |
|---|---|---|
| Tasks + ClickUp backend | `#11` M1–M5, sync lock, provision, person↔assignee, deletion | §3 |
| Taxonomy | faceted vocab, JSON storage, audit | §4 |
| Features | PRD freshness, `features doctor`, authoring DX | §5 |
| Knowledge | excalidraw boards, SQL fences, fullscreen viewer | §6, §10.9–10.10 |
| Federation | vaults, connect, drain, digest sync, dead peer | §7, §10.11 |
| Migration | versioned registry + ledger, setupVersion drift | §8 |
| Recall v3 / snapshot budget / multi-people | `v0.7.0`, `#8` | §9 |
| Dashboard | Eisenhower, tag chips, sync button, ClickUp settings | §10 |
| Desktop app (Tauri) | launcher, onboarding, notch/Sleepy, modes, mascot | §11 |
| CLI auto-upgrade | background upgrade + nudge guard | §12 |
| install.sh | macOS app kurulumu | §13 |

---

### Sonuç notları (test sonrası doldur)

- Geçen: __ / __
- Açık hatalar:
  - …
- Yayına engel (blocker) var mı? ☐ Hayır ☐ Evet → …
