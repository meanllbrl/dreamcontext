# Follow-up prompt — interaktif proje kurulumu (dreamcontext-beta)

> Yeni bir Claude Code / dreamcontext oturumunda **aşağıdaki bloğu yapıştır**. Amaç:
> yeni bir projeye dreamcontext kurmak **ya da** var olan bir klasöre eklemek,
> sonra dreamcontext-beta masaüstü uygulamasında vault olarak göründüğünden emin olmak.

---

dreamcontext-beta masaüstü uygulamam kurulu (`/Applications/dreamcontext-beta.app`).
Launcher tüm projeleri listeliyor, her proje `Open →` ile kendi penceresinde açılıyor,
`+ Open Project` native macOS klasör seçicisiyle de proje eklenebiliyor.

Bana **interaktif** rehberlik et:

1. Önce sor: **yeni bir proje mi** oluşturuyoruz, yoksa **var olan bir klasöre mi** kuruyoruz?
2. **Yeni proje** ise: proje adını ve üst dizini sor (varsayılan `~/projects`), klasörü oluştur.
   **Var olan klasör** ise: tam klasör yolunu sor.
3. O klasörde `dreamcontext setup` çalıştır (init + skill + instructions; `_dream_context/` oluşur).
4. Ardından **dreamcontext-initializer** akışını interaktif yürüt — kodu/araçları/tech-stack'i
   tarayıp bana sorular sorarak `_dream_context/`'i zengin doldur (soul, user, memory, tech_stack,
   ilk task/knowledge). Boş bir iskelet bırakma.
5. `dreamcontext vaults add "<ad>" "<MUTLAK-yol>"` ile vault olarak kaydet, `dreamcontext vaults list`
   ile doğrula.
6. Bana söyle: dreamcontext-beta launcher'ında görünecek (uygulama açıksa launcher penceresini
   yenile/sayfayı reload et; ya da `+ Open Project` ile native seçiciden de eklenebilir).
   Sonra projeyi `Open →` ile kendi penceresinde aç.

Bu oturumda öğrendiklerimizi hatırla ve gerektiğinde uygula — özellikle
`knowledge/desktop-beta-tauri-multivault.md`: beta app tek bir Node server'ı **launcher modunda**
boot ediyor, her pencere `?vault=<ad>` ile kendi vault'unu pinliyor (→ `X-Dreamcontext-Vault`
header → per-request contextRoot), vault registry `~/.dreamcontext/vaults.json`, çoklu pencere
built-in `WebviewWindow` API ile açılıyor.

---

## Hızlı referans (manuel yapmak istersen)```bash
# YENİ proje
mkdir -p ~/projects/<ad> && cd ~/projects/<ad>
dreamcontext setup                 # _dream_context/ + skill + instructions
# (initializer agent bir dreamcontext oturumunda zengin doldurur)
dreamcontext vaults add "<ad>" "$(pwd)"

# VAR OLAN klasör
cd /path/to/existing
dreamcontext setup
dreamcontext vaults add "<ad>" "$(pwd)"

dreamcontext vaults list           # doğrula → launcher'da görünür```