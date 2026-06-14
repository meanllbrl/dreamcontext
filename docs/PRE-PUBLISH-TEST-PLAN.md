# Pre-Publish Test Plan

**Version:** v0.8.3  
**Date:** 2026-06-14  
**Window reviewed:** 2026-06-05 -> 2026-06-14  
**Commit range:** `b924fa5..HEAD`  
**Diff size:** 601 files, 69,105 insertions, 79,111 deletions

Bu planin amaci hizli gelistirdigimiz son 7-10 gunluk isleri yayindan once elle, net ve tekrar edilebilir sekilde test etmek. Ham diff cok buyuk oldugu icin plan commitleri risk alanlarina indirger: once otomatik kapilar, sonra en cok kirilma riski olan kullanici akislari.

**Son karar:** `npm publish` icin tum **Blocker Gates** gecmeli. Manual testlerde blocker disi hatalar not dusulup publish kararinda risk olarak tartilabilir.

Isaretleme:

- `[ ]` bekliyor
- `[x]` gecti
- `[!]` hata var
- `[n/a]` bu ortamda test edilmeyecek

---

## 0. Test Hazirligi

### 0.1 Repo ve ortam

- [ ] **Clean tree**  
  Komut: `git status --short`  
  Beklenen: Sadece bu test plani / test diagrami gibi bilinen dokuman degisiklikleri gorunur.

- [ ] **Node**  
  Komut: `node -v`  
  Beklenen: Node >= 18.

- [ ] **Package version**  
  Komut: `node -p "require('./package.json').version"`  
  Beklenen: `0.8.3`.

- [ ] **License**  
  Komut: `node -p "require('./package.json').license"`  
  Beklenen: `Apache-2.0`.

- [ ] **Desktop prereqs**  
  Komut: `cargo --version && rustc --version`  
  Beklenen: Rust/Tauri build icin komutlar calisir.

- [ ] **Claude CLI**  
  Komut: `which claude`  
  Beklenen: Sleepy Ask/Learn enrichment icin path doner.

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

---

## 1. Blocker Gates

Bu bolum kirmiziysa manual teste gecme. Once fix.

- [ ] **1.1 Build**  
  Komut: `npm run build`  
  Beklenen: Dashboard build + CLI build exit 0; `dist/index.js` ve `dist/dashboard/` olustu.

- [ ] **1.2 Full automated suite**  
  Komut: `npm test -- --run`  
  Beklenen: Tum testler yesil. Ozellikle: ClickUp task backend, federation, migrations, launcher, Sleepy, sleep-quality eval.

- [ ] **1.3 Diagrams**  
  Komut: `npm run diagrams`  
  Beklenen: Hata yok. `git status --short` beklenmeyen diagram churn gostermiyor.

- [ ] **1.4 Package dry-run**  
  Komut: `npm pack --dry-run`  
  Beklenen: `dist/`, `skill/`, `skill-packs/`, `install.sh`, `README.md`, `DEEP-DIVE.md`, `LICENSE`, `NOTICE` pakete giriyor. `desktop/src-tauri/target/` gibi build artifact'lari girmiyor.

- [ ] **1.5 CLI smoke**  
  Komut: `node dist/index.js --version && node dist/index.js --help`  
  Beklenen: `0.8.3`; komut listesinde `app`, `vaults`, `connections`, `federation`, `migrations`, `taxonomy`, `config`, `tasks` var.

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

## 3. Tasks: Local Backend + ClickUp Remote Backend

Son hafta en buyuk risk alani bu: local task dosyalari, generic backend, ClickUp adapter, sync, deletion, due date, person/assignee, RICE, dashboard controls.

### 3.1 Local lifecycle

- [ ] **create with RICE**  
  Komut:
  ```bash
  cd /tmp/dctest
  dreamcontext tasks create "Login akis testi" -p high -t backend,auth --reach 8 --impact 4 --confidence 75 --effort 3
  ```
  Beklenen: `state/login-akis-testi.md`; RICE score hesaplandi; workflow bolumu var.

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
  dreamcontext tasks due ui-testleri 2026-07-01
  ```
  Beklenen: Tarih atanınca `backlog` etiketi otomatik kalkar.

- [ ] **person tag uniqueness**  
  Komut:
  ```bash
  dreamcontext tasks tag ui-testleri person:ada
  dreamcontext tasks tag ui-testleri person:mehmet
  ```
  Beklenen: Ayni anda tek `person:*` etiketi kalir.

- [ ] **workflow doctor**  
  Komut: `dreamcontext tasks doctor`  
  Beklenen: Acceptance criteria ile workflow mermaid drift yakalanir; temizse exit 0.

- [ ] **delete path**  
  Komut: `dreamcontext tasks delete ui-testleri --yes`  
  Beklenen: Local task silinir; varsa remote deletion sync'e isaretlenir.

### 3.2 ClickUp remote backend

Opsiyonel ama publish icin yuksek degerli. Token komut argumani olarak yazilmaz; pipe veya env kullan.

- [ ] **guided onboarding**  
  Komut: Settings > Cloud Tasks veya CLI onboarding akisi  
  Beklenen: API token test, workspace/list picker, config yazimi ve restart ihtiyaci net.

- [ ] **provision idempotence**  
  Komut: `dreamcontext tasks provision`  
  Beklenen: urgency, summary, RICE, feature, due_date alanlari olusturulur veya "already exists"; ikinci kosum temiz.

- [ ] **member discovery**  
  Komut: `dreamcontext tasks members --json`  
  Beklenen: ClickUp assignee adaylari listelenir.

- [ ] **sync both**  
  Komut: `dreamcontext tasks sync both`  
  Beklenen: `pushed N, pulled M, created K, deleted L, comments C`; conflict varsa `state/.conflicts/`.

- [ ] **person <-> assignee bridge**  
  Adim: Local task'a `person:<slug>` ata, sync et; ClickUp assignee'yi degistir, pull et.  
  Beklenen: Iki yon de tek kavram gibi davranir.

- [ ] **deletion reconciliation**  
  Adim: Local sil -> sync -> remote silinir. Remote sil -> pull -> local reconcile.  
  Beklenen: Ghost task kalmaz; changelog/sleep journal notu mantikli.

- [ ] **sync lock**  
  Adim: Ayni vault'ta iki sync'i ayni anda tetikle.  
  Beklenen: Ikincisi "another sync running" ile guvenli cikar.

- [ ] **git hook sync**  
  Komut: `dreamcontext tasks sync-hooks install`, sonra test commit.  
  Beklenen: post-commit best-effort sync; git'i kirmaz; yabanci hook varsa saygili davranir.

---

## 4. Taxonomy

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

- [ ] **audit**  
  Komut: `dreamcontext taxonomy audit --json`  
  Beklenen: Etiketsiz, canonical olmayan, orphan ve yakin-tekrar raporu read-only gelir.

- [ ] **dashboard taxonomy page**  
  Adim: Dashboard > Taxonomy.  
  Beklenen: Facet chipleri, kullanim sayilari ve alias okuma gorunumu var.

---

## 5. Features and PRD Freshness

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

- [ ] **feature upkeep evidence**  
  Komut: `node scripts/feature-upkeep-evidence.ts`  
  Beklenen: Feature freshness icin kanit raporu calisir veya guvenli hata verir.

---

## 6. Knowledge: Data Structures, Excalidraw, Fullscreen

- [ ] **knowledge create/index**  
  Komut:
  ```bash
  dreamcontext knowledge create mimari -d "sistem mimarisi" -t architecture
  dreamcontext knowledge index --tag architecture
  ```
  Beklenen: Knowledge file olustu, index aciklama/etiket/tazelik gosterir.

- [ ] **data-structures live under knowledge**  
  Komut: `ls _dream_context/knowledge/data-structures`  
  Beklenen: SQL fenced docs knowledge altinda; core'da eski `5.data_structures.sql` yok.

- [ ] **SQL render in dashboard**  
  Adim: SQL fenced data-structure dokumanini Knowledge view'da ac.  
  Beklenen: ER diagram render olur; PK/FK ve kardinalite okunur.

- [ ] **Excalidraw as first-class knowledge**  
  Adim: `knowledge/diagrams/` altina test board koy, sonra `dreamcontext memory recall "<board text>"`.  
  Beklenen: Extracted text indekslenir; scene JSON recall sonucuna tasmaz.

- [ ] **diagram migration**  
  Komut: `dreamcontext migrations apply-diagrams`  
  Beklenen: Flat board pathleri klasorlenir; wikilink rewrite atomic; ledger dedup calisir.

- [ ] **Knowledge fullscreen overlay**  
  Adim: Dashboard > Knowledge > File/Preview > fullscreen.  
  Beklenen: In-app overlay; Esc kapatir; body scroll kilitli; focus geri doner.

---

## 7. Federation: Multi-Vault Recall, Connections, Digest Inbox

### 7.1 Two-vault setup

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

- [ ] **real concurrency guard**  
  Komut: `npm test -- --run tests/unit/federation-inbox.test.ts`  
  Beklenen: Cross-process inbox writes corruption yaratmaz.

---

## 8. Migration System and Setup Drift

- [ ] **pending migrations**  
  Komut: `dreamcontext migrations pending`  
  Beklenen: setupVersion'a gore pending code/agent migrations listelenir.

- [ ] **ledger record dedup**  
  Komut:
  ```bash
  dreamcontext migrations record --version 0.8.0 --step manual-test --executor agent --summary "manual prepublish"
  dreamcontext migrations record --version 0.8.0 --step manual-test --executor agent --summary "manual prepublish"
  ```
  Beklenen: Ledger duplicate olusturmaz.

- [ ] **setupVersion drift directive**  
  Adim: Test vault `state/.config.json` icinde `setupVersion`'i eski deger yap, sonra snapshot al.  
  Beklenen: Drift sanitize edilmis directive ile gorunur; bayat varliklar self-heal edilir veya net uyarilir.

- [ ] **sleep migration integration**  
  Komut: `dreamcontext sleep start`  
  Beklenen: Epoch pinlenir; pending code migrations calisir; agent migration tasklari saklanir.  
  Not: Bu adimi consolidation devam ederken ana repo uzerinde calistirma.

---

## 9. Recall v3, Snapshot Budget, Multi-People, Agent Feedback

- [ ] **recall v3 filters**  
  Komut: `dreamcontext memory recall "login" --top 10 --types knowledge,feature,task`  
  Beklenen: Type filtresi uygulanir; score/path/snippet okunur.

- [ ] **Turkish + synonym uplift sanity**  
  Komut: `npm test -- --run tests/unit/recall-engine-v3.test.ts tests/unit/recall-synonyms.test.ts`  
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

- [ ] **agent feedback loop**  
  Komut: `dreamcontext feedback --help`  
  Beklenen: Draft/confirm/file akisi dokumante; gh yoksa kullaniciya net fallback.

---

## 10. Dashboard Web UI

Calistirma:

```bash
dreamcontext dashboard --port 4173 --vault /tmp/dctest
```

- [ ] **navigation shell**  
  Beklenen: Brain/Tasks/Knowledge/Features/Core/Council/Taxonomy/Sleep ve Packs/Settings gruplari gorunur.

- [ ] **Tasks Kanban drag/drop**  
  Adim: Task kartini kolon degistir.  
  Beklenen: `PATCH /api/tasks/:slug`; status kalici.

- [ ] **Eisenhower matrix drag/drop**  
  Adim: Kart quadrant degistir.  
  Beklenen: Priority + urgency atomik guncellenir; completed task gorunmez.

- [ ] **Task detail panel**  
  Adim: Tags, assignee, feature, due date, RICE ve acceptance criteria checkbox test et.  
  Beklenen: Checkbox `<!-- node:id -->` workflow class'ini sync eder.

- [ ] **Context menu and delete danger zone**  
  Adim: Kart sag tik > Delete.  
  Beklenen: Onay dialogu; remote backend uyarisi; silme kalici.

- [ ] **Cloud Tasks settings**  
  Adim: Settings > Cloud Tasks.  
  Beklenen: List picker, Test Connection, Provision fields, sync status badge, stale-server banner.

- [ ] **Sync button visibility**  
  Beklenen: Sadece remote backend etkinse Tasks toolbar'da gorunur; durum metni `up/down/error/running`.

- [ ] **Connections settings**  
  Adim: Settings > Connections.  
  Beklenen: Add/list/toggle shareable; degisim kalici.

- [ ] **Knowledge page**  
  Beklenen: File/Preview tabs; Excalidraw preview; SQL ER render; fullscreen overlay.

- [ ] **Taxonomy page**  
  Beklenen: Facets, aliases, counts read-only.

---

## 11. Desktop App: Tauri Launcher, Onboarding, Updates

Dev calistirma:

```bash
cd desktop
DREAMCONTEXT_CLI=../dist/index.js DREAMCONTEXT_VAULT=/tmp/dctest npm run tauri dev
```

Unsigned build:

```bash
cd desktop
npm run tauri build -- --bundles app
```

- [ ] **launcher empty state**  
  Beklenen: "Launcher - all projects", search, Add Project, project cards, empty state.

- [ ] **open project window**  
  Adim: Bir vault kartinda Open.  
  Beklenen: Yeni WebviewWindow `?vault=<name>` ile acilir; vault isolation dogru.

- [ ] **onboarding new project**  
  Adim: Add Project > Create New; name/folder/description/user/stack/priority/platforms/packs/review.  
  Beklenen: Wizard viewport icinde scroll eder; platform secimi ve skill-pack secimi setup'a yansir; Open project calisir.

- [ ] **onboarding existing folder**  
  Adim: `_dream_context` olan ve olmayan klasorlerle dene.  
  Beklenen: Olan klasor icin platforms/packs odakli kisa akis; olmayan icin full quiz.

- [ ] **compact pack cards**  
  Beklenen: Kucuk ekranda cards tasmaz; wizard kullanilabilir.

- [ ] **desktop app command**  
  Komut: `dreamcontext app --help`  
  Beklenen: continuous app update komutlari/yardimi gorunur.

- [ ] **desktop release workflow static check**  
  Komut: `test -f .github/workflows/desktop-release.yml && sed -n '1,80p' .github/workflows/desktop-release.yml`  
  Beklenen: macOS app build + release artifact akisi mevcut.

- [ ] **continuous app update smoke**  
  Adim: App update kontrolunu tetikle.  
  Beklenen: `.app` shell kendini CLI-carried bundle ile guncelleyebilir; Apple notarization'a bagli degil; hata mesajlari net.

---

## 12. Sleepy Notch Quick Capture

Bu alan 2026-06-14'te cok commit aldi; elle mutlaka gez.

- [ ] **enable and hotkey**  
  Adim: Desktop Settings'te Sleepy etkinlestir; `Alt+Cmd+S`.  
  Beklenen: Notch panel acilir; launcher hotkey sahibi; cross-window config degisince re-register olur.

- [ ] **default mode and order**  
  Beklenen: Toggle sirasi `Ask - Learn - Sleep`; default `Ask`.

- [ ] **Ask mode**  
  Adim: Soru yaz, Return.  
  Beklenen: "Sleepy is thinking..." -> markdown render cevap; listeler okunur; yan etki yok.

- [ ] **Learn mode**  
  Adim: Not yaz, Return.  
  Beklenen: Hemen capture; CHANGELOG note; background enrichment calisir; `claude` interactive login shell ile bulunur.

- [ ] **Sleep mode**  
  Adim: Sleep modunda consolidate baslat.  
  Beklenen: Input locked; mascot asleep; pencere kapanmaz; is bitince ozet ve debt reset.

- [ ] **dead-vault guard**  
  Adim: Secili vault path'ini boz, capture dene.  
  Beklenen: Kullaniciya net hata; server crash yok.

- [ ] **mascot moods**  
  Beklenen: debt < 8 idle; debt >= 8 drowsy; active sleep asleep.

- [ ] **WebP autoplay in WKWebView**  
  Beklenen: Mascot play-button olmadan oynar; muted/play fix calisir.

- [ ] **server-side config persistence**  
  Adim: Hotkey/config degistir, app'i restart et.  
  Beklenen: `~/.dreamcontext/sleepy.json` korunur.

- [ ] **vault picker**  
  Adim: Notch dropdown'da vault degistir.  
  Beklenen: Capture target ve sleep debt mood secili vault'a gore degisir.

- [ ] **dismiss behavior**  
  Beklenen: Esc/outside click kapatir; consolidation uctayken kapanmaz.

---

## 13. Launcher Federation Graph and v0.8.3 Polish

- [ ] **per-project status dots**  
  Adim: Launcher'da birden fazla vault ekle.  
  Beklenen: Proje kartlari update/sleep/stale durumlarini ayirt edilebilir gosterir.

- [ ] **interactive graph renders**  
  Adim: Launcher graph gorunumunu ac.  
  Beklenen: Nodes/edges gorunur; bos graph hata vermez; layout readable.

- [ ] **drag to connect**  
  Adim: Bir proje node'undan digerine baglanti kur.  
  Beklenen: Connection kaydi olusur; Settings > Connections ile tutarli.

- [ ] **brain settings persistence**  
  Adim: Graph settings degistir, app restart.  
  Beklenen: Server-side UI settings korunur.

- [ ] **stale vault cleanup**  
  Adim: Registry'deki bir vault path'ini gecersiz yap.  
  Beklenen: Launcher stale gosterir; sync ve graph patlamaz; cleanup akisi net.

- [ ] **launcher route tests**  
  Komut: `npm test -- --run tests/unit/launcher-federation.test.ts tests/unit/launcher-scaffold.test.ts`  
  Beklenen: Launcher backend regression yok.

---

## 14. Sleep Consolidation Quality

- [ ] **sleep 360 tests**  
  Komut: `npm test -- --run tests/unit/sleep-system-360.test.ts tests/unit/sleep-consolidation.test.ts tests/unit/sleep-quality-eval.test.ts`  
  Beklenen: Sleep dedup, salience, attribution, quality scorer regression yok.

- [ ] **no duplicate dispatch**  
  Adim: Consolidation zaten devam ederken yeniden sleep tetiklemeyi dene.  
  Beklenen: Ikinci dispatch engellenir veya net no-op; cift sleep agent yok.

- [ ] **migration + federation specialists**  
  Adim: Sleep start senaryosunda pending migration ve federation signal olustur.  
  Beklenen: Dogru specialist talimatlari uretilir; dosya sahipligi cakisma yaratmaz.

- [ ] **reflect after sleep**  
  Komut: `dreamcontext reflect`  
  Beklenen: Aday terimler sadece review icin; otomatik promotion yok.

---

## 15. Install, Upgrade, Release

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

- [ ] **GitHub release v0.8.3**  
  Komut: `gh release view v0.8.3`  
  Beklenen: Release varsa assetler ve notes dogru. Yoksa publish blocker degil ama desktop auto-update icin release task'i acik kalir.

- [ ] **npm publish final**  
  Komut:
  ```bash
  npm login
  npm publish --access public
  ```
  Beklenen: Publish basarili; sonrasinda global install smoke test yapilir.

---

## 16. Commit-to-Test Matrix

Bu tablo "ne yaptik?" sorusunun test haritasi. Detayli ham diff icin Appendix A'daki komutlari kullan.

| Area | Main commits | What changed | Test sections |
|---|---|---|---|
| v0.6 control panel, native memory, reflection, landing | `b924fa5`, `f98d5d2`, `e66c18e` | Dashboard About/landing, config native-memory, reflect, skill packs, docs diagrams | 1, 2, 9, 10 |
| Relicense and public repo scope | `a020584`, `c62e65a` | Apache-2.0, NOTICE/TRADEMARK, public repo cleanup | 0, 1, 15 |
| Setup/init hardening | `ecfe365`, `486d418` | setup front door, selected-platform completeness | 2 |
| Tasks list/filter and feature authoring | `2e6a48a`, `649a999`, `d9c07bb` | Task filters/grouping, non-lossy inserts, Eisenhower DnD | 3, 5, 10 |
| Data structures and knowledge diagrams | `e7bd1c5`, `49e689f`, `d782095`, `5d09fea`, `40f8fbb`, `8b52232` | Data structures moved to knowledge, SQL fences, Excalidraw knowledge, safe diagram migration | 6, 10 |
| Feature freshness and taxonomy | `d9a7cf4`, `029bf9e`, `9766b34`, `6ca4612` | `features doctor`, taxonomy JSON/vocab/audit/dashboard | 4, 5, 10 |
| ClickUp task backend | `829d6c2` -> `2e9cc0c` | Generic backend, ClickUp config/API adapter, merge/sync, due dates, provision, deletion, locks | 3, 10 |
| Migration system and setup drift | `37fd54d`, `c16c18c`, `55a74e8`, `cb96b44` | setupVersion drift, migration registry/ledger, sleep migration agent | 8, 14 |
| Federation | `971ef7f`, `ba20011`, `f1e3b16`, `32f8a3b`, `f46ff98` | Vault registry, cross-vault recall, connections, digest inbox, stale peers, concurrency | 7, 10 |
| Recall v3 and snapshot budget | `5d05a63`, `8dfb72b` | Recall uplift, snapshot budget, feedback loop, graphify spec | 9 |
| Desktop app and launcher onboarding | `79b9546`, `737ad63`, `c7a6c8c`, `d7fce95`, `3077a02`, `e3dda6d`, `c8b6ca5`, `fb59832` | Tauri macOS beta, app command, continuous update, release workflow, install.sh app install, onboarding wizard | 11, 15 |
| Sleepy notch capture | `64a0899`, `bc98378`, `87db4cd`, `3dcd0c2`, `2814e45`, `a8b35e8`, `1a69f7a`, `0b57126`, `45a314d`, `b30d311`, `79ff49e`, `afc1088`, `5d7fe52`, `a72430f`, `b7cb760`, `3bc0490` | Hotkey, vault picker, Ask/Learn/Sleep, mascot, markdown answer, server-side config, version 0.8.2 | 12 |
| Launcher federation graph and sleep quality | `a41dc7b`, `e7dca76` | Graph UI, per-project status dots, stale cleanup, sleep quality eval, v0.8.3 context | 13, 14 |

---

## Appendix A: Commit and Diff Commands Used

Use these to inspect the exact commits and diffs without bloating this file.

```bash
# All commits in the reviewed window
git log --since='10 days ago' --date=short --pretty=format:'%h %ad %s'

# Per-commit changed files and line counts
git log --since='10 days ago' --numstat --date=short --pretty=format:'@@COMMIT@@ %h %ad %s'

# Overall diff stat from v0.6 baseline to current HEAD
git diff --stat b924fa5..HEAD
git diff --shortstat b924fa5..HEAD

# Full raw patch if needed
git diff b924fa5..HEAD

# Focused patches
git diff b924fa5..HEAD -- src/lib/task-backend src/cli/commands/tasks.ts
git diff b924fa5..HEAD -- src/lib/federation* src/cli/commands/federation.ts
git diff b924fa5..HEAD -- dashboard/src/pages/CaptureBar.tsx dashboard/src/pages/CaptureBar.css
git diff b924fa5..HEAD -- desktop src/cli/commands/app.ts src/server/routes/launcher.ts
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
