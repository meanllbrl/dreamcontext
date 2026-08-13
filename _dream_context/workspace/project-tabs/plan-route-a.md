# A yolu — tek webview, N React instance · dosya dosya plan

Hedef: bir pencerede N proje aynı anda **canlı** dursun, üst şeritte merkez hizalı çip olarak
görünsün, arka plandaki bir projede chat soru sorduğunda o çipin noktası kırmızıya dönsün ve
rozet bekleyen soru sayısını versin.

Taşıyıcı kısıt: **arka plandaki instance unmount edilemez.** PTY canlı WebSocket'e bağlı;
sunucu yalnızca roster metadata'sını saklıyor (`src/server/routes/agent-sessions.ts`), geri
dönüşte uykudaki "Resume" sekmeleri geliyor. Yani gizle (`display:none`), sökme.

Ölçülen yüzey alanı:

| ne | kaç |
|---|---|
| `api/client`'tan import eden dosya | 59 |
| `api.<verb>()` çağrısı | 207 (153'ü `hooks/` içinde) |
| `getActiveVault()` çağrı yeri | 8 dosya |
| vault'lanacak localStorage anahtarı | 9 |
| `<html>` üzerine yazan yer | 3 |
| pencere-global custom event | 3 |

Kritik nokta: çağrı sayısı 207 ama **düzenlenecek satır sayısı ≈ dosya sayısı**. Hook'un
başına `const api = useApi()` eklendiğinde gövdedeki 153 çağrının hiçbiri değişmiyor.

---

## Kararlar (kapandı)

1. **Sekme kalıcılığı — yok.** Her açılışta tek proje: launcher'ın verdiği `?vault=`. Sekmeler
   oturumluk. Açılışta N ağaç kurma problemi tamamen ortadan kalkıyor.
2. **Aynı proje iki yerde açılamaz.** `state/.agent-sessions.json` vault başına tek yazar
   varsayıyor (`src/server/routes/agent-sessions.ts`); iki instance birbirinin roster'ını ezer
   ve aynı konuşma iki kez `--resume` edilir. Zaten açıksa o çip/pencere odaklanır.
3. **Tavan 6 canlı instance.** Tavana ulaşınca canlı oturumu OLMAYAN en eski instance sökülür
   ve "soğuk çip"e döner (tıklanınca yeniden kurulur). Hepsinde canlı oturum varsa yeni sekme
   engellenir ve sebebi söylenir.
4. **Arka planda chat canlı, sayfa poll'u kapalı.** Agent/chat WebSocket'leri hiç kopmaz —
   rozeti besleyen sinyal zaten oradan PUSH ile geliyor. Kapanan şey sayfa verisinin
   `refetchInterval`'ı (tasks, knowledge, lab, sleep debt…). Öne gelince tek seferlik refetch.
5. **Rozet = projedeki aktif chat sayısı; durum renkte.** Sayı her zaman canlı chat adedini
   gösterir; rozetin rengi projenin worst-of durumu: bekleyen varsa kırmızı (+ çip zıplar),
   çalışan varsa mor, hepsi sakinse nötr. Tek glif, iki sinyal — ikinci bir sayı yok.
6. **Yol A** — tek webview, N React instance.

---

## Faz 0 — Sözleşmeler (davranış değişmeden, tek tek merge edilebilir)

Bu fazın sonunda uygulama hâlâ tek-vault. Sadece vault artık modül değişkeni değil, parametre.

### 0.1 `dashboard/src/api/client.ts`
- `ApiClient` sınıfını export et; constructor `vault: string | null` alsın, `request()` header'ı
  modül değişkeni yerine `this.vault`'tan yazsın (bugün `client.ts:84`).
- `agentFileUrl` (`:53`) ve `graphContentUrl` (`:71`) modül fonksiyonu olmaktan çıkıp sınıf
  metodu olsun — ikisi de `activeVault`'u okuyor.
- `export const api = new ApiClient(null)` kalsın: launcher ve vault-agnostik rotalar
  (`/launcher/*`, `/version-check`) bunu kullanmaya devam edecek.
- `setActiveVault` / `getActiveVault` (`:28`, `:37`) `@deprecated` işaretlensin, Faz 2 sonunda silinsin.

### 0.2 Yeni `dashboard/src/context/VaultContext.tsx`
```
VaultProvider({ vault, instanceId, isActive, bus, children })
useVault()  -> { vault, instanceId, isActive, bus }
useApi()    -> useMemo(() => new ApiClient(vault), [vault])
```
`bus` bir `EventTarget` — Faz 2.2'de pencere-global custom event'lerin yerine geçecek.

### 0.3 `dashboard/src/hooks/*.ts` — 36 dosya, dosya başına 1 satır
`import { api } from '../api/client'` → hook gövdesinin başında `const api = useApi()`.
Gövdedeki çağrılar aynen kalıyor.

**Dokunulmayacaklar** (vault-agnostik, singleton `api` doğru olan):
`useLauncher.ts`, `useVersionCheck.ts`.
**Dikkat:** `useServerHealth.ts:32` `/health` çağırıyor ve `contextRoot` döndürüyor — bu
vault'a bağlı. `StaleServerBanner` sürüm için kullanıyor (agnostik), `ProjectContext` ise
`projectId` türetiyor (bağlı). İkiye ayır: `useServerVersion()` (global) + instance içinde
scoped `/health`.

### 0.4 `dashboard/src/components/**` + `dashboard/src/pages/**` — ~23 dosya, dosya başına 1 satır
Aynı değişiklik. `pages/LauncherPage.tsx`, `pages/space/SpaceLauncher.tsx`, `pages/CaptureBar.tsx`
launcher tarafı → singleton `api` ile kalır.

### 0.5 React olmayan modüller — `getActiveVault()` yerine parametre
Bu 8 yer hook kullanamaz, vault'u çağıran taraftan almalı:

| dosya | satır | ne yapıyor |
|---|---|---|
| `components/sleepy/agentSession.ts` | 309, 451 | terminal WS URL'i + `raiseAskAttention` kaynağı |
| `components/sleepy/chatSession.ts` | 423, 589 | chat WS URL'i + `raiseAskAttention` kaynağı |
| `components/sleepy/AgentSurface.tsx` | 1042 | (React — `useVault()` ile) |
| `components/sleepy/chat/ChatViews.tsx` | 99 | (React — `useVault()` ile) |
| `lib/agentDrop.ts` | 21 | drop upload header'ı |
| `lib/agentPrompt.ts` | 64 | prompt token minting |
| `components/tasks/detail/useSectionCollapse.ts` | 22 | storage key (React — `useVault()`) |

`createSession(...)` / `createChatSession(...)` imzalarına `vault` eklenir; `AgentSurface` bunu
`useVault()`'tan geçirir. WS URL'leri zaten `?vault=` taşıyor, sadece kaynağı değişiyor.

### 0.6 Yeni `dashboard/src/lib/scopedStorage.ts`
`hooks/usePersistedState.ts:16-38`'deki deseni (scoped key + eski anahtardan tek seferlik göç)
hook olmayan yerlerin de kullanabileceği saf fonksiyona çıkar:
```
scopedKey(vault, key)      -> 'dreamcontext:<vault>:<key>'
readScoped(vault, key, fallback)
writeScoped(vault, key, value)
```

---

## Faz 1 — Instance kabuğu (hâlâ tek çip, davranış aynı)

### 1.1 Yeni `dashboard/src/ProjectInstance.tsx`
Bir vault'un TAM ağacı:
```
<div className="project-instance" hidden={!isActive} inert={!isActive}>
  <QueryClientProvider client={perInstanceQueryClient}>
    <VaultProvider vault={...} instanceId={...} isActive={...} bus={...}>
      <ProjectProvider>            // context/ProjectContext.tsx, artık scoped /health
        <I18nProvider>
          <Shell>…</Shell>
          <AgentSurface />
        </I18nProvider>
      </ProjectProvider>
    </VaultProvider>
  </QueryClientProvider>
</div>
```
QueryClient instance başına olduğu için **query key'lerine vault eklemeye gerek yok** — cache
izolasyonu ayrı client'tan geliyor. `refetchInterval` `isActive`'e bağlanır (Faz 2.6).

### 1.2 `dashboard/src/App.tsx`
- Modül seviyesindeki `queryClient` (`:59`) kaldırılır → launcher için bir tane, her instance için birer tane.
- Modül seviyesindeki `initialVault` + `setActiveVault(initialVault)` (`:184-191`) kaldırılır.
- Vault dalı (`:257-296`) şuna dönüşür: `<WindowChrome>` + `openVaults.map(v => <ProjectInstance/>)`.
- Chrome'a taşınacak (tekil kalmalı): `ThemeProvider`, `UpgradeRelaunchBanner`,
  `StaleServerBanner`, `ProjectSwitcher`, `AnnouncementsModal`.
- `?vault=` artık **ilk sekmeyi** belirler, pencerenin kimliğini değil.

### 1.3 Yeni `dashboard/src/components/layout/WindowChrome.tsx`
Pencere seviyesi: traffic-light payı, çip şeridi, sağdaki yardımcı kümesi (zoom, tema,
refresh, update badge, sleep debt — bugün `Header.tsx`'te olanlar).
Durum: `openVaults: string[]`, `activeVault: string`, `coldVaults: Set<string>` (tavan
tahliyesiyle sökülmüş çipler).
**Kalıcılık yok** (karar 1): açılışta yalnız `?vault=` sekmesi vardır, sekme listesi diske
yazılmaz.
Tavan (karar 3): 6 canlı instance; aşıldığında canlı oturumu olmayan en eski instance sökülüp
soğuk çipe döner, hepsi doluysa yeni sekme reddedilir.

### 1.4 Yeni `dashboard/src/components/layout/ProjectTabs.tsx` + `.css`
- Merkez hizalı şerit, traffic-light eşiğine (86px) kenetlenmiş.
- **Kural 1 — etkileşimde dondur:** imleç şeridin içindeyken yerleşim sabit; kapatılan çipin
  yeri boş kalır, `pointerleave`'de yeniden ortalanır.
- **Kural 2 — sığmayınca sola geç:** şerit sağ kümeye değince `justify-content: flex-start` +
  yatay kaydırma.
- Çip: durum noktası · ad · rozet · ×. `+` şeridin sonunda.
- Tauri drag: şeridin boş alanı `data-tauri-drag-region`, çipler değil.

### 1.5 `dashboard/src/components/layout/Header.tsx`
- `readVaultLabel()` (`:34`) silinir — ad artık çipte.
- Zoom (`:11-27`, `:99`) ve tema kontrolleri WindowChrome'a taşınır (pencere seviyesi).
- Geriye kalan: rail toggle + arama pill'i + sayfa-içi yardımcılar → instance seviyesinde kalır.

### 1.6 `dashboard/src/components/search/ProjectSwitcher.tsx`
- `currentVault()` (`:21`) URL yerine prop/chrome'dan.
- `pick()` (`:72`): varsayılan artık `onAddTab(name)`; `⇧` basılıysa `openVaultWindow` (eski davranış).
- `goHome()` aynı kalır.
- ⌘1-9 (`:132`) artık pencere değil **bu pencerenin çiplerini** geziyor.
- Tek instance: WindowChrome içinde mount, `App.tsx`'teki iki mount noktası kalkar.

---

## Faz 2 — Global çakışmalar (asıl iş burada)

### 2.1 `<html>` üzerine yazanlar
| dosya | satır | karar |
|---|---|---|
| `components/layout/Shell.tsx` | 78 | `documentElement.dataset.sidebar` → instance wrapper'ına yaz; `--app-content-left` seçicisi `.project-instance[data-sidebar=…]` olur |
| `components/layout/Header.tsx` | 26 | `--zoom` pencere seviyesi → WindowChrome, `<html>` kalabilir |
| `context/ThemeContext.tsx` | 39, 48 | pencere seviyesi → tek ThemeProvider, chrome'da |

### 2.2 Pencere-global custom event'ler → instance bus'ı
| event | üreten | tüketen |
|---|---|---|
| `dreamcontext-navigate` | `Shell.tsx:87` | `AgentSurface` |
| `dreamcontext-agent-open-page` | `AgentSurface` | `App.tsx:100` (`AgentPageNavBridge`) |
| `dreamcontext-zoom` | `Header.tsx:29` | `agentSession.ts` (xterm font) |

İlk ikisi instance'a ait → `useVault().bus` üzerinden. Üçüncüsü pencere seviyesi → `window`'da
kalır, ama **her instance dinler** (hepsinin xterm'i var), bu doğru davranış.

### 2.3 Global kısayollar → yalnız aktif instance
- `Shell.tsx:63` ⌘K → başına `if (!isActive) return`.
- `AgentSurface` ⌘D / ⌘T / ⌘W → aynı.
- `ProjectSwitcher` zaten tekil (chrome'da), gate gerekmez.

### 2.4 URL-as-state — pencerede tek URL var
- `components/lab/funnel/labRoute.ts:50,59,66` `pushState`/`replaceState` yazıyor. Yalnız
  **aktif** instance yazabilsin; pasifken yazma yerine kendi rotasını hafızada tutsun.
- Çip değişiminde chrome, hedef instance'ın son rotasını URL'e geri yazsın.
- `Shell.tsx:16` `/lab/` deep-link okuması yalnız açılıştaki ilk instance için.
- `?vault=` artık tekil olamaz → `labRoute`'un "query string korunur" sözleşmesi güncellenmeli.

### 2.5 localStorage — vault'lanacak 9 anahtar
| dosya | satır | anahtar |
|---|---|---|
| `components/layout/Shell.tsx` | 8 | `dreamcontext.dashboard.activePage` |
| `hooks/useSidebarCollapse.ts` | 3 | `…sidebarCollapsed` |
| `components/sleepy/AgentDock.tsx` | 26 | `dreamcontext.agentDock.collapsed` |
| `lib/agentSettings.ts` | 14 | `agent:settings:v1` |
| `components/layout/Sidebar.tsx` | 84, 86 | `…aboutSeen`, `…githubSyncSeen` |
| `components/search/CommandPalette.tsx` | 29 | `dreamcontext.cmdk.intelligent` |
| `components/council/CouncilShowcase.tsx` | 5 | `…councilShowcaseDismissed` |
| `lib/brainSyncPrefs.ts` | 7 | `…autoCheckpointOnOpen` |
| `components/sleepy/chat/chatEntities.ts` | 2024 | `dreamcontext.chat.mediaBoxes` |

Hepsi `lib/scopedStorage.ts` (0.6) üzerinden, eski anahtardan tek seferlik göçle.

**Zaten scoped, sadece kaynağı değişecek:** `hooks/usePersistedState.ts` (`useProject()` →
zaten instance'a ait, dokunma), `stores/savedViews.ts`, `components/tasks/detail/useSectionCollapse.ts:22`
(`getActiveVault()` → `useVault()`).

**Pencere seviyesi kalacak:** `dreamcontext-theme`, `dreamcontext-zoom`,
`lib/announcements.ts:40` (sürüm bazlı), sleepy config, `lib/checklistStore.ts` (zaten vault taşıyor).

### 2.6 Arka plan maliyeti (karar 4)
Kural: **sayfa verisi durur, agent yüzeyi durmaz.**
- Instance'ın `QueryClient` default'u: `refetchInterval: isActive ? 15_000 : false`,
  `refetchOnWindowFocus: isActive`. Bu, `App.tsx:59-74`'teki bugünkü default bloğunun
  instance'a taşınmış hâli.
- Agent yüzeyinin kendi sorguları bu default'u **açıkça geçersiz kılar** ve arka planda da
  çalışmaya devam eder — özellikle `AgentDock` chip'inin `claudeId` başına canlı durum
  yoklaması (`agentStatus.ts`'in `SessionRow.claudeId` yorumuna bak). Aksi hâlde arka plandaki
  goal-skill koşu rozeti donar.
- Chat/terminal WebSocket'leri hiçbir koşulda kapatılmaz — `isActive` onları hiç görmez.
- Instance pasifken `Header`'ın manuel `refetchQueries` butonu devre dışı.

### 2.7 `lib/overlayStack.ts`
Modül-global. Bir instance gizlenirken açık modalı stack'te kalabilir → gizleme anında o
instance'ın overlay'lerini `popOverlay` ile temizle.

---

## Faz 3 — Çip rozeti

### 3.1 `components/sleepy/agentStatus.ts`
Var olan `KIND_RANK` (`:28`) worst-of mantığını proje seviyesine çıkar:
```
rollupProject(rows: SessionRow[]) -> {
  worst: SessionStatusKind,   // nokta + rozet rengi
  live: number,               // rozetteki SAYI — dormant olmayan chat'ler (karar 5)
  waiting: number,            // asking + attention — zıplamayı tetikler
}
```
Saf fonksiyon, test edilebilir. `live` sayımına `saved` (dormant "Resume") satırları girmez.

### 3.2 `components/sleepy/AgentSurface.tsx`
`:1772-1784` zaten `SessionRow[]` üretiyor (`attention`, `dormant` dahil). Rollup'ı
`useVault().bus` üzerinden yayınla; chrome dinlesin.

### 3.3 `components/layout/ProjectTabs.tsx` (karar 5)
- rozetteki **sayı** = `live` (projedeki aktif chat adedi); 0 ise rozet hiç çizilmez
- rozetin **rengi** = `worst`: `asking` → kırmızı, `working` → mor, gerisi nötr
- nokta da aynı `worst`'ü taşır
- zıplama: `waiting` 0'dan büyüğe geçtiğinde tek seferlik CSS animasyonu
  (`prefers-reduced-motion` altında yalnız renk değişir)

### 3.4 `lib/attention.ts:86`
`raiseAskAttention({ source })` — `source` zaten vault adı. Chrome bunu dinleyip ilgili çipi
zıplatsın. Chime (`lib/chime.ts`) tekil kalır, N kez çalmasın.

---

## Faz 4 — Pencere ↔ sekme köprüsü

- `lib/desktop.ts:442` `goToProject` → varsayılan davranış artık **sekme ekle**.
  `openVaultWindow` (`:323`) "yeni pencerede aç" için olduğu gibi kalır.
- **Çift açılma koruması:** bir vault başka bir pencerede zaten açıksa sekme ekleme, o pencereyi
  odakla. `vaultWindowLabel` (`:312`) hâlâ pencere → vault eşlemesi, ama artık bir pencere N
  vault taşıyabildiği için label sözleşmesi değişmeli (pencere id'si + o pencerenin vault listesi).
  Aynı PTY iki yerde açılırsa oturum bozulur — bu, fazın en riskli maddesi.
- Çipi şeritten dışarı sürükleme = `openVaultWindow` + sekmeyi kapat.
- `lib/checklistStore.ts` ve checklist penceresi vault'u zaten açıkça taşıyor — dokunma.

---

## Riskler / önce doğrulanacaklar

1. **`display:none` altında xterm.** `agentSession.ts:240` ve `chatSession.ts:417` detached
   container kullanıyor; sıfır boyutta açılan bir oturum yanlış satır/sütun alır. Çip
   değişiminde `fit()` + `resize` şart. Bunu Faz 1'de iki sekmeyle elle doğrula.
2. **`vaultWindowLabel` sözleşmesi.** Bir pencere = bir vault varsayımı `desktop.ts`'in her
   yerinde; checklist submit köprüsü `emitTo` ile label'a göre hedefliyor. Faz 4'ten önce bu
   köprünün hedeflemesi güncellenmeli.
3. **Bellek ve CPU.** N × React ağacı + N × xterm + N × WS. Sekme tavanı konuşulmalı (öneri: 6).
4. **`StrictMode` çift mount × N instance** — PTY spawn'ların idempotent olduğu doğrulanmalı.

## Doğrulama

- `/verify` skill'i (izole scratch vault + gerçek sunucu): iki vault kaydet, iki sekme aç,
  birinde chat'e soru sordur, öteki çipte rozetin çıktığını gör.
- `npx tsc --noEmit` hem kökte hem `dashboard/`'da.
- Playwright: `e2e/alignment.spec.ts` desenini izleyen yeni `e2e/project-tabs.spec.ts`.

## Sıra önerisi

Faz 0 tamamen davranış-nötr ve tek tek merge edilebilir — önce o bitsin. Faz 1 tek çiple
çalışır durumda kalır (regresyon riski düşük). Faz 2 asıl iş. Faz 3 ve 4 üstüne oturur.
