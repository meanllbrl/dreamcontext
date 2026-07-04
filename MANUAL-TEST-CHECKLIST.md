# dreamcontext — Son 7 Gün Özeti & Manuel Test Listesi

> Tarih: 2026-07-04 · Branch: `feat/sleep-debt-header-tracker` (main'e merge bekliyor)
> Bu dosya: neyi neden yaptık + senin elle doğrulaman gerekenler. Test ettikçe kutuları işaretle; sorun bulursan altına not düş.

---

## 🎯 Ne yapmaya çalışıyoruz (büyük resim)

İki objective'e hizmet eden bir hafta oldu:

**1. `make-dreamcontext-team-ready` — dreamcontext'i takım çalışmasına hazırlamak.**
Vizyon: Beyin (`_dream_context/`) kod repo'sundan ayrı, kendi GitHub repo'sunda yaşasın. Git bilmeyen insanlar bile beraber çalışabilsin: her uykuda otomatik commit+merge+push, oturum açınca takım güncellemeleri kendiliğinden gelsin, çakışmaları agent semantik olarak birleştirsin. Kimse git komutu yazmasın. Bu hafta bunun **M1 fazı (CLI çekirdeği) tamamen bitti ve doğrulandı** — plan 3 reviewer'dan 5 iterasyonda geçti (21 bulgu), kod 3 tur review'dan geçti (3 bulgu, hepsi regresyon testli düzeltildi), validator 2604 testle PASS verdi.

**2. `simplified-ux` — dashboard/desktop deneyimini sadeleştirmek.**
Roadmap/OKR sistemi, ⌘P proje geçişi, tek tık güncelleme, agent terminal cilası, header'da canlı uyku-borcu göstergesi.

Ayrıca ürün yönü kararı verildi: **"Make it a Business"** — ücretsiz CLI + ücretli kapalı-kaynak uygulama (`3b704fc`).

---

## 📦 Son 7 günde ne gemiye bindi

| Alan | Ne | Commit |
|---|---|---|
| **Brain-sync M1** 🆕 | GitHub beyin-repo senkron çekirdeği: `dreamcontext brain` komut ailesi, uyku sonrası oto-sync, oturum başı sessiz pull, `/dream-sync` skill, secret scrub kapısı, semantik merge + resume/continue, master switch | `d351cc8` |
| Roadmap/OKR | PO-authored objective board + bağımlılık DAG'ı + forecast cascade; dashboard'da interaktif Roadmap sayfası (sürükle-planla, canlı cascade, detay paneli) | `a94b1e8`, `032ed24` |
| Sürümler | v0.10.5 (GitHub task-image köprüsü, ilk CI) + v0.10.6 (cache-bust republish — npx cache kök nedeni çözüldü) | `0d64ca9`, `2283eda` |
| Desktop/Agent yüzeyi | Çoklu-oturum agent panelleri, drag-to-split, ⌘K palet; terminal okunabilirlik + kopyalama + satır-düzenleme kısayolları; Haiku ile sekme oto-adlandırma; Settings→Agents (BETA) paneli | `e0b7eca`, `fd1072e`, `cd8aa36`, `ee42424` |
| Launcher UX | ⌘P proje değiştirici + ⌘1-9 hızlı geçiş, ⌘K/⌘P ortak CommandModal kabuğu, overlay yığını (Esc doğru çalışır), tek-tık "her şeyi güncelle" rozeti | `05556ad`, `10472ba` |
| Header | Canlı uyku-borcu göstergesi + animasyonlu Sleepy yüzü | `7af88ff` |
| Board/Gantt | Sürüm akıllı sekmeleri (Current/Backlog/Completed), çoklu-assignee avatarları, gantt cilası | `c8a910d`, `98f943e`, `f37c871` |
| Sleep altyapısı | Konsolidasyon mutex'i + borç eşikleri ×2 + uzman modelleri Sonnet 4.5'e sabitlendi | `4c9a166`, `2e4caca` |

---

## ✅ Manuel Test Listesi

### A. Brain-sync M1 (en kritik — yeni özellik) 🧠

Önkoşul: CLI rebuild + link yapılmış olacak (aşağıda ben yapıyorum). Testler için boş bir GitHub hesabı/repo'su yeterli; token'ın `repo` scope'lu olmalı (`GITHUB_TOKEN` env veya proje secrets).

- [ ] **A1. Master switch türetilmiş varsayılan:** Bu repo'da `dreamcontext brain status` → `Cloud sync: ON (derived-github-connected)` + `Mode: in-tree` görmelisin. GitHub'sız boş bir klasörde `dreamcontext init` sonrası `brain status` → `OFF (derived-unconnected)` görmelisin.
- [ ] **A2. Aç/kapa:** `dreamcontext brain disable` → status `OFF (explicit)`; `brain enable` → geri ON. Kapalıyken `brain sync` → "Cloud sync is off…" mesajı.
- [ ] **A3. Gerçek repo ile init:** Bir test projesinde (`_dream_context`'i olan ama kod repo'sundan ayrı beyin isteyen) `dreamcontext brain init --owner <github-kullanıcın> --name test-brain` → GitHub'da **private** repo oluşmalı, `dreamcontext-brain` topic'i olmalı, ilk push gitmiş olmalı. `git -C _dream_context remote -v` çıktısında **token GÖRÜNMEMELI** (temiz https URL).
- [ ] **A4. Public onayı:** `brain init --public ...` → yüksek sesli uyarı + onay istemeli.
- [ ] **A5. Scrub kapısı:** Beyindeki bir knowledge dosyasına sahte token yapıştır (`ghp_` + 36 rastgele karakter), `brain sync` → push BLOKLANMALI, hata secret'ın kendisini EKRANA BASMAMALI (kural adı + satır no). Sil, tekrar sync → geçmeli.
- [ ] **A6. İki makine simülasyonu:** Beyin repo'sunu ikinci bir klasöre clone'la, iki tarafta aynı task'ın changelog'una farklı satır ekle, ikisinde de `brain sync` → ikinci push'ta otomatik birleşmeli, iki satır da kaybolmadan durmalı.
- [ ] **A7. Semantik çakışma devri:** İki klonda AYNI knowledge bölümünü farklı yaz → `brain sync` `awaiting-agent` demeli; Claude Code içinde `/dream-sync` de → agent çözmeli, `--continue` ile push gitmeli.
- [ ] **A8. Uyku entegrasyonu:** autoSync açık bir projede bir sleep çevir → `sleep done` çıktısında brain sync satırını görmelisin (in-tree projede sadece commit, asla push).
- [ ] **A9. Oturum başı pull:** Uzak beyinde değişiklik varken projede yeni Claude oturumu aç → sonraki oturum snapshot'ında "N updates from your team were merged in" bildirimi.
- [ ] **A10. Attach güven uyarısı:** `brain attach <url>` → "her oturuma yüklenecek, güvendiğin repo olsun" uyarısı + onay istemeli.

### B. Roadmap / OKR 📊

- [ ] **B1.** Dashboard → Roadmap: 6 objective görünüyor mu, `make-dreamcontext-team-ready` 🔵 on-track ve brain-sync task'i bağlı mı?
- [ ] **B2.** Timeline'da bir task'i sürükle → bağımlı forecast'lar canlı kayıyor mu (cascade)?
- [ ] **B3.** Objective detay panelinde inline düzenleme (tarih, açıklama) kaydediliyor mu?
- [ ] **B4.** `dreamcontext roadmap` CLI çıktısı ile dashboard tutarlı mı?

### C. Launcher & Desktop 🖥️ (Tauri rebuild sonrası)

- [ ] **C1.** ⌘P → proje değiştirici açılıyor, ⌘1-9 hızlı geçiş çalışıyor; ⌘K açıkken ⌘P, Esc sıralaması doğru (üstteki kapanır).
- [ ] **C2.** Header'da güncelleme rozeti: yeni sürüm varken görünüyor, tek tık "Upgrade everything" → canlı log + relaunch.
- [ ] **C3.** Header'da uyku-borcu göstergesi + Sleepy yüzü: borç arttıkça değişiyor mu? (yeni, `7af88ff`)
- [ ] **C4.** Agent terminal: yeni sekme adları Haiku ile otomatik geliyor mu; Settings→Agents panelinde hotkey/reopen-tabs ayarları kalıcı mı?
- [ ] **C5.** Drag: pencereyi hem header'dan hem launcher barından sürükleyebiliyor musun; terminal içinden sürükleme OLMAMALI.

### D. Genel sağlık 🩺

- [ ] **D1.** `dreamcontext doctor` temiz.
- [ ] **D2.** `dreamcontext snapshot` mantıklı (brain-sync task'i in_progress, M1 kriterleri işaretli).
- [ ] **D3.** Bir tam uyku döngüsü sorunsuz (bu hafta mutex + eşik değişti — çift oturumla dene istersen).

---

## 🔜 Sıradaki (senin onayınla)

- **M2:** Launcher'da GitHub device-flow girişi ("GitHub ile bağlan" → kod → tarayıcı onayı), repo oluştur/keşfet/bağla UI, takım güncellemeleri rozeti, Settings'te Cloud sync toggle'ı.
- **M3:** Issue-sync onboarding'i, GitHub login → kişi eşlemesi, `brain detach` (in-tree → ayrı repo taşıma).
- OAuth App kararı: kişisel mi org-owned mu olacak? (Device flow için client ID gerekiyor — 5 dk'lık kurulum, M2 öncesi lazım.)
