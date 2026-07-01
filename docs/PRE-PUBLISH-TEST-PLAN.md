# Pre-Publish Test Plan

**Version:** v0.10.5  
**Date:** 2026-07-01  
**Window reviewed:** 2026-06-23 -> 2026-07-01  
**Commit range:** `v0.9.2..HEAD` + uncommitted working tree  
**Diff size:** committed `v0.9.2..HEAD` 311 files / +21,469 / -2,080; uncommitted working tree 41 dosya (7 untracked) / +1,336 / -259

Bu planin amaci hizli gelistirdigimiz son hafta-on-gunluk isleri yayindan once elle, net ve tekrar edilebilir sekilde test etmek. Ham diff cok buyuk oldugu icin plan commitleri risk alanlarina indirger: once otomatik kapilar, sonra en cok kirilma riski olan kullanici akislari.

**Yayin durumu (onemli):** `0.10.0`, `0.10.1` ve `0.10.2` zaten npm'e **publish edildi**. Bu surumdeki cogu is (agent surface, in-app version rename/delete, sleep mutex, board smart buckets/AvatarStack, sync hardening, taxonomy audit --fix, deep-research skill) o yayinlardadir; bunlari burada **regression** olarak dogrularz. `v0.10.5` ise asagidaki **commit edilmemis working tree** isini paketler — GitHub task-image bridge, orphaned-server fix, ilk CI workflow, recall q030 fix, excalidraw overflow-proof render, knowledge board-folder grouping + asset resolution, installer hook reconcile. Bunlar **yeni ve hicbir yayinda kanitlanmamis** oldugu icin en sert test edilecek alandir.

**Son karar:** `npm publish` icin tum **Blocker Gates** gecmeli. Manual testlerde blocker disi hatalar not dusulup publish kararinda risk olarak tartilabilir.

Isaretleme:

- `[ ]` bekliyor
- `[x]` gecti
- `[!]` hata var
- `[n/a]` bu ortamda test edilmeyecek

---

## 0. Test Hazirligi

### 0.1 Repo ve ortam

- [ ] **Working tree = v0.10.5 payload**  
  Komut: `git status --short`  
  Beklenen: Bu plan disinda gorunen degisiklikler v0.10.5 payload'idir: `src/lib/image-sniff.ts`, `src/lib/task-backend/github-assets.ts`, `src/server/lifecycle.ts`, `.github/workflows/ci.yml`, ve modified `recall.ts` / `github.ts` / `sync-state.ts` / `lib.rs` / `KnowledgePage.tsx` / `knowledge.ts` / `install-skill.ts` / excalidraw scriptleri. Beklenmeyen dosya yok.

- [ ] **Node**  
  Komut: `node -v`  
  Beklenen: Node >= 18.

- [ ] **Package version**  
  Komut: `node -p "require('./package.json').version"`  
  Beklenen: `0.10.5` (publish oncesi bump edilmis olmali; su an repo `0.10.2` ise bump et).

- [ ] **License**  
  Komut: `node -p "require('./package.json').license"`  
  Beklenen: `Apache-2.0`.

- [ ] **Desktop prereqs**  
  Komut: `cargo --version && rustc --version`  
  Beklenen: Rust/Tauri build icin komutlar calisir.

- [ ] **Claude CLI**  
  Komut: `which claude`  
  Beklenen: Sleepy Learn enrichment + in-app Agent + ⌘K Haiku toggle icin path doner. (Yoksa in-app prerequisite installer'i test et — bkz 12.)

### 0.2 Izole test vaultlari

Gercek projeyi kirletmeden test icin:

```bash
rm -rf /tmp/dctest /tmp/dctest2
mkdir -p /tmp/dctest /tmp/dctest2
```

Not: Komutlarda `dreamcontext` yerine publish oncesi lokal build icin su alias kullanilabilir:

```bash
alias dreamcontext="node /Users/mehmetnuraydin/projects/dreamcontext/dist/index.js"
```

GitHub task-image bridge (bolum 4) icin gercek bir GitHub repo + token gerekir; o test **disposable bir test repo** uzerinde yapilmalidir, cunku ilk push hedef repoda `dreamcontext-assets` adli yeni bir branch yaratir.

---

## 1. Blocker Gates

Bu bolum kirmiziysa manual teste gecme. Once fix.

- [ ] **1.1 Build**  
  Komut: `npm run build`  
  Beklenen: Dashboard build + CLI build exit 0; `dist/index.js` ve `dist/dashboard/` olustu.

- [ ] **1.2 Full automated suite**  
  Komut: `npm test -- run`  
  Beklenen: Tum testler yesil. Suite artik su yeni/kritik dosyalari da iceriyor: `tests/unit/github-assets.test.ts`, `tests/unit/lifecycle.test.ts`, `tests/unit/releases-rename-delete-route.test.ts`, `tests/unit/server-static.test.ts`, `tests/unit/excalidraw-knowledge.test.ts`, ve `tests/integration/cli-commands.test.ts`. Ayrica: task backend (ClickUp + GitHub), federation, migrations, launcher, sleep-quality eval, recall (q030 dahil).  
  Not: `npm test` bare `vitest` (watch) — non-interactive tek pas icin `-- run` sart.

- [ ] **1.3 Diagrams**  
  Komut: `npm run diagrams`  
  Beklenen: Hata yok (overflow-proof render: per-glyph width, fitText auto-shrink, connector elbow/via routing, dangling-embed pre-flight guard). `git status --short` beklenmeyen diagram churn gostermiyor.

- [ ] **1.4 Package dry-run**  
  Komut: `npm pack --dry-run`  
  Beklenen icerik: `dist/` (index.js + dashboard/ + agents/), `skill/` (`skill/references/` dahil), `skill-packs/`, `skill-initializer/`, `skill-curator/`, `skill-deep-research/`, `agents/`, `install.sh`, `README.md`, `LICENSE`, `NOTICE`.  
  Beklenen HARIC: `_dream_context/` **girmiyor**, `desktop/src-tauri/target/` gibi build artifact'lari **girmiyor**, `overrides/` ve `tests/` girmiyor. **`DEEP-DIVE.md` de pakete GIRMEZ** — kasitli: `files` array'inde yok, README icindeki relative link npm tarafindan repo URL'ine cozulur, o yuzden tarball'a koymaya gerek yok (mevcut davranis).  
  Not: `package.json` `files` alani source-of-truth — yeni `dreamcontext-deep-research` ve curator/initializer skill dizinlerinin pakete girdigini dogrula.

- [ ] **1.5 CLI smoke**  
  Komut: `node dist/index.js --version && node dist/index.js --help`  
  Beklenen: `0.10.5`; komut listesinde `app`, `vaults`, `connections`, `federation`, `migrations`, `taxonomy`, `config`, `tasks`, `connect` var.

---

## 2. CLI Core: Setup, Init, Snapshot, Doctor

### 2.1 New vault setup

- [ ] **setup front door**  
  Komut:
  ```bash
  cd /tmp/dctest
  dreamcontext setup --name "DC Test" --description "pre-publish test vault" --yes
  ```
  Beklenen: `_dream_context/` olustu; platform/packs config yazildi; setup yarim kurulum birakmadi.

- [ ] **init does not hide missing selected platforms**  
  Komut: `dreamcontext init -y --name "DC Test Reinit"`  
  Beklenen: Mevcut vault icin guvenli davranir; secili platformlardan biri eksikse setup onerisi bastirilmaz.

- [ ] **installer hook reconcile (v0.10.5)**  
  Adim: Bir vault'ta hook timeout'unu eski spec'e dusur (or. `.claude/settings.json` icinde UserPromptSubmit timeout=5), sonra `dreamcontext install-skill` veya `dreamcontext update` calistir.  
  Beklenen: `ensureClaudeHooks` bayat timeout'u guncel spec'e **reconcile eder** (UserPromptSubmit 5s -> 120s), drift birakmaz; mevcut yabanci hook'lara saygili. Test: `tests/integration/cli-commands.test.ts`.

- [ ] **doctor**  
  Komut: `dreamcontext doctor`  
  Beklenen: Yapida kritik eksik yok.

- [ ] **snapshot token budget**  
  Komut: `dreamcontext snapshot --tokens`  
  Beklenen: Core, active tasks, knowledge index, sleep state, release/update nudge ve federation ozetleri butce icinde.

- [ ] **config show**  
  Komut: `dreamcontext config show`  
  Beklenen: `platforms`, `packs`, `multiProduct`, `setupVersion`, `nativeMemory` alanlari okunur.

### 2.2 Native memory config

- [ ] **disable/enable toggle**  
  Komut:
  ```bash
  dreamcontext config native-memory disable
  dreamcontext config show
  dreamcontext config native-memory enable
  ```
  Beklenen: Deger kalici; Claude native memory sahipligi net.

---

## 3. Tasks: Local + Remote Backends + Sync Hardening

Local task dosyalari, generic backend, ClickUp + GitHub adapter, sync, deletion, due date, person/assignee, RICE, dashboard controls. v0.10.x sync hardening (stable dcId reconciliation, assignee drift heal, custom-field override, overrides/task.md scaffold) burada regression olarak dogrulanir.

### 3.1 Local lifecycle

- [ ] **create with RICE**  
  Komut:
  ```bash
  cd /tmp/dctest
  dreamcontext tasks create "Login akis testi" -p high -t backend,auth --reach 8 --impact 4 --confidence 75 --effort 3
  ```
  Beklenen: `state/login-akis-testi.md`; RICE score hesaplandi; workflow bolumu var.

- [ ] **scaffold from overrides/task.md (v0.10.x)**  
  Adim: Vault'ta `overrides/task.md` sablonu varken hem CLI `tasks create` hem dashboard "New Task" ile task yarat.  
  Beklenen: Her iki create yuzeyi de override sablonundan scaffold eder; iki yuzey ayni govdeyi uretir.

- [ ] **filter/group/list semantics**  
  Komut:
  ```bash
  dreamcontext tasks create "UI testleri" -p medium -t frontend
  dreamcontext tasks list --tag backend --priority high --group-by version --long
  dreamcontext tasks list --any-tag backend --any-tag frontend
  dreamcontext tasks tags
  ```
  Beklenen: `--tag` AND, `--any-tag` OR; grouping ve tag sayilari dogru.

- [ ] **status and changelog**  
  Komut: `dreamcontext tasks status login-akis-testi in_progress "manual test started"`  
  Beklenen: Status degisti; task changelog en uste kayit atti.

- [ ] **due date/backlog rule**  
  Komut:
  ```bash
  dreamcontext tasks tag ui-testleri backlog
  dreamcontext tasks due ui-testleri 2026-07-15
  ```
  Beklenen: Tarih atanınca `backlog` etiketi otomatik kalkar.

- [ ] **person tag uniqueness**  
  Komut:
  ```bash
  dreamcontext tasks tag ui-testleri person:ada
  dreamcontext tasks tag ui-testleri person:mehmet
  ```
  Beklenen: Ayni anda tek `person:*` etiketi kalir.

- [ ] **delete path**  
  Komut: `dreamcontext tasks delete ui-testleri --yes`  
  Beklenen: Local task silinir; varsa remote deletion sync'e isaretlenir.

### 3.2 Remote backend (ClickUp / GitHub) + sync hardening

Token komut argumani olarak yazilmaz; pipe veya env kullan.

- [ ] **provision idempotence**  
  Komut: `dreamcontext tasks provision`  
  Beklenen: urgency, summary, RICE, feature, due_date alanlari olusturulur veya "already exists"; ikinci kosum temiz.

- [ ] **sync both**  
  Komut: `dreamcontext tasks sync both`  
  Beklenen: `pushed N, pulled M, created K, deleted L`; conflict varsa `state/.conflicts/`.

- [ ] **stable dcId reconciliation (#77)**  
  Adim: Local task'i rename et (slug degisir), sync et.  
  Beklenen: Reconciliation **stable dcId** uzerinden eslesir, name-slug uzerinden DEGIL; rename remote'ta duplicate/ghost yaratmaz, ayni karta repoint eder.

- [ ] **assignee drift heal (#78)**  
  Komut: `dreamcontext tasks sync --reconcile`  
  Beklenen: Onceden olusmus assignee drift iyilesir; `person:<slug>` <-> remote assignee tek kavram gibi davranir.

- [ ] **custom-field override sync (v0.10.x)**  
  Adim: Bir task'in custom-field override'ini degistir, sync + dashboard editor.  
  Beklenen: Override degeri push/pull'da korunur; dashboard editorde gorunur; round-trip kayipsiz.

- [ ] **deletion reconciliation**  
  Adim: Local sil -> sync -> remote silinir. Remote sil -> pull -> local reconcile.  
  Beklenen: Ghost task kalmaz; changelog/sleep journal notu mantikli.

- [ ] **sync lock**  
  Adim: Ayni vault'ta iki sync'i ayni anda tetikle.  
  Beklenen: Ikincisi "another sync running" ile guvenli cikar.

---

## 4. GitHub Task-Image Bridge  (YENI — v0.10.5 payload, en sert test)

Local-path gomulu gorseller iceren task'lar GitHub'a sync edilirken: push, gorsel byte'larini **yeni `dreamcontext-assets` branch'ine** Contents API ile yukler ve wire body'sini hosted URL'lere yeniden yazar; pull ters-map yapar. Content-addressed `assets/<sha>.<ext>`, idempotent/dedup. Dosyalar: `src/lib/image-sniff.ts` (magic-byte image id), `src/lib/task-backend/github-assets.ts` (saf codec), `src/lib/task-backend/github.ts` (`rebuildAssetBridgeFromLocal`), `src/lib/task-backend/sync-state.ts` (gitignored asset ledger). Test: `tests/unit/github-assets.test.ts`.

> **Gercek-dunya yan etki — mutlaka manuel dogrula:** ilk task-image push, kullanicinin GitHub repo'sunda **`dreamcontext-assets` adli yeni bir branch yaratir** ve gorsel byte'larini oraya commit eder. **Default branch'e dokunmaz.** Bu testi disposable bir test repo'da yap.

- [ ] **unit codec**  
  Komut: `npm test -- run tests/unit/github-assets.test.ts`  
  Beklenen: Codec encode/decode, dedup, content-address, rebuild yollari yesil.

- [ ] **local image -> issue render**  
  Adim: GitHub-backed test vault'ta bir task'a local-path image embed et (`![alt](./assets/foo.png)` gibi), `dreamcontext tasks sync both`.  
  Beklenen: `dreamcontext-assets` branch'i olusur; gorsel oraya `assets/<sha>.<ext>` olarak commit edilir; default branch'teki issue body'sinde gorsel **hosted URL ile render olur**.

- [ ] **re-push dedupes**  
  Adim: Ayni gorselle bir kez daha sync et (veya ayni gorseli ikinci task'a koy).  
  Beklenen: Ayni sha ikinci kez yuklenmez; idempotent; gereksiz commit yok.

- [ ] **pull reverse-map**  
  Adim: Hosted-URL'li bir issue'yu pull et.  
  Beklenen: Wire body hosted URL'den geri local-path temsiline ters-map edilir; round-trip kayipsiz.

- [ ] **wiped ledger recovers without spurious conflict**  
  Adim: Gitignored asset ledger'i (sync-state) sil, sonra tekrar push.  
  Beklenen: `rebuildAssetBridgeFromLocal` cache'i local'den yeniden insa eder; **`missing_base` conflict'i CIKMAZ**; image satiri churn etmez.

- [ ] **security: path containment + magic-byte gate**  
  Adim: Task body'sine `../` ile veya absolute path ile root disina kacmaya calisan bir embed koy; ayrica `.png` uzantili ama gorsel-olmayan bir dosya koy.  
  Beklenen: Root-contained path resolution `../` ve absolute escape'i **blokar**; boyut read'den ONCE kapida; magic-byte dogrulanmadan upload yok (gorsel-olmayan byte'lar asla yuklenmez).

---

## 5. Taxonomy

- [ ] **init + vocab**  
  Komut:
  ```bash
  dreamcontext taxonomy init
  dreamcontext taxonomy vocab --facet domain
  ```
  Beklenen: `core/taxonomy.json` olustu; default + project vocab birlesir.

- [ ] **add, alias, resolve**  
  Komut:
  ```bash
  dreamcontext taxonomy add payments
  dreamcontext taxonomy alias auth authentication
  dreamcontext taxonomy resolve auth --json
  ```
  Beklenen: canonical, alias, facet/bare siniflandirmasi okunur.

- [ ] **audit (read-only)**  
  Komut: `dreamcontext taxonomy audit --json`  
  Beklenen: Etiketsiz, canonical olmayan, orphan ve yakin-tekrar raporu read-only gelir.

- [ ] **audit --fix bulk normalizer (v0.10.x)**  
  Komut:
  ```bash
  dreamcontext taxonomy audit --fix --dry-run
  dreamcontext taxonomy audit --fix --json
  dreamcontext taxonomy audit --fix --json   # ikinci kosum
  ```
  Beklenen: `--dry-run` yazmaz, sadece raporlar; `--fix` etiketleri vocab'a normalize eder; ikinci kosum **idempotent** (degisiklik yok). `--json` ciktisi makine-okunur.

- [ ] **dashboard taxonomy page**  
  Adim: Dashboard > Taxonomy.  
  Beklenen: Facet chipleri, kullanim sayilari ve alias okuma gorunumu var.

---

## 6. Features and PRD Freshness

- [ ] **create + non-lossy insert**  
  Komut:
  ```bash
  dreamcontext features create auth -w "kimlik dogrulama" -t backend,security
  dreamcontext features set auth status in_progress
  dreamcontext features insert auth acceptance_criteria "Token refresh calisir"
  ```
  Beklenen: Frontmatter kayipsiz; acceptance criteria checkbox formatinda.

- [ ] **features doctor**  
  Komut: `dreamcontext features doctor`  
  Beklenen: STALE, ORPHANED, DANGLING durumlari raporlanir; exit code sorun varsa 1.

---

## 7. Knowledge: Excalidraw, Board-Folder Grouping, Asset Resolution

v0.10.5 knowledge isi: overflow-proof excalidraw render + dashboard board-folder grouping + bare wikilink asset resolution. Test: `tests/unit/excalidraw-knowledge.test.ts`.

- [ ] **knowledge create/index**  
  Komut:
  ```bash
  dreamcontext knowledge create mimari -d "sistem mimarisi" -t architecture
  dreamcontext knowledge index --tag architecture
  ```
  Beklenen: Knowledge file olustu, index aciklama/etiket/tazelik gosterir.

- [ ] **excalidraw overflow-proof render (v0.10.5)**  
  Adim: `/excalidraw` ile uzun label'li kartlar + connector'lu bir board uret; `npm run diagrams`.  
  Beklenen: Per-glyph width table + `wrapToWidth` + `fitText` auto-shrink sayesinde kart label'lari **tasmaz**; connector'lar elbow/via ile route olur; pre-flight guard dangling image-embed iceren board'u **yazmayi reddeder**.

- [ ] **Excalidraw as first-class knowledge**  
  Adim: `knowledge/diagrams/` altina test board koy, sonra `dreamcontext memory recall "<board text>"`.  
  Beklenen: Extracted text indekslenir; scene JSON recall sonucuna tasmaz.

- [ ] **board-folder grouping (v0.10.5)**  
  Adim: Dashboard > Knowledge. (a) Bir board'un tek-sahip (sole occupant) kendi-isimli wrapper klasoru; (b) yaninda `assets/` olan co-located bir board klasoru.  
  Beklenen: (a) tek-sahip wrapper klasoru **collapse edilir** (gereksiz nesting gosterilmez); (b) `assets/` ile birlikte yasayan klasor **grouped kalir**.

- [ ] **bare wikilink asset resolution (v0.10.5)**  
  Adim: Bir knowledge dokumaninda `[[img.png]]` gibi cıplak wikilink ile gorsel embed et; gorseli board klasorunde ya da `assets/` altında tut.  
  Beklenen: `src/server/routes/knowledge.ts` gomulu gorseli hem board klasorune hem de `assets/` alt-klasorune gore cozer; cıplak `[[img.png]]` dashboard'da **render olur**.

- [ ] **Knowledge fullscreen overlay**  
  Adim: Dashboard > Knowledge > File/Preview > fullscreen.  
  Beklenen: In-app overlay; Esc kapatir; body scroll kilitli; focus geri doner.

---

## 8. Federation: Multi-Vault Recall, Connections, Digest Inbox

### 8.1 Two-vault setup

```bash
cd /tmp/dctest2
dreamcontext setup --name "DC Test 2" --description "federation peer" --yes
```

- [ ] **vault registry**  
  Komut:
  ```bash
  dreamcontext vaults add dctest /tmp/dctest
  dreamcontext vaults add dctest2 /tmp/dctest2
  dreamcontext vaults list
  dreamcontext vaults discover /tmp --register
  ```
  Beklenen: Global registry idempotent; isim carpismalari `-2/-3` ile cozulur.

- [ ] **read-only cross-vault recall**  
  Komut:
  ```bash
  cd /tmp/dctest
  dreamcontext memory recall "mimari" --vault dctest2
  dreamcontext memory recall "mimari" --all-vaults
  ```
  Beklenen: Tek-vault davranisi eskiyle uyumlu; all-vaults sadece izinli/shareable peer'lari kapsar.

- [ ] **connections**  
  Komut:
  ```bash
  dreamcontext connect dctest2 -d both --topics architecture
  dreamcontext connections list
  ```
  Beklenen: `state/.connections.json`; direction/topic/status dogru.

- [ ] **digest sync dry-run and real run**  
  Komut:
  ```bash
  dreamcontext federation sync --dry-run
  dreamcontext federation sync
  dreamcontext federation status
  ```
  Beklenen: Dry-run yazmaz; real run peer inbox'a yazar; watermark ilerler.

- [ ] **drain inbox**  
  Komut: `/tmp/dctest2` icinde `dreamcontext federation drain`  
  Beklenen: Pending digest first-class knowledge olur; consumed'a tasinir; conflict bookmark olarak yuzeye cikar.

- [ ] **dead peer stale guard**  
  Adim: Peer path'i gecici tasi/sil, sonra sync.  
  Beklenen: Peer stale isaretlenir; bir kez uyarir, sonra skip; sync patlamaz.

---

## 9. Migration System and Setup Drift

- [ ] **pending migrations**  
  Komut: `dreamcontext migrations pending`  
  Beklenen: setupVersion'a gore pending code/agent migrations listelenir.

- [ ] **ledger record dedup**  
  Komut:
  ```bash
  dreamcontext migrations record --version 0.10.5 --step manual-test --executor agent --summary "manual prepublish"
  dreamcontext migrations record --version 0.10.5 --step manual-test --executor agent --summary "manual prepublish"
  ```
  Beklenen: Ledger duplicate olusturmaz.

- [ ] **setupVersion drift directive**  
  Adim: Test vault `state/.config.json` icinde `setupVersion`'i eski deger yap, sonra snapshot al.  
  Beklenen: Drift sanitize edilmis directive ile gorunur; bayat varliklar self-heal edilir veya net uyarilir.

---

## 10. Recall, Snapshot Budget, q030 Regression Fix

v0.10.5 recall fix: `src/lib/recall.ts` `CAPTURE_RANK_PENALTY` `0.5 -> 0.4`. Bir Turkce-vocab capture flood'u q030'da curated knowledge/positioning'i geride birakiyordu.

- [ ] **q030 regression (v0.10.5)**  
  Komut: q030 sorgusu icin recall calistir (varsa recall eval: `npm test -- run` icindeki recall/capture-stress testleri).  
  Beklenen: q030 sorgusunda **curated knowledge/positioning capture'larin USTUNDE** siralanir; capture flood artik knowledge'i bastirmaz. `CAPTURE_RANK_PENALTY = 0.4` etkin.

- [ ] **recall v3 filters**  
  Komut: `dreamcontext memory recall "login" --top 10 --types knowledge,feature,task`  
  Beklenen: Type filtresi uygulanir; score/path/snippet okunur.

- [ ] **Turkish + synonym uplift sanity**  
  Komut: `npm test -- run tests/unit/recall-engine-v3.test.ts tests/unit/recall-synonyms.test.ts`  
  Beklenen: Regression yok.

- [ ] **snapshot budget**  
  Komut: `dreamcontext snapshot --tokens` buyuk vault'ta  
  Beklenen: Pinned preview limitleri ve demotion ladder snapshot'i siskin yapmaz.

- [ ] **multi-people attribution**  
  Komut:
  ```bash
  dreamcontext memory remember "ada API testini yazdi" --person ada
  dreamcontext memory recall "ada"
  ```
  Beklenen: Person attribution recall edilebilir.

---

## 11. Dashboard Web UI

Calistirma:

```bash
dreamcontext dashboard --port 4173 --vault /tmp/dctest
```

- [ ] **navigation shell (Sleepy Search & Ask page KALDIRILDI)**  
  Beklenen: Brain/Tasks/Knowledge/Features/Core/Council/Taxonomy/Sleep ve Packs/Settings gruplari + **Agent** sekmesi gorunur. Eski "Search & Ask / Sleepy" dashboard sayfasi **artik yok** — yerini Agent surface (bolum 12) aldi.

- [ ] **static 404 instead of SPA fallback (v0.10.x)**  
  Adim: Var olmayan bir `/assets/<eski-chunk>.js` iste (or. `curl -i http://localhost:4173/assets/does-not-exist.js`).  
  Beklenen: Server **404** doner, HTML SPA fallback DEGIL. Bu, bayat-chunk'larda gorulen `'text/html' is not a valid JavaScript MIME type` hatasini cozer. Test: `tests/unit/server-static.test.ts`.

- [ ] **Tasks Kanban drag/drop**  
  Adim: Task kartini kolon degistir.  
  Beklenen: `PATCH /api/tasks/:slug`; status kalici.

- [ ] **version rename + delete popover (v0.10.x regression)**  
  Adim: Versions popover'da bir version'i **rename** et; baska bir version'a **collision** olacak sekilde rename dene; bir version'i **delete** et.  
  Beklenen: PATCH-rename o version'i tasiyan tum task'lari **re-point** eder ve active pointer'i tasir; collision'da **409**; DELETE uyarir + ref'leri temizler (ghost kalmaz). Route: `src/server/routes/changelog.ts` (handleReleasesUpdate / handleReleasesDelete). Test: `tests/unit/releases-rename-delete-route.test.ts`.

- [ ] **board version smart buckets (v0.10.x)**  
  Adim: Board version filtresinde `@current` / `@backlog` / `@completed` sanal token'larini sec.  
  Beklenen: Virtual bucket'lar dogru task setini gosterir; gercek version'larla birlikte calisir.

- [ ] **multi-assignee AvatarStack (v0.10.x)**  
  Adim: Bir task'a birden cok `person:<slug>` etiketi koy; board card, properties ve gantt'a bak.  
  Beklenen: AvatarStack `person:<slug>` etiketlerini board/properties/gantt'ta okur; her kisi icin **per-person hue** gosterir.

- [ ] **timeline gantt polish (v0.10.x)**  
  Beklenen: Daha kalin bar'lar; viewport-fill zoom; stabil drag.

- [ ] **Task detail panel**  
  Adim: Tags, assignee, feature, due date, RICE ve acceptance criteria checkbox test et.  
  Beklenen: Checkbox `<!-- node:id -->` workflow class'ini sync eder.

- [ ] **Cloud Tasks settings**  
  Adim: Settings > Cloud Tasks.  
  Beklenen: List picker, Test Connection, Provision fields, sync status badge, stale-server banner.

- [ ] **Connections settings**  
  Adim: Settings > Connections.  
  Beklenen: Add/list/toggle shareable; degisim kalici.

---

## 12. In-App Agent Surface (Desktop + Dashboard)

0.10.x'te eklenen buyuk yuzey; publish edildi, burada **regression** dogrularz. Dosyalar: `src/server/routes/agent-terminal.ts`, `src/server/routes/agent-drop.ts`, `src/server/routes/knowledge.ts`, dashboard Agent page, desktop `lib.rs`. ⌘K palette `/api/recall` (BM25 + Haiku toggle) uzerinden, image-drop `agent-drop` route uzerinden vault'a injection yapar, prerequisite installer `/api/agent/install` uzerinden.

- [ ] **multi-session split-pane terminals**  
  Adim: Agent sekmesinde birden cok session ac; pane'leri bol.  
  Beklenen: Her pane'in kendi tab bar'i var; ⌘D drag-to-split calisir; ⌘T yeni, ⌘W kapatir.

- [ ] **detached-DOM persistence (PTY never remounts)**  
  Adim: Pane'i minimize-to-corner dock'a at, geri ac; sekmeler arasi gez.  
  Beklenen: PTY **remount olmaz**; terminal state (scrollback, calisan process) korunur; minimize/restore PTY'yi oldurmez.

- [ ] **⌘K command palette over recall**  
  Adim: ⌘K ile palette'i ac; bir sorgu yaz; Haiku toggle'i ac/kapat.  
  Beklenen: BM25 sonuclari gelir; Haiku toggle acikken re-rank; sonuc secimi terminale enjekte/aksiyon alir.

- [ ] **image-drop -> vault injection**  
  Adim: Agent terminaline bir gorsel surukle-birak.  
  Beklenen: `agent-drop` route gorseli vault'a yazar ve referansini terminale enjekte eder.

- [ ] **prerequisite installer**  
  Adim: Claude CLI veya `node-pty` eksikken Agent'i ac.  
  Beklenen: In-app installer (`/api/agent/install`) Claude CLI / node-pty kurulumunu sunar; net hata mesajlari.

- [ ] **readable ANSI + line-editing keybindings**  
  Beklenen: ANSI renk ramp'i okunur (contrast >= 4.5); macOS line-editing keybinding'leri (kelime atla/sil vb.) terminalde calisir.

---

## 13. Sleepy Quick Capture, Mascot, and Sleep Consolidation

Sleepy notch quick-capture'da **Ask mode deprecated** (yerini Agent surface aldi); Learn/Sleep + mascot duruyor. Bu surumde ayrica atomic **consolidation mutex** ve debt thresholds ×2 rescale geldi.

- [ ] **Learn mode capture**  
  Adim: Notch'ta Learn modunda not yaz, Return.  
  Beklenen: Hemen capture; CHANGELOG note; background enrichment; `claude` interactive login shell ile bulunur.

- [ ] **Sleep mode**  
  Adim: Sleep modunda consolidate baslat.  
  Beklenen: Input locked; mascot asleep; pencere kapanmaz; is bitince ozet ve debt reset.

- [ ] **consolidation mutex (v0.10.x)**  
  Adim: Bir consolidation devam ederken ikinci bir sleep tetiklemeyi dene (ayni veya farkli pencereden).  
  Beklenen: O_EXCL lock ikinci dispatch'i engeller; cift sleep agent yok. Lock 30dk TTL ile self-heal eder (eski/orphan lock'u temizler).  
  Not: Bu adimi ana repo uzerinde consolidation devam ederken calistirma.

- [ ] **debt thresholds rescaled ×2 (v0.10.x)**  
  Beklenen mood/threshold: Alert 0-7, Drowsy 8-13, Sleepy 14-19, Must-Sleep 20+. Mascot: debt < 8 idle; 8-13 drowsy; 14+ sleepy; active sleep asleep.

- [ ] **dead-vault guard**  
  Adim: Secili vault path'ini boz, capture dene.  
  Beklenen: Kullaniciya net hata; server crash yok.

- [ ] **sleep quality eval**  
  Komut: `npm test -- run tests/unit/sleep-system-360.test.ts tests/unit/sleep-consolidation.test.ts tests/unit/sleep-quality-eval.test.ts`  
  Beklenen: Sleep dedup, salience, attribution, quality scorer regression yok.

---

## 14. Desktop App: Launcher, Onboarding, Updates, Orphaned-Server Fix

v0.10.5'in yeni isi: **orphaned dashboard-server fix**. Dosyalar: `src/server/lifecycle.ts` (parent-death watchdog: parent PID signal-0 poll, `DREAMCONTEXT_DESKTOP=1` gated, ESRCH'te fire eder EPERM'de degil; `trackChild`/`killTrackedChildren` reaper), `src/server/index.ts` (idempotent shutdown), `src/server/routes/agent-terminal.ts` (PTY'ler track + reap edilir), `desktop/src-tauri/src/lib.rs` (`reap_server`: ExitRequested VE Exit'te process group'u SIGTERM->SIGKILL; spawn'da `DREAMCONTEXT_PARENT_PID` gecer). Test: `tests/unit/lifecycle.test.ts`.

Dev calistirma:

```bash
cd desktop
DREAMCONTEXT_CLI=../dist/index.js DREAMCONTEXT_VAULT=/tmp/dctest npm run tauri dev
```

- [ ] **no orphaned server after quit/crash/rebuild (v0.10.5)**  
  Adim: Desktop app'i ac (server child spawn olur), sonra sirayla: (a) normal quit, (b) force-quit / crash, (c) dev-rebuild. Her birinden sonra `ps aux | grep "dist/index.js dashboard"` calistir.  
  Beklenen: Her senaryoda **orphaned `node dist/index.js dashboard` process'i KALMAZ**. Parent oldugunde watchdog ESRCH'te fire eder (EPERM'de degil); `reap_server` process group'u SIGTERM->SIGKILL eder; track edilen PTY'ler reap edilir; shutdown idempotent (cift teardown patlamaz).

- [ ] **unit: lifecycle**  
  Komut: `npm test -- run tests/unit/lifecycle.test.ts`  
  Beklenen: trackChild/killTrackedChildren + parent-death watch (gated, ESRCH/EPERM ayrimi) yesil.

- [ ] **launcher empty state + open project**  
  Adim: Launcher'i ac; bir vault kartinda Open.  
  Beklenen: "Launcher - all projects", search, Add Project, project cards; yeni WebviewWindow `?vault=<name>` ile acilir; vault isolation dogru.

- [ ] **onboarding new + existing**  
  Adim: Add Project > Create New (name/folder/description/user/stack/priority/platforms/packs/review); ayrica `_dream_context` olan/olmayan klasorlerle dene.  
  Beklenen: Wizard viewport icinde scroll; platform + skill-pack secimi setup'a yansir; olan klasor icin kisa akis, olmayan icin full quiz; Open project calisir.

- [ ] **desktop app command**  
  Komut: `dreamcontext app --help`  
  Beklenen: install/update/status komutlari/yardimi gorunur.

- [ ] **desktop release workflow static check**  
  Komut: `test -f .github/workflows/desktop-release.yml && grep -nE "uses:|@v" .github/workflows/desktop-release.yml | head`  
  Beklenen: macOS app build + release artifact akisi mevcut; action pin'leri (bumped) tutarli.

---

## 15. Install, Upgrade, Release, CI

- [ ] **CI workflow exists and runs vitest (v0.10.5)**  
  Komut: `test -f .github/workflows/ci.yml && grep -nE "npm test -- run|on:|push|pull_request" .github/workflows/ci.yml`  
  Beklenen: `.github/workflows/ci.yml` her push-to-main + her PR'da `npm test -- run` calistirir. Bu, q030 capture-guard regression'inin 0.10.1/0.10.2'de fark edilmeden yayinlanmasina yol acan boslugu kapatir (eskiden tek CI desktop-release.yml idi, vitest hic kosmuyordu).

- [ ] **upgrade check**  
  Komut: `dreamcontext upgrade --check`  
  Beklenen: Registry check calisir; yeni surum varsa kurmadan bildirir.

- [ ] **snapshot nudge guard**  
  Komut: `dreamcontext snapshot` desktop/app context icindeyken  
  Beklenen: Background auto-upgrade nudge app context'te bastirilir.

- [ ] **install.sh local**  
  Komut: `sh install.sh` temiz test ortaminda  
  Beklenen: CLI kurulur; macOS'ta desktop app de kurulur.

- [ ] **curl install path**  
  Komut:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/meanllbrl/dreamcontext/main/install.sh | sh
  ```
  Beklenen: Sadece repo public + main guncel olduktan sonra test edilir. Publish oncesi `[n/a]`.

- [ ] **GitHub release v0.10.5**  
  Komut: `gh release view v0.10.5`  
  Beklenen: Release varsa assetler ve notes dogru. Yoksa publish blocker degil ama desktop auto-update icin release task'i acik kalir.

- [ ] **npm publish final**  
  Komut:
  ```bash
  npm login
  npm publish --access public
  ```
  Beklenen: Publish basarili (version `0.10.5`); sonrasinda global install smoke test yapilir.

---

## 16. Commit-to-Test Matrix

Bu tablo "ne yaptik?" sorusunun test haritasi. Detayli ham diff icin Appendix A'daki komutlari kullan. **WT** = uncommitted working tree (v0.10.5 payload).

| Area | Representative commits / files | What changed | Test sections |
|---|---|---|---|
| In-app version rename/delete (PUB 0.10.0) | `6638cb5` · `src/server/routes/changelog.ts` · `tests/unit/releases-rename-delete-route.test.ts` | Versions popover'da PATCH-rename task'lari re-point + active pointer tasi (409 collision); DELETE warn + clear refs | 1, 11 |
| Taxonomy audit --fix (PUB 0.10.x) | `bd45856` | Bulk tag normalizer; `--dry-run`/`--json`; idempotent | 5 |
| dreamcontext-deep-research skill (PUB 0.10.x) | `628a275` · `skill-deep-research/` | Fan-out explore + cited synthesis core skill; pakete giriyor | 1 (pack) |
| Task-sync hardening (PUB 0.10.x) | `6297328` (#77) · `bfad6dc` (#78) · `d36c317` · `7a7a9c4` | Reconciliation stable dcId'ye kayar; `sync --reconcile` assignee drift heal; custom-field override; overrides/task.md scaffold | 3 |
| In-app Agent surface (PUB 0.10.x) | `e0b7eca` `fd1072e` `cd8aa36` `c080de0` · `agent-terminal.ts` `agent-drop.ts` | Multi-session split panes, ⌘D/⌘T/⌘W, minimize dock, detached-DOM PTY, ⌘K palette (BM25+Haiku), image-drop, prerequisite installer, ANSI ramp, keybindings | 12 |
| Static 404 (no SPA fallback) (PUB 0.10.x) | `7ab9750` · `tests/unit/server-static.test.ts` | Eksik static asset'te 404; bayat-chunk MIME hatasini cozer | 1, 11 |
| Sleep consolidation mutex + debt rescale (PUB 0.10.x) | `4c9a166` | Atomic O_EXCL lock (30m TTL self-heal); debt thresholds ×2 (0-7/8-13/14-19/20+) | 13 |
| Board smart buckets + AvatarStack + gantt (PUB 0.10.x) | `c8a910d` `dbe8c27` `98f943e` `f37c871` · `dashboard/.../KnowledgePage.tsx` (board) | @current/@backlog/@completed virtual token'lar; multi-assignee AvatarStack (per-person hue) `person:<slug>`; gantt polish | 11 |
| **GitHub task-image bridge (WT)** | `src/lib/image-sniff.ts` · `github-assets.ts` · `github.ts` (`rebuildAssetBridgeFromLocal`) · `sync-state.ts` · `tests/unit/github-assets.test.ts` | Push local image'lari yeni `dreamcontext-assets` branch'ine yukler + body'yi hosted URL'e yazar; pull ters-map; content-addressed dedup; wiped-ledger rebuild conflict'siz; path-containment + magic-byte + size gate | 4 |
| **Orphaned dashboard-server fix (WT)** | `src/server/lifecycle.ts` · `src/server/index.ts` · `agent-terminal.ts` · `desktop/src-tauri/src/lib.rs` · `tests/unit/lifecycle.test.ts` | Parent-death watchdog (signal-0 poll, DESKTOP-gated, ESRCH-fire); trackChild/reaper; idempotent shutdown; `reap_server` SIGTERM->SIGKILL process group; PARENT_PID pass | 14 |
| **First CI workflow (WT)** | `.github/workflows/ci.yml` · `desktop-release.yml` (pins) | Her push-to-main + PR'da `npm test -- run`; q030 regression boslugunu kapatir | 1, 15 |
| **Recall q030 fix (WT)** | `src/lib/recall.ts` (`CAPTURE_RANK_PENALTY` 0.5->0.4) | Turkce-vocab capture flood'u q030'da knowledge/positioning'i bastiriyordu | 1, 10 |
| **Excalidraw overflow-proof render (WT)** | `skill-packs/excalidraw/` · `scripts/diagrams/excalidraw/` | Per-glyph width, wrapToWidth, fitText auto-shrink, connector elbow/via, dangling-embed pre-flight guard | 1, 7 |
| **Knowledge board-folder grouping + asset resolution (WT)** | `dashboard/.../KnowledgePage.tsx` · `src/server/routes/knowledge.ts` · `tests/unit/excalidraw-knowledge.test.ts` | Tek-sahip wrapper klasoru collapse; assets/ ile co-located klasor grouped; `[[img.png]]` board + assets/ altinda cozulur | 7 |
| **Installer hook reconcile (WT)** | `src/cli/commands/install-skill.ts` · `tests/integration/cli-commands.test.ts` | `ensureClaudeHooks` bayat hook timeout'unu guncel spec'e reconcile eder (5s->120s) | 2 |

---

## Appendix A: Commit and Diff Commands Used

Use these to inspect the exact commits and diffs without bloating this file.

```bash
# All commits in the reviewed window (committed 0.10.0-0.10.2 work)
git log v0.9.2..HEAD --date=short --pretty=format:'%h %ad %s'

# Per-commit changed files and line counts
git log v0.9.2..HEAD --numstat --date=short --pretty=format:'@@COMMIT@@ %h %ad %s'

# Committed vs working-tree split (working tree = v0.10.5 payload)
git diff --shortstat v0.9.2..HEAD
git diff --shortstat HEAD
git status --short

# Focused patches — v0.10.5 working-tree payload
git diff -- src/lib/image-sniff.ts src/lib/task-backend/github-assets.ts src/lib/task-backend/github.ts src/lib/task-backend/sync-state.ts
git diff -- src/server/lifecycle.ts src/server/index.ts src/server/routes/agent-terminal.ts desktop/src-tauri/src/lib.rs
git diff -- src/lib/recall.ts
git diff -- dashboard/src/pages/KnowledgePage.tsx src/server/routes/knowledge.ts
git diff -- skill-packs/excalidraw scripts/diagrams/excalidraw
git diff -- src/cli/commands/install-skill.ts
cat .github/workflows/ci.yml

# Focused patches — already-published 0.10.x surfaces
git diff v0.9.2..HEAD -- src/server/routes/changelog.ts src/server/routes/agent-terminal.ts src/server/routes/agent-drop.ts
git diff v0.9.2..HEAD -- src/lib/task-backend
```

---

## Appendix B: Test Result Notes

- Total checked: __ / __
- Blockers:
  - 
- Non-blocking bugs:
  - 
- Publish decision:
  - [ ] Go
  - [ ] No-go
  - [ ] Go with known risks
