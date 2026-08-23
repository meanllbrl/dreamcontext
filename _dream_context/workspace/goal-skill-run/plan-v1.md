I've read the specs, the design files, and every anchor. Here is the plan.

---

# IMPLEMENTATION PLAN — D1 Composer redesign → D2 Pinned shelf

**Grounding:** every anchor below was read on 2026-08-23. Deviations from the design files are marked **[Δ]** with a reason.

---

## 0. Decisions pinned before the file list

| # | Question | Decision | Why / evidence |
|---|---|---|---|
| P1 | Are the four popovers portaled (`Popover`) or absolute children of `.chat-cmp`? | **Absolute children of `.chat-cmp`**, opening upward via `bottom: calc(100% - 4px)`. New local `useAnchoredMenu` handles Esc (via `overlayStack`) + outside-pointerdown. | The design's menus are full-card-width and line up with the card edges; `.chat-cmp-slash` (composer.css:236-252) already proves an absolute upward menu escapes `.chat-cmp-card`'s `overflow:hidden`. `Popover`'s portal clamps to a *trigger*, which can't produce the full-width menu. |
| P2 | Attach: bare icon (design) or keep its menu? | **Bare `chat-cmp-iconbtn` trigger, menu retained** via the existing portaled `Popover align="left"`. **[Δ]** | Design's attach has no `onClick`/menu, but files/folders/task pick is existing behaviour the goal forbids regressing (`Composer.tsx:715-732`). |
| P3 | Send button count | **Keep all three** (stop / queue / send) with design's disc styling. **[Δ]** | Design shows one; `Composer.tsx:822-856` queue/stop states are named non-regressable. |
| P4 | Model price + insight copy source | **price → server** (one table: `MODEL_PRICING`, agent-terminal.ts:1050-1056, exposed as `ModelOption.priceIn`); **insight/badge → client static map** in `agentComposer.ts`. | Product copy isn't server data; a second price table would drift from the cost readout's. |
| P5 | Mode default | **No user default — the constant `'basic'`.** Per-session mode persists in the roster. | Owner delta 1 removed "Set as default" from the mode menu, so there is no surface to set one. |
| P6 | Changing mode on a LIVE session | **Respawn with `--resume`** under the new briefing, reusing `resumeChatSession` (AgentSurface.tsx:755-765). The menu says so. | A `--append-system-prompt-file` is spawn-time only. This is the exact precedent `changeChatPermissionMode` already uses as its fallback (AgentSurface.tsx:777-788). |
| P7 | Plan→Develop trigger | **New `ChatActionKind: 'develop'`** taking `id` (task slug), rendered as a `dream-actions` button the Plan agent writes. `ChatPane.handleAction` → `actions.handoffToDevelop(session, slug)`. | Smallest addition inside existing machinery (`chatActions.ts:32-34`, ChatPane.tsx:1237-1259), exactly parallel to `url`. `ask` only loads the composer, so it can't do the handoff. |
| P8 | Session facts channel | **Split**: branch + worktree marker are **server-derived** (`GET /api/agent/session-facts`, polled); the **dev-server port is agent-pinned** (a `pin` fact with a loopback `url`). | The server cannot know which port belongs to which session — it would have to scan listening sockets and guess across projects. The agent ran the command, so it knows. Server facts need no agent honesty; the port can't be had any other way. |
| P9 | 5h / weekly usage limits | **Ship context + cost only.** The usage popover renders `UsageLimit[]`; `Composer` passes `[]`. | I could not verify any local source: `~/.claude` is outside the session's allowed directory (`ls` blocked), and the prompt's own exploration found none in settings.json / `~/.claude.json` / transcript JSONL / routes. Extension point named in §4. |
| P10 | Progress percent source | Local file `_dream_context/state/<slug>.md` via `readSection(file,'Acceptance Criteria')` + `countCheckboxes` (markdown.ts:330-341) — **not** `backendFor(contextRoot).get(slug)`. | ClickUp/GitHub backends don't carry the checkbox body; `tasks doctor` counts the local file (tasks.ts:1697-1702), and the criterion says "the same number". |
| P11 | Shelf pin extraction | From `ChatTextItem`s with `done === true` only, incrementally via a cursor ref; seeded from `pinStore` on mount. | `ChatTextItem` carries `done` (chatSession.ts:69). `parseChatActions` is already memoized per item in TranscriptItem.tsx:189-191; a full re-scan per render would be O(items) per token. |
| P12 | Shelf narrow mode | `container: pinshelf / inline-size` + `@container pinshelf (max-width: 470px)`, not the design's JS `is-narrow` prop. **[Δ]** | Matches composer.css:668-715's existing idiom; needs no width measurement in JS. |
| P13 | Server session facts dismissable? | **No** — only agent pins carry `×`. **[Δ]** | The design draws `pin-chip-x` on the branch chip, but a polled fact would return on the next tick. M2's "user can dismiss a pin" is about pins. |

---

## 1. File-by-file plan

### D1 — Composer redesign

#### 1.1 `dashboard/src/lib/agentComposer.ts` — MODIFY
- **After `FALLBACK_MODEL_CONFIG` (line 186):** extend `ModelOption` with `priceIn?: number | null` (USD per M input tokens, from the server).
- **New export block "Model presentation" (after `modelLabelFor`, line 213):**
  ```ts
  export interface ModelNote { insight: string; badge?: string }
  export const MODEL_INSIGHTS: Record<'fable'|'opus'|'sonnet'|'haiku', ModelNote>;
  /** Family-matched note for any id, or null — same family match `modelLabelFor` uses. */
  export function modelNoteFor(id: string): ModelNote | null;
  /** Primary rows vs the "Other models" disclosure. The CURRENT model is always primary,
   *  so a selected "other" model is never hidden behind a closed disclosure. */
  export function splitModels(config: ModelConfig, current: string, primaryCount?: number):
    { primary: ModelOption[]; other: ModelOption[] };
  ```
- **New export block "Effort slider":**
  ```ts
  export function effortIndex(efforts: string[], level: string): number;   // clamped, never -1
  export function effortAt(efforts: string[], index: number): string;      // clamped
  ```
- **New export block "Usage":**
  ```ts
  export interface UsageLimit {
    key: 'context' | 'session5h' | 'weekly';
    title: string; used: number; limit: number;
    /** epoch ms when the window resets, or null when unknown. */
    resetsAt: number | null;
  }
  /** Context first, then whatever extra limits a source supplied. A limit with no source
   *  is ABSENT from the array — never a zeroed ring (owner delta 4: show what's found). */
  export function usageLimits(ctx: ContextUsage | null, extra: UsageLimit[]): UsageLimit[];
  ```
- **Contract exposed:** `MODEL_INSIGHTS`, `modelNoteFor`, `splitModels`, `effortIndex`, `effortAt`, `UsageLimit`, `usageLimits`.

#### 1.2 `src/server/routes/agent-terminal.ts` — MODIFY
- **`buildModelConfig()` (line 974-983):** map each `models[i]` to `{...m, priceIn: priceForModel(m.id).in}`. `priceForModel` already exists at line 1058.
- **Contract:** `GET /api/agent/model-config` responses gain `models[].priceIn: number`.

#### 1.3 `dashboard/src/components/sleepy/chat/useAnchoredMenu.ts` — CREATE
```ts
export type ComposerMenuId = 'mode' | 'model' | 'usage' | null;
export function useAnchoredMenu(): {
  open: ComposerMenuId;
  toggle: (id: Exclude<ComposerMenuId, null>) => void;   // opening one closes the others
  close: () => void;
  /** Attach to `.chat-cmp` so an outside-pointerdown closes; menus are its children. */
  rootRef: React.RefObject<HTMLDivElement>;
};
```
- Registers on `overlayStack` (`pushOverlay`/`popOverlay`/`isTopOverlay`, as `Popover` does at SkillPickerPopover.tsx:42-61) so Esc arbitrates LIFO and does not steal an Esc meant for a stacked overlay.
- Closes on `pointerdown` outside `rootRef`.

#### 1.4 `dashboard/src/components/sleepy/chat/ComposerMenus.tsx` — CREATE
Three exported presentational components, all `position:absolute` inside `.chat-cmp` (P1). No state of their own beyond local disclosure toggles.

```ts
export type ChatMode = 'basic' | 'plan' | 'develop' | 'jarvis';
export const CHAT_MODE_ROWS: Array<{ id: ChatMode; name: string; insight: string; badge?: string; disabled?: boolean }>;

export function ModeMenu(p: {
  mode: ChatMode; onModeChange: (m: ChatMode) => void;
  permission: 'auto' | 'bypass'; onPermissionChange: (m: 'auto'|'bypass') => void;
  close: () => void;
}): JSX.Element;

export function ModelMenu(p: {
  config: ModelConfig; model: string; effort: string;
  onModelChange: (id: string) => void; onEffortChange: (level: string) => void;
  onSetDefault: () => void; savedDefault: boolean;
  close: () => void;
}): JSX.Element;

export function UsageMenu(p: { limits: UsageLimit[]; costUsd: number | null }): JSX.Element;
```
- `ModeMenu`: `.chat-cmp-modemenu.chat-cmp-modelmenu` → grouplabel "Mode" → `.chat-cmp-scroll.is-grid` of 4 `.chat-cmp-modelrow` (J.A.R.V.I.S `disabled` + `.chat-cmp-badge.is-muted` "Soon") → divider → `.chat-cmp-permrow` with the Auto/Bypass `.chat-cmp-segment` (`role="menuitemradio"`, `aria-checked`) → `.chat-cmp-permnote` (the selected permission's description) → **a second `.chat-cmp-permnote` line: "Switching mode reloads this conversation — the transcript is kept."** (P6). **No `.chat-cmp-menu-foot` / `saveModeDefault`** (owner delta 1).
- `ModelMenu`: grouplabel "Model" → `.chat-cmp-scroll` of `splitModels().primary` rows (`name` + optional `.chat-cmp-badge` + `.chat-cmp-modelrow-meta` = `$${priceIn}/M in` when `priceIn != null` + `.chat-cmp-modelrow-insight`) → `.chat-cmp-disclosure` "Other models" → `.other` rows → divider → `.chat-cmp-effort-head` (label + current value) → `<input type="range" class="chat-cmp-effort-slider" min=0 max={efforts.length-1}>` driven by `effortIndex`/`effortAt` → `.chat-cmp-effort-ticks` → `.chat-cmp-menu-foot` with `.chat-cmp-setdefault` reading "Set as default"/"Saved as default" (**kept** — owner delta 1).
- `UsageMenu`: one `.chat-cmp-usagerow` + `.chat-cmp-usagebar` + `.chat-cmp-usagemeta` **per entry of `limits`** (so an absent limit renders nothing at all), then divider + "Estimated cost" row + `.chat-cmp-usagenote`.
- **Contract:** the three signatures above; `ChatMode` is re-exported from here for the client side (the server's own copy lives in `src/server/chat-modes.ts`, §1.7).

#### 1.5 `dashboard/src/components/sleepy/chat/Composer.tsx` — MODIFY (chrome only)
Untouched: lines 138-232 (draft/history/focus/attachments), 245-279 (`onPaste`), 285-329 (slash menu), 331-423 (auto-grow + drag handle), 447-536 (`submit`/`commit` minus the skill fold), 549-568 (slash menu JSX), 571-584 (handle), 636-703 (textarea).

Changes:
1. **Imports (6-20):** drop `SkillBrowser`, `ContextReadout`, `PermissionModeMenu`; add `useAnchoredMenu`, `ModeMenu`/`ModelMenu`/`UsageMenu`, `splitModels`/`effortIndex`/`usageLimits`/`modelNoteFor`.
2. **Props (103-134):** add
   ```ts
   mode: ChatMode;
   onModeChange: (m: ChatMode) => void;
   /** True while the pinned shelf has an open row — squares the card's top corners (D2). */
   shelved?: boolean;
   ```
   Keep `permissionMode` / `onPermissionModeChange` verbatim.
3. **Delete `skillChip` state (283)** and every reader: `hasSendableContent` (455-456), `liveRef` (461-462), `commit`'s `withSkill` (477), `setSkillChip(null)` (518), the `useLayoutEffect` dep (376), and the `.chat-cmp-skillchip` JSX (601-607).
4. **Placeholder (640):** `'Message Claude…  ·  "/" for skills'` in the idle arm (owner delta 2). Busy/connecting arms unchanged.
5. **Card (570):** `className={'chat-cmp-card' + (shelved ? ' is-shelved' : '')}`.
6. **Toolbar (706-858)** replaced by, in order:
   - `.chat-cmp-perm-wrap` → `<button className="chat-cmp-modeltrigger" aria-expanded={open==='mode'} aria-haspopup="menu">` with `.chat-cmp-modeltrigger-model` = mode name, `.chat-cmp-modeltrigger-effort` = permission, `.chat-cmp-caret`.
   - the Attach `Popover` (P2), trigger restyled to `.chat-cmp-iconbtn` with `PlusIcon` only + `aria-label="Attach"` + `title`; **menu body unchanged** (three `role="menuitem"` rows).
   - `<div className="chat-cmp-spacer" />`
   - `.chat-cmp-right`:
     - `<button className="chat-cmp-usagebtn" role="meter" aria-valuenow aria-valuetext title={fullReading}>` with the 16px SVG ring (`stroke-dasharray` from `2πr × pct`), `data-tight` past `CONTEXT_TIGHT_PCT`.
     - the `/compact` button (`.chat-cmp-compact-btn`, existing markup from ContextReadout.tsx:135-146) — rendered **only** when `isTight`, so density AC7's "escalates without hover" survives.
     - `<button className="chat-cmp-modeltrigger" aria-expanded={open==='model'}>` model label + effort label + caret.
     - the three send/queue/stop buttons, unchanged logic (822-856), restyled to `.chat-cmp-send{,.is-queue,.is-stop}`.
7. **Menus** rendered as siblings of `.chat-cmp-card` inside `.chat-cmp` (beside the slash menu at 549), each gated on `open === '…'`.
- **Contract:** the new `mode`/`onModeChange`/`shelved` props; DOM classes `.chat-cmp-modeltrigger`, `.chat-cmp-iconbtn`, `.chat-cmp-usagebtn`, `.chat-cmp-send` (verify scripts + the manual checklist key off these).

#### 1.6 `dashboard/src/components/sleepy/chat/composer.css` — MODIFY
- **Add**, translated from `composer.design.css` with `--font-text` → `--font-family-text` (the only token that differs; everything else — `--color-bg{,-secondary,-tertiary,-elevated}`, `--color-border{,-hover}`, `--color-text{,-secondary,-tertiary}`, `--color-accent{,-soft}`, `--color-warning`, `--font-mono`, `--radius-{sm,lg}`, `--transition-fast` — exists verbatim in `dashboard/src/styles/tokens.css`):
  `.chat-cmp-modeltrigger{,-model,-effort}`, `.chat-cmp-iconbtn`, `.chat-cmp-usagebtn`, `.chat-cmp-usagering-{track,fill}`, `.chat-cmp-usagemenu`, `.chat-cmp-usagerow{,-title,-value}`, `.chat-cmp-usagebar{,-fill}`, `.chat-cmp-usagemeta`, `.chat-cmp-usagenote`, `.chat-cmp-{modelmenu,modemenu,scroll,grouplabel,modelrow*,badge,disclosure*,permrow,segment*,permnote,menu-divider,effort-*,menu-foot,setdefault,right}`, `.chat-cmp-send.is-{enabled,stop,queue}`.
  Menus: `position:absolute; left:12px; right:12px; bottom:calc(100% - 4px); z-index:30;` (mirrors `.chat-cmp-slash`, line 236-252). `.chat-cmp-modemenu{ right:auto }` per design line 582.
- **Add** `.chat-cmp-card.is-shelved { border-radius: 0 0 var(--radius-lg,14px) var(--radius-lg,14px); border-top-color: transparent; }`
- **Delete**: `.chat-cmp-skillchip{,-label}` (134-149), `.chat-cmp-spark` (413), `.chat-cmp-readout` (420-426), `.chat-cmp-ctx*` inline-gauge rules (434-497), `.chat-cmp-ctxcard*` (524-604), `.chat-cmp-pill{,-label}` (611-635).
- **Rewrite the container queries (668-715)** for the new row:
  - `≤560px`: `.chat-cmp-modeltrigger-effort { display: none }` on the **mode** trigger only (the permission word drops; the mode name stays).
  - `≤470px`: `.chat-cmp-toolbar { gap:3px; padding:7px 8px }`, `.chat-cmp-compact-label { display:none }`.
  - `≤380px`: `.chat-cmp-right .chat-cmp-modeltrigger-effort { display:none }`, `.chat-cmp-modeltrigger-model { max-width:62px; overflow:hidden; text-overflow:ellipsis }`.
  - `.chat-cmp-toolbar { flex-wrap: nowrap }` preserved — the one-row rule.

#### 1.7 `src/server/chat-modes.ts` — CREATE
```ts
export const CHAT_MODES = ['basic', 'plan', 'develop', 'jarvis'] as const;
export type ChatMode = typeof CHAT_MODES[number];
export const DEFAULT_CHAT_MODE: ChatMode = 'basic';

/** The per-mode system-prompt append, or '' for a mode that adds nothing.
 *  `worktreeAllowed` gates the ONE sentence in the develop briefing that permits worktrees. */
export function modeBriefing(mode: ChatMode, opts: { worktreeAllowed: boolean }): string;
```
- `basic` → `''`. `jarvis` → `''` (it is never selectable; coerced to `basic` at the sanitizer, this arm is defence in depth).
- `plan` → goal-skill's planning half: ask the critical questions, drive decisions interactively, review them, plan every phase, **end by creating a dreamcontext task and presenting the task doc**, and then emit the handoff button:
  ```dream-actions
  [{"label":"Go to development","action":"develop","id":"<the-task-slug>"}]
  ```
- `develop` → goal-skill's implement half: waves, validation, evidence as it goes. Worktree sentence emitted **only** when `worktreeAllowed`; otherwise an explicit "**Do not** create a git worktree in this project — the brain lives in-tree."
- Kept SHORT (chat-surface.ts:20 — "it rides in the system prompt of every chat turn").

#### 1.8 `src/lib/worktree-gate.ts` — CREATE
```ts
/** May a Develop-mode agent create a git worktree here? True only when the dreamcontext
 *  brain is ISOLATED — `resolveMode(config) === 'full-repo'` (git-sync/brain-repo.ts:79-81)
 *  or at least one linked repo is present on this machine (linked-repos.ts:148). Never
 *  throws. */
export function worktreeIsolationAllowed(projectRoot: string): boolean;
```
Reads `readSetupConfig(projectRoot)` (setup-config.ts:288) → `resolveMode` → `|| resolveLinkedRepos(projectRoot).some(r => r.present)`.

#### 1.9 `src/server/routes/agent-spawn-shared.ts` — MODIFY
- After `sanitizeEffort` (line 86-88):
  ```ts
  /** Chat mode gate. Anything outside CHAT_MODES — and `jarvis`, which is UI-disabled and
   *  has no behaviour — resolves to 'basic'. */
  export function sanitizeChatMode(v: string | null): ChatMode;
  ```
  Imports `CHAT_MODES`/`ChatMode` from `../chat-modes.js`. (Deliberately does **not** import `modeBriefing`, so the lockstep test's "only agent-chat.ts carries the briefing" scan over `src/server/routes/*.ts` stays true.)

#### 1.10 `src/server/routes/agent-chat.ts` — MODIFY
- **Upgrade handler (line 306):** `const mode = sanitizeChatMode(url.searchParams.get('mode'));`
- **Line 333:** pass `mode` into `startChatSession`.
- **`ChatSpawnOpts` (341-349):** add `mode: ChatMode`.
- **Briefing write (435-445):** one file, two parts —
  ```ts
  const extra = modeBriefing(mode, { worktreeAllowed: worktreeIsolationAllowed(projectRoot) });
  writeFileSync(brief, extra ? `${CHAT_SURFACE_BRIEFING}\n${extra}` : CHAT_SURFACE_BRIEFING, …);
  ```
  Same `isShellSafePath` guard, same `cleanupBriefing`, same degrade-to-unbriefed `catch`. **No second `--append-system-prompt-file`** — argv (447-459) is unchanged.
- **Doc comment (285-287):** add `&mode=basic|plan|develop`.
- **Contract:** the WS URL accepts `mode`; an absent/unknown value is `basic`.

#### 1.11 `dashboard/src/components/sleepy/chat/chatActions.ts` — MODIFY
- **`ChatActionKind` (32) + `ACTION_KINDS` (34):** add `'develop'`.
- **`ChatAction` (36-47):** document `id` as also covering `develop` (the task slug).
- **`toAction` (111-122):** `case 'develop': return id && SAFE_SLUG_RE.test(id) ? { label, action:'develop', id } : null;` with `const SAFE_SLUG_RE = /^[A-Za-z0-9._-]+$/` (mirrors `CHECKLIST_ID_RE`, chatViewSpec.ts:555 — no `/`, no `..`, so the slug can never become a traversal).
- **Contract:** `{"label":"…","action":"develop","id":"<slug>"}`.

#### 1.12 `dashboard/src/lib/agentPrompt.ts` — MODIFY
```ts
/** The prompt a Plan→Develop handoff seeds its fresh Develop session with. Pure. */
export function developKickoffPrompt(taskSlug: string): string;
```
Text: read the task, restate the plan in your own words, then implement it in waves per its acceptance criteria — no re-planning.

#### 1.13 `dashboard/src/components/sleepy/chatSession.ts` — MODIFY
- **`createChatSession` (412-423):** append `mode: ChatMode = 'basic'` as the last parameter.
- **URL builder (435-448):** `const modeParam = mode && mode !== 'basic' ? \`&mode=${encodeURIComponent(mode)}\` : '';` appended to `url`.
- **The returned session object:** expose `readonly mode: ChatMode` beside the existing `bypass`/`model`/`effort`/`claudeId`, so `resumeChatSession` and the roster can read it back.

#### 1.14 `dashboard/src/components/sleepy/AgentSurface.tsx` — MODIFY
- **`SavedMeta` (176-191):** `mode?: ChatMode`.
- **`spawn` (566-588):** append `mode: ChatMode = 'basic'`; pass it to `createChatSession` (578). Also apply the model/effort defaults from `agentSettings.chatDefaultModel/Effort` when the caller supplied none (§1.16).
- **`spawnAndRegister` (593-599):** carry `mode: s.mode` into the roster entry.
- **`resumeChatSession` (755-765):** `spawn(cs.bypass, cs.claudeId, true, 'chat', '', '', true, '', false, '', false, cs.mode)` and preserve `mode` in the roster row.
- **New `changeChatMode(sid, mode)`** beside `changeChatPermissionMode` (777-788): write the roster row's `mode`, then `resumeChatSession(cs)` under it (P6).
- **New `handoffToDevelop(cs, taskSlug)`:**
  1. `const { inline, token } = await preparePrompt(vault, developKickoffPrompt(taskSlug))` (agentPrompt.ts:90).
  2. `const s = spawn(false, undefined, false, 'chat', inline, '', true, token, false, '', false, 'develop')`.
  3. Insert its roster entry **at the plan tab's index in the plan tab's pane**, then `closeSessionById(cs.id)` — spawn-then-close, so the pane never momentarily empties (`closeSessionById` filters zero-tab panes, 636-644).
- **`chatActionsImpl` (1486-1494) + the stable `chatActions` memo (1497-1505):** add `changeMode` and `handoffToDevelop`.
- **`<ChatPaneHost …>` (2426-2451):** pass `mode={sessionMode[cs.id] ?? cs.mode}`.

#### 1.15 `dashboard/src/components/sleepy/ChatPaneHost.tsx` + `ChatPane.tsx` — MODIFY
- `ChatSurfaceActions` (ChatPaneHost.tsx:33-44) gains:
  ```ts
  changeMode: (sid: string, mode: ChatMode) => void;
  handoffToDevelop: (cs: ChatSession, taskSlug: string) => void;
  ```
- `ChatPaneHostInner` props (46-58) gain `mode: ChatMode`; forwarded to `ChatPane`.
- `ChatPane` forwards `mode` / `onModeChange` to `<Composer>` (1649-1668).
- `ChatPane.handleAction` (1237-1259): `case 'develop': actions.handoffToDevelop(session, action.id!); break;`

#### 1.16 `src/server/routes/launcher.ts` + `dashboard/src/lib/agentSettings.ts` — MODIFY
- `AgentUiSettings` (launcher.ts:851-872) gains `chatDefaultModel: string` and `chatDefaultEffort: string`; defaults `''`/`''` (= inherit the CLI's own defaults).
- `coerceAgentSettings` (890-911): `chatDefaultModel` accepted only when `/^[A-Za-z0-9._-]{1,64}$/`, else `''`; `chatDefaultEffort` only when in `EFFORT_LEVELS`, else `''`. Same strict-pick discipline as `chatPermissionMode`.
- `agentSettings.ts` mirrors both fields in its blob + `AGENT_SETTINGS_EVENT` payload.
- **Contract:** `ModelMenu`'s "Set as default" writes these two; `spawn` reads them for a chat with no explicit model/effort.

#### 1.17 Deletions
- `dashboard/src/components/sleepy/chat/PermissionModeMenu.tsx` — **delete** (Composer.tsx was its only consumer; grep confirmed).
- `dashboard/src/components/sleepy/chat/ContextReadout.tsx` — **delete** (same).
- `.chat-permmode-*` rules — **delete** from `ChatPane.css`, `chat/overlays.css`, and `chat/composer.css:709-711`.
- `SkillPickerPopover.tsx` — **keep unchanged**: `AgentComposerBar.tsx:5,138` still uses `SkillBrowser`, and `Popover` still serves the Attach menu.

---

### D2 — Pinned shelf

#### 2.1 `dashboard/src/lib/chatViewSpec.ts` — MODIFY
- **`VIEW_TYPES` (22):** `['chart','page','checklist','pin','progress']`.
- **New types** after `ChecklistItemSpec` (83):
  ```ts
  export type PinWeight = 'tag' | 'row';
  export interface PinFactSpec { label: string; url?: string; marker?: boolean }
  export interface PinViewSpec {
    type: 'pin'; id: string; weight: PinWeight;
    facts: PinFactSpec[]; lede?: string; detail?: string;
    /** true when the SURFACE produced the lede by clamping `detail` — never author-set. */
    ledeClamped?: boolean;
  }
  export interface ProgressViewSpec { type: 'progress'; task: string }
  ```
  `ChatViewSpec` union (25) extended.
- **New caps** in the caps block (90-104):
  ```ts
  export const MAX_PINS_PER_CONVERSATION = 24;
  export const MAX_PIN_FACTS = 6;
  export const MAX_PIN_LEDE_CHARS = 160;
  export const MAX_PIN_DETAIL_CHARS = 4000;
  export const MAX_TAG_LABEL_CHARS = 48;
  export const MAX_TAGS_PER_LINE = 12;
  ```
- **New loopback gate** (beside `sanitizeImageSrc`, 140-170):
  ```ts
  /** The DELIBERATE loopback carve-out to the https-only rule. Accepts http(s) on exactly
   *  `localhost`, `127.0.0.1`, `[::1]` — hostname compared after URL parsing, never by
   *  substring — with an optional port and no credentials. Everything else → null. */
  export function sanitizeLoopbackUrl(raw: string): string | null;
  ```
  Same control-char strip + `//`-reject preamble as `sanitizeImageSrc`. Rejects `http://localhost.evil.com`, `http://127.0.0.1.evil.com`, `http://user@localhost/`, `http://evil.com#@localhost`, `http://0.0.0.0`, `http://127.1`, `javascript:`.
- **`validatePin`:** id per `CHECKLIST_ID_RE`; `weight` defaults `'tag'` for an unknown value + notice; facts capped with a notice; a fact `url` that isn't https **or** loopback is dropped with a notice, the label survives; `lede`/`detail` clamped with notices. **`ledeClamped` is stripped from author input** — only the surface may set it.
- **`validateProgress`:** `task` must be a non-empty `[A-Za-z0-9._-]{1,120}` slug. **If `percent` (or `pct`/`done`/`total`) is present → dropped + notice** `"A progress block supplied its own percent — it was ignored. The number is read from the task file's acceptance criteria."` (M3).
- **`parseViewBlock` switch (641-648):** two new cases.
- **Contract:** `PinViewSpec`, `ProgressViewSpec`, `sanitizeLoopbackUrl`, the six caps.

#### 2.2 `dashboard/src/components/sleepy/chat/chatActions.ts` — MODIFY (2nd pass, wave 4)
- `isHttpsUrl` (85-91) → `isAllowedActionUrl(raw)` = `new URL(raw).protocol === 'https:' || sanitizeLoopbackUrl(raw) !== null`, importing from `chatViewSpec.ts` (the dependency already runs that way: chatActions → chatViewSpec at line 28-30; the reverse is type-only, so no cycle).
- `toAction`'s `case 'url'` (118-119) uses it.

#### 2.3 `dashboard/src/lib/shelfModel.ts` — CREATE (pure; no React, no DOM, no `api/client`)
```ts
export interface ShelfFact { label: string; url?: string; marker?: boolean; icon?: 'branch'|'worktree'|'link' }

export type ShelfEntry =
  | { kind: 'pin'; id: string; weight: PinWeight; facts: ShelfFact[]; lede?: string;
      detail?: string; ledeClamped?: boolean; updatedAt: number }
  | { kind: 'progress'; id: string; task: string; updatedAt: number };

export const SHELF_MAX_ROWS = 2;          // the tag line counts as one → ONE open row
export const SHELF_DETAIL_MAX_VH = 34;    // matches the design's `max-height: 34vh`

/** A pin's own row/tag decision. `weight` is a REQUEST: a `row` with no detail and a
 *  tag-sized lede is demoted, so the ceiling is enforceable whatever the agent sends. */
export function effectiveWeight(e: ShelfEntry): PinWeight;

/** Clamp long prose to a one-line lede and SAY so. */
export function clampLede(text: string): { lede: string; clamped: boolean };

export interface ShelfTag { id: string; label: string; url?: string; marker?: boolean;
  icon?: ShelfFact['icon']; demoted?: boolean; dismissable: boolean }

export interface ShelfLayout {
  row: ShelfEntry | null;      // at most ONE — the hard ceiling
  tags: ShelfTag[];            // the tag line, in order
  demotedIds: string[];        // rows that lost the slot, oldest-first
  notices: string[];
}
/** `facts` are the SERVER-derived session facts (branch/worktree) — always first, never
 *  dismissable (P13). A live `progress` entry always wins the row slot; otherwise the
 *  newest row-weight pin does; every other row-weight pin demotes to a `⌃` tag. */
export function layoutShelf(entries: ShelfEntry[], facts: ShelfFact[]): ShelfLayout;

/** How many chips fit before the `+N` fold. Pure arithmetic over MEASURED numbers, so the
 *  DOM read stays in the component and this stays unit-testable. */
export function foldAt(chipRights: number[], rowWidth: number, foldChipWidth: number): number;

/** Fold `dream-view` payloads into the entry list, id-keyed (re-sending an id UPDATES
 *  in place and never appends a second). Oldest beyond MAX_PINS_PER_CONVERSATION are
 *  evicted and REPORTED — never silently dropped. */
export function foldViews(prev: ShelfEntry[], views: ChatViewSpec[], at: number):
  { entries: ShelfEntry[]; evicted: number };
```
- **Contract:** every one of the above. This module is where M1's ceiling/overflow/demotion, M2's weight semantics, and M2b's clamping live — and it is the only place they live.

#### 2.4 `dashboard/src/lib/pinStore.ts` — CREATE
Modelled line-for-line on `checklistStore.ts`, reusing its exported `labelPart` (checklistStore.ts:43) so there is exactly one hex encoder.
```ts
const PIN_PREFIX = 'dc.chatpins.v1.';
export const PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PIN_WRITE_DEBOUNCE_MS = 300;
/** Vault-scoped AND conversation-scoped: localStorage is shared across every open project
 *  (see checklistStore.ts's header) — an unscoped key would let two projects read each
 *  other's pins. */
export function pinStoreKey(vault: string, conversationId: string): string;
export function readPins(vault: string, conversationId: string): ShelfEntry[];
export function writePins(vault: string, conversationId: string, entries: ShelfEntry[]): void;
export function sweepExpiredPins(now: number): void;
```
Keyed by `session.claudeId` (survives the tab-id swap every resume performs).

#### 2.5 `src/server/chat-surface.ts` — MODIFY
Append to `CHAT_SURFACE_BRIEFING` (after the checklist block, line 89-94), staying short:
```
```dream-view
{"type":"pin","id":"dev","weight":"tag","facts":[{"label":":5173","url":"http://localhost:5173"}]}
```
  A shelf ON the composer that never scrolls away. `weight` is a REQUEST — `tag` for a short
  fact, `row` for a `lede` + `detail`; the shelf may demote either way. Re-send the same `id`
  to update it. Branch and worktree are already shown — pin only what you alone know, e.g. a
  dev-server URL (loopback only). Max 6 facts.

```dream-view
{"type":"progress","task":"my-task-slug"}
```
  Percent is read from that task's ticked acceptance criteria on disk. Do not send a number —
  one you send is ignored and drawn as a notice.
```
**Contract:** the lockstep test (§5) is the mechanical lock; briefing and renderer ship in the same wave.

#### 2.6 `tests/unit/chat-surface-lockstep.test.ts` — MODIFY
Existing four assertions stay green once §2.1 and §2.5 land together. **Add one:**
```ts
it('the progress example never shows a percent — it is derived, not asserted', () => {
  const progress = examples.map(j => JSON.parse(j)).filter(v => v.type === 'progress');
  expect(progress.length).toBeGreaterThan(0);
  for (const p of progress) for (const k of ['percent','pct','done','total']) expect(p[k]).toBeUndefined();
});
```

#### 2.7 `src/lib/markdown.ts` — MODIFY
Beside `countCheckboxes` (330-341):
```ts
/** The first UNTICKED acceptance criterion's text, emphasis stripped — what is in flight.
 *  null when there are none or all are ticked. Same line grammar `countCheckboxes` uses. */
export function firstUnticked(sectionBody: string): string | null;
```

#### 2.8 `src/lib/session-facts.ts` — CREATE
```ts
export interface SessionFacts {
  branch: string | null;
  /** cwd is a LINKED worktree: `--git-common-dir` ≠ `--absolute-git-dir`. */
  worktree: boolean;
  /** The main checkout's root when in a worktree (dirname of the common dir), else null. */
  mainRoot: string | null;
  /** May a Develop-mode agent create one here? (worktree-gate.ts) */
  worktreeAllowed: boolean;
  /** false when this isn't a git repo / git is absent — the shelf then shows no branch chip. */
  isRepo: boolean;
}
/** Never throws. Memoized per projectRoot for SESSION_FACTS_TTL_MS so a polling shelf
 *  doesn't fork git on every tick. */
export function readSessionFacts(projectRoot: string): SessionFacts;
export const SESSION_FACTS_TTL_MS = 5_000;
```
- branch: `git.currentBranch(projectRoot)` (git.ts:123 — `symbolic-ref --short HEAD`, strictly better than the prompt's `rev-parse --abbrev-ref` because it survives an unborn branch). **[Δ]** noted.
- worktree: `execFileSync('git', ['rev-parse','--git-common-dir'])` vs `['rev-parse','--absolute-git-dir']`, both resolved to absolute; `mainRoot = dirname(commonDir)`.
- Every call wrapped; any throw → `{branch:null, worktree:false, mainRoot:null, worktreeAllowed:false, isRepo:false}`.

#### 2.9 `src/server/routes/agent-shelf.ts` — CREATE (two routes)
```ts
export type TaskProgressState = 'ok' | 'unknown-slug' | 'no-criteria' | 'all-done' | 'unreadable';
export interface TaskProgress {
  slug: string;
  state: TaskProgressState;
  /** null for every non-'ok'/'all-done' state — never NaN, never a fabricated 0. */
  percent: number | null;
  done: number; total: number;
  now: string | null;      // first unticked criterion
  last: string | null;     // newest Changelog bullet
  updatedAt: number;       // file mtimeMs — the client's change detector
  notice: string | null;   // always present when state !== 'ok'
}
export async function handleAgentTaskProgress(req, res, params, contextRoot): Promise<void>;
export async function handleAgentSessionFacts(req, res, params, contextRoot): Promise<void>;
```
- **`/api/agent/task-progress?slug=`** — `isSafeTaskSlug` (task-backend/local.ts:33) → `join(contextRoot,'state',`${slug}.md`)` → `readSection(file,'Acceptance Criteria')` + `countCheckboxes` + `firstUnticked`; `last` = first non-empty `- ` bullet of `readSection(file,'Changelog')`; `updatedAt` = `statSync(file).mtimeMs`. `percent = total === 0 ? null : Math.round(done/total*100)`. `state`: missing file → `unknown-slug`; `total === 0` → `no-criteria`; `done === total` → `all-done`; else `ok`. Never throws.
- **`/api/agent/session-facts`** — `isDesktop()` gate (returns `{isRepo:false,…}` off-desktop), `projectRootOf(contextRoot)` (agent-spawn-shared.ts:48), `readSessionFacts`.

#### 2.10 `src/server/index.ts` — MODIFY
Register beside `goal-live` (line 377):
```ts
router.get('/api/agent/task-progress', handleAgentTaskProgress);
router.get('/api/agent/session-facts', handleAgentSessionFacts);
```
Both **vault-scoped** — deliberately NOT added to `VAULT_AGNOSTIC_PREFIXES` (line 550): each reads one project's files.

#### 2.11 `dashboard/src/hooks/useAgentCapabilities.ts` — MODIFY
Beside `useAgentSessionStats` (line 78-89):
```ts
export function useTaskProgress(slug: string | null, enabled: boolean): UseQueryResult<TaskProgress>;
  // refetchInterval 4_000 while enabled — "refreshes as the task file changes" (M3)
export function useSessionFacts(enabled: boolean): UseQueryResult<SessionFacts>;
  // refetchInterval 15_000 — a branch changes rarely
```

#### 2.12 `dashboard/src/components/sleepy/chat/useShelf.ts` — CREATE
```ts
export function useShelf(session: ChatSession, vault: string | null): {
  layout: ShelfLayout;
  openId: string | null;                 // the one expanded pin (M2b: one at a time)
  setOpenId: (id: string | null) => void;
  dismiss: (id: string) => void;
  promote: (id: string) => void;         // a `⌃` demoted chip clicked
  progress: TaskProgress | null;
  facts: ShelfFact[];
};
```
- Seeds `entries` from `readPins(vault, session.claudeId)` on mount and sets a cursor ref to `conv.items.length` — a reload restores pins **without** re-parsing the transcript.
- An effect on `conv.items.length` scans only items added since the cursor, `parseChatActions(item.text)` on each `kind === 'text' && done === true` item (P11), `foldViews` the resulting `pin`/`progress` views, persists via `writePins`.
- `progress` from `useTaskProgress(layout.row?.kind === 'progress' ? layout.row.task : null, connected)`.
- `facts` from `useSessionFacts(connected)` → `[branch chip, worktree marker when facts.worktree]`.
- **Auto-close (M3):** when `progress.state === 'all-done'` **and** `!session.busy`, the progress entry is removed from `entries` — the row closes, the tag line stays, and the demoted pin it displaced promotes back.
- **Dismiss rule (M2):** pure id removal; a later message re-sending that id re-creates it (the agent explicitly re-asserting). Documented in the component header and in the criterion.

#### 2.13 `dashboard/src/components/sleepy/chat/PinShelf.tsx` — CREATE
Renders `null` when `layout.row === null && layout.tags.length === 0` — no zero-height artifact.
Structure, translated from `ShelfUnit.dc.html` with the **popover variant dropped** (owner delta 5):
- `.pin-shelf > .pin-shell{,.has-rows}`.
- The `.pin-open`/`.pin-row` for the single row: progress (`.pin-caret`, `.pin-pct`, `.pin-count`, `.pin-now`, `.pin-x`, `.pin-track > .pin-track-fill`) or a lede pin (`.pin-title`, `.pin-ledetext`, `.pin-clamp` **only when `ledeClamped`**, `.pin-open-hint`).
- `.pin-body` for the in-place detail — progress renders `.pin-task` rows from `progress` (done/now/queued derived from the criteria list), a pin renders its `detail` prose. `max-height: 34vh; overflow-y:auto`.
- `.pin-fold` (the unfolded `+N` row, rendered **above** the tag line).
- `.pin-tags`: server facts first (`.pin-chip` with the branch glyph, `.pin-chip.is-marker` for `worktree`), then agent tags (`.pin-chip.is-link` for a loopback url, `.pin-chip.is-demoted` with `⌃`), then `.pin-chip.is-more` `+N`/`−N`.
- Fold measurement: one `ResizeObserver` on `.pin-tags` + a single pass reading each chip's `offsetLeft + offsetWidth` → `foldAt(...)`. All arithmetic in `shelfModel.ts`.
- **No scroll listeners, no `scrollTop` reads, no `IntersectionObserver`** — the no-scroll-reaction rule is enforced by the absence of an input, and locked by the test in §5.
- Loopback chip click → `openExternalUrl(fact.url)` (desktop.ts:573; its Rust validator already accepts `http`, so no capability change is needed).

#### 2.14 `dashboard/src/components/sleepy/chat/pinShelf.css` — CREATE
`.pin-*` translated from `composer.design.css:891-1177` with the same one token rename (`--font-text` → `--font-family-text`). **Omit** `.pin-pop*` (dropped variant) and `.pin-frame` (a states-doc-only helper). Add `container: pinshelf / inline-size` on `.pin-shelf` and convert the design's `.is-narrow` rules to `@container pinshelf (max-width: 470px)` (P12) — including the `worktree` text→glyph swap.

#### 2.15 `dashboard/src/components/sleepy/chat/ChatViews.tsx` — MODIFY
`ChatViewItem`'s switch (61-68): `case 'pin': case 'progress': return null;` with a comment naming `PinShelf` as their renderer. Notices still render (the degradation contract is untouched).

#### 2.16 `dashboard/src/components/sleepy/ChatPane.tsx` — MODIFY (2nd pass, wave 5)
Between `<QueuedMessages/>` (1633) and the `needsSignIn ? … : <Composer/>` branch (1634-1669) — i.e. **outside `.chat-transcript`** (1413), which is what makes the scroll-invariance structural rather than behavioural:
```tsx
<PinShelf shelf={shelf} onOpenUrl={openExternalUrl} />
```
and `<Composer … shelved={shelf.layout.row !== null} />`. `const shelf = useShelf(session, vault)` declared near the other hooks.

---

### INT — integration wiring (feature-integration-pattern)

#### `skill/SKILL.md` — MODIFY
Capabilities row: the Chat surface renders `pin` + `progress` shelf blocks and offers Plan/Develop modes — **with the surface gate named** ("Chat view only"), because `chat-surface-lockstep.test.ts:98-107` fails a bare mention.

#### `skill/references/integrations.md` (or the chat-surface reference section) — MODIFY
Full protocol: the `dream-view` `pin`/`progress` schemas + caps, weight-is-a-request, the loopback-only URL rule, the `develop` action, and the three chat modes + what each briefing adds.

#### `agents/*.md` — MODIFY (scan, record decisions)
- `goal-implementer.md`, `goal-planner.md`: name the Develop/Plan chat modes as the interactive equivalents of their phases.
- Every other agent: "considered — not applicable", recorded in the task log, not in the docs.

#### `package.json` — MODIFY
`"verify:chat-modes"` and `"verify:chat-shelf"` script entries (single lane, so the two verify-script authors never collide here).

#### `dreamcontext update` — RUN
Regenerate the installed `.claude/` copies from the edited `skill/` sources.

---

## 2. Dependency map

| task | files owned | depends on | wave | contract |
|---|---|---|---|---|
| **D1-A** model data | `dashboard/src/lib/agentComposer.ts`; `src/server/routes/agent-terminal.ts` (`buildModelConfig` only); `tests/unit/agent-composer-model-menu.test.ts` (new) | — | 1 | `ModelOption.priceIn?: number \| null`; `modelNoteFor(id: string): ModelNote \| null`; `splitModels(config: ModelConfig, current: string, primaryCount?: number): { primary: ModelOption[]; other: ModelOption[] }`; `effortIndex(efforts: string[], level: string): number`; `effortAt(efforts: string[], index: number): string`; `usageLimits(ctx: ContextUsage \| null, extra: UsageLimit[]): UsageLimit[]` |
| **D1-D** mode transport (server) | `src/server/chat-modes.ts` (new); `src/lib/worktree-gate.ts` (new); `src/server/routes/agent-spawn-shared.ts`; `src/server/routes/agent-chat.ts`; `tests/unit/chat-modes.test.ts` (new); `scripts/verify/chat-modes.mjs` (new) | — | 1 | `type ChatMode = 'basic'\|'plan'\|'develop'\|'jarvis'`; `sanitizeChatMode(v: string \| null): ChatMode`; `modeBriefing(mode: ChatMode, opts: { worktreeAllowed: boolean }): string`; `worktreeIsolationAllowed(projectRoot: string): boolean`; WS URL param `&mode=` |
| **D1-C** composer chrome | `chat/Composer.tsx`; `chat/composer.css`; `chat/ComposerMenus.tsx` (new); `chat/useAnchoredMenu.ts` (new); `chat/PermissionModeMenu.tsx` (del); `chat/ContextReadout.tsx` (del); `ChatPane.css`, `chat/overlays.css` (dead `.chat-permmode-*` only) | D1-A | 2 | `Composer` props gain `mode: ChatMode`, `onModeChange: (m: ChatMode) => void`, `shelved?: boolean`; `ModeMenu`/`ModelMenu`/`UsageMenu` signatures (§1.4); `useAnchoredMenu(): { open, toggle, close, rootRef }` |
| **D1-E2** develop action | `chat/chatActions.ts`; `dashboard/src/lib/agentPrompt.ts`; `tests/unit/chat-actions.test.ts` (extend) | — | 2 | `ChatActionKind` gains `'develop'` (payload `id`, `/^[A-Za-z0-9._-]+$/`); `developKickoffPrompt(taskSlug: string): string` |
| **D1-E3** defaults persistence | `src/server/routes/launcher.ts`; `dashboard/src/lib/agentSettings.ts`; `tests/unit/agent-ui-settings.test.ts` (extend/new) | — | 2 | `AgentUiSettings` gains `chatDefaultModel: string`, `chatDefaultEffort: string` (both `''` = inherit CLI) |
| **D1-E1** mode wiring (client) | `chatSession.ts`; `AgentSurface.tsx`; `ChatPaneHost.tsx`; `ChatPane.tsx`; `src/server/routes/agent-sessions.ts`; `tests/unit/agent-sessions-roster.test.ts` (extend) | D1-C, D1-D, D1-E2, D1-E3 | 3 | `createChatSession(…, mode?: ChatMode)`; `ChatSession.mode: ChatMode`; `ChatSurfaceActions` gains `changeMode: (sid: string, mode: ChatMode) => void` and `handoffToDevelop: (cs: ChatSession, taskSlug: string) => void`; `SavedMeta.mode?: ChatMode` (round-trips only alongside `kind:'chat'`) |
| **D2-A** spec + model + store + briefing | `dashboard/src/lib/chatViewSpec.ts`; `dashboard/src/lib/shelfModel.ts` (new); `dashboard/src/lib/pinStore.ts` (new); `chat/chatActions.ts` (loopback gate only); `src/server/chat-surface.ts`; `tests/unit/chat-surface-lockstep.test.ts`; `tests/unit/chat-view-pin.test.ts` (new); `tests/unit/shelf-model.test.ts` (new); `tests/unit/pin-store.test.ts` (new) | D1-E2 (owns `chatActions.ts` in w2) | 4 | `PinViewSpec`, `ProgressViewSpec`, `sanitizeLoopbackUrl(raw: string): string \| null`; `ShelfEntry`, `ShelfFact`, `ShelfLayout`; `layoutShelf(entries: ShelfEntry[], facts: ShelfFact[]): ShelfLayout`; `effectiveWeight(e: ShelfEntry): PinWeight`; `clampLede(text: string): { lede: string; clamped: boolean }`; `foldAt(chipRights: number[], rowWidth: number, foldChipWidth: number): number`; `foldViews(prev, views, at): { entries: ShelfEntry[]; evicted: number }`; `readPins/writePins/sweepExpiredPins` |
| **D2-B** shelf server | `src/server/routes/agent-shelf.ts` (new); `src/lib/session-facts.ts` (new); `src/lib/markdown.ts`; `src/server/index.ts`; `tests/unit/task-progress.test.ts` (new); `tests/unit/session-facts.test.ts` (new); `scripts/verify/chat-shelf.mjs` (new) | — | 4 | `GET /api/agent/task-progress?slug=` → `TaskProgress`; `GET /api/agent/session-facts` → `SessionFacts`; `firstUnticked(sectionBody: string): string \| null`; `readSessionFacts(projectRoot: string): SessionFacts` |
| **D2-C** shelf UI | `chat/PinShelf.tsx` (new); `chat/pinShelf.css` (new); `chat/useShelf.ts` (new); `chat/ChatViews.tsx`; `chat/Composer.tsx`; `ChatPane.tsx`; `dashboard/src/hooks/useAgentCapabilities.ts`; `tests/unit/chat-shelf-placement.test.ts` (new) | D2-A, D2-B | 5 | `useShelf(session: ChatSession, vault: string \| null): ShelfHandle` (§2.12); `<PinShelf shelf={ShelfHandle} onOpenUrl={(url: string) => void} />`; `useTaskProgress(slug: string \| null, enabled: boolean)`; `useSessionFacts(enabled: boolean)` |
| **INT** integration wiring | `skill/SKILL.md`; `skill/references/integrations.md`; `agents/goal-implementer.md`, `agents/goal-planner.md`; `package.json` | D2-C | 6 | skill docs name both `dream-view` types + the chat modes **with the surface gate**; `npm run verify:chat-modes`, `npm run verify:chat-shelf` |

Rule check: max 3 per wave ✓ (w2 = 3, all others ≤ 2). No file appears twice in one wave ✓ (`chatActions.ts` w2/w4, `Composer.tsx` w2/w5, `ChatPane.tsx` w3/w5 — all cross-wave). D1 waves 1-3 strictly precede D2 waves 4-5 ✓.

---

## 3. Acceptance criteria

### 3.1 Additions to `chat-density-shrink-chrome-and-demote-the-context-meter-…` (D1)
Existing criteria 1-8 stand unchanged. Append:

- [ ] **9 · The toolbar is the design's five controls, in order** — mode trigger (mode name + permission), attach icon, spacer, usage ring, model+effort trigger, send. `.chat-cmp-pill`, `.chat-cmp-readout` and `.chat-cmp-ctxcard` no longer exist in `composer.css` or in the rendered DOM.
- [ ] **10 · The context meter is a 16px ring** carrying `role="meter"`, `aria-valuenow` and an `aria-valuetext` with the full `X / Y · N%` reading, plus a `title` with the same text. Criterion 6's "demoted, never deleted" holds: the arithmetic is one click away in the usage popover and one hover away in the title.
- [ ] **11 · Escalation survives the redesign** — past `CONTEXT_TIGHT_PCT` (a named constant, criterion 7) the ring goes `data-tight` **and** the `/compact` button appears in the toolbar without hover or focus.
- [ ] **12 · Four menus, one at a time** — usage, model+effort, mode+permission open upward, anchored to `.chat-cmp`; opening one closes the others; Esc closes only the top overlay (`overlayStack` LIFO) and an outside pointerdown closes.
- [ ] **13 · The mode menu has NO "Set as default"**; the model+effort menu HAS one, and it persists `chatDefaultModel`/`chatDefaultEffort` to `~/.dreamcontext/agent-ui.json`, which a subsequent chat spawn reads.
- [ ] **14 · Skills are gone from the composer** — no Skills popover, no `skillChip` state, no `.chat-cmp-skillchip`. The idle placeholder names the slash path, and the existing `/` menu still opens at any token boundary.
- [ ] **15 · Effort is a slider** — `min=0 max={efforts.length-1}`, ticked with every level, the active tick marked; `effortIndex`/`effortAt` clamp rather than return `-1` for an unknown level.
- [ ] **16 · No behaviour regressed** — auto-grow (`--chat-cmp-h`), the drag handle floor, the slash menu, attachments (paste + file/folder/task pick), the queue/stop/send trio, ↑/↓ history and the one-row toolbar at 740px, 470px and 380px all behave exactly as before. A unit test asserts `composerBodyHeight`'s bounds are unchanged.
- [ ] **17 · Modes are real behaviour** — `basic` adds nothing beyond `CHAT_SURFACE_BRIEFING`; `plan` and `develop` each append a mode briefing at spawn through the SAME `--append-system-prompt-file` (one temp file, one cleanup); `jarvis` renders disabled with a "Soon" badge and can never be selected or transmitted (`sanitizeChatMode('jarvis') === 'basic'`).
- [ ] **18 · Develop's worktree permission is gated, not assumed** — the worktree sentence appears only when `worktreeIsolationAllowed(projectRoot)` (brain `full-repo` **or** a present linked repo); otherwise the briefing explicitly forbids a worktree. A unit test drives all four combinations.
- [ ] **19 · Mode travels and persists** — client → `&mode=` → `sanitizeChatMode` → briefing; the selected mode is stored per session on the roster (`SavedMeta.mode`, only alongside `kind:'chat'`, whitelisted to `CHAT_MODES`) and survives an app relaunch. There is no user-settable mode default: a fresh chat is `basic`.
- [ ] **20 · Changing mode mid-session is honest** — it respawns the conversation with `--resume` under the new briefing (the transcript is kept) and the menu says so in one line.
- [ ] **21 · Plan → Develop opens a NEW session** — a `dream-actions` `{"action":"develop","id":"<slug>"}` button mints a prompt token (`POST /api/agent/prompt`), spawns a fresh chat with `mode=develop` carrying the slug, places it at the plan tab's index, and closes the plan tab. Spawn precedes close, so the pane never empties. No in-place `/clear` variant exists.
- [ ] **22 · Usage limits show what's found and hide what isn't** — the usage popover renders one bar per entry of `UsageLimit[]`; with no 5h/weekly source it renders context + cost only, and nothing else. No empty ring, no zeroed bar, no "unknown" placeholder.

### 3.2 Refinements to `two-new-agent-actions-pinned-session-facts-…` (D2)
No existing criterion is weakened. One instrument changes and is called out; the rest are additions.

**Instrument change (M1, bullet 2).** "A test asserts the shelf's geometry is byte-identical at scroll-top, mid-scroll and scroll-bottom" — Playwright is unavailable in this environment (agreed Phase-6 constraint), so the geometric assertion is replaced by **two** checks that together cover the same property, not fewer:
- [ ] **M1.2a (structural)** — `tests/unit/chat-shelf-placement.test.ts` asserts, by reading the sources: `PinShelf` is mounted in `ChatPane.tsx` **after** the closing of `.chat-transcript` (never inside `.chat-scroll`), and `PinShelf.tsx` + `useShelf.ts` contain no `scroll`/`scrollTop`/`onScroll`/`IntersectionObserver` token. A shelf with no scroll input cannot react to one.
- [ ] **M1.2b (observed)** — the owner's manual checklist item: scroll a long conversation to top, middle and bottom; the shelf and the composer do not move, resize, hide or reveal.

**Additions:**
- [ ] **M1.7 · The empty shelf renders nothing** — no tags and no row ⇒ `PinShelf` returns `null`. It never contributes a zero-height strip or a stray border.
- [ ] **M1.8 · The dock seam is one object** — with an open row, `.pin-shell.has-rows` carries the 12px top corners and no bottom border while `.chat-cmp-card.is-shelved` squares its top corners. At rest (tag line only) the composer keeps its full radius.
- [ ] **M2.8 · Session facts are server-derived and not dismissable** — branch and the worktree marker come from `GET /api/agent/session-facts` (`git symbolic-ref --short HEAD`; worktree via `--git-common-dir` ≠ `--absolute-git-dir`, `mainRoot = dirname(commonDir)`) and carry no `×`. The dev-server port is an AGENT-pinned fact with a loopback `url`, because no local source can attribute a listening port to a session. Both appear on the same tag line.
- [ ] **M2.9 · The loopback carve-out is loopback-only, by parse not by substring** — `sanitizeLoopbackUrl` compares `URL.hostname` against exactly `localhost` / `127.0.0.1` / `[::1]`, rejects credentials, and rejects `http://localhost.evil.com`, `http://127.0.0.1.evil.com`, `http://evil.com#@localhost`, `http://0.0.0.0`, `http://127.1` and `//localhost`. Plain http to any other host stays blocked in both `chatActions.ts` and the pin validator.
- [ ] **M2.10 · Dismissal is a removal, not a tombstone** — dismissing a pin removes it from state and from `pinStore`; a later message re-sending the same `id` re-creates it (the agent re-asserting), and no other pin is reordered, disturbed or resurrected.
- [ ] **M2.11 · The store is vault- AND conversation-scoped** — `pinStoreKey(vault, conversationId)` is hex-encoded per part (reusing `checklistStore`'s `labelPart`), so two projects that pick the same pin `id` can never read each other's pins. TTL sweep at 7 days, debounced writes at 300ms.
- [ ] **M2.12 · Eviction is loud** — past `MAX_PINS_PER_CONVERSATION` the oldest entries are evicted and the count is reported on the tag line; nothing disappears silently.
- [ ] **M3.8 · The progress row reads the LOCAL task file, not the task backend** — `_dream_context/state/<slug>.md` via `readSection('Acceptance Criteria')` + `countCheckboxes`, so the number matches `tasks doctor` even when the project syncs to ClickUp or GitHub.
- [ ] **M3.9 · Progress wins the row slot; the pin it displaces demotes, it does not close** — the displaced pin becomes a `⌃` tag and promotes back when the run ends.
- [ ] **M3.10 · The run's end is observable** — when the route reports `all-done` **and** the session is idle, the progress entry is removed: the row closes, the tag line does not move. While the run is still live, `all-done` renders 100% **with** the loud notice (both M3 bullets hold at once).
- [ ] **X.4 · The shelf never renders inline** — `ChatViews`' switch returns `null` for `pin` and `progress`; their notices still render in the transcript under the existing degradation contract.
- [ ] **X.5 · The briefing never demonstrates a percent** — the lockstep test asserts no `percent`/`pct`/`done`/`total` key appears in any `progress` example, so "derived, never asserted" is mechanically pinned, not just documented.
- [ ] **X.6 · Integration wiring lands awake** — `skill/SKILL.md` (capability row **with the surface gate**), the reference section (schemas, caps, weight semantics, loopback rule, the `develop` action, the three modes), the goal-skill agent contracts, and `dreamcontext update` — all in the same cycle, per `feature-integration-pattern.md`.

---

## 4. Assumptions & open questions

| # | Statement | Where I looked | Status |
|---|---|---|---|
| A1 | **There is no locally readable source for the 5-hour session or weekly rate limits.** | I could not verify directly: `~/.claude` is outside this session's allowed working directory, so `ls`/`grep` there were blocked by the sandbox. I *did* verify the repo side — `computeSessionStats` (agent-terminal.ts:1107-1143) reads only `message.usage`; `buildModelConfig` (974-983) reads only `settings.model`/`effortLevel`; no route, hook or type in `dashboard/src` or `src/server` mentions a rate-limit window. | **Assumption.** Ship context + cost only. Extension point: implement a `useUsageLimits()` hook returning `UsageLimit[]` and pass it as `UsageMenu`'s `limits` — the renderer already maps over the array, so a found source is a one-file change with no UI work. **Please confirm** whether Claude Code writes a limits blob anywhere under `~/.claude` on your machine; if it does, name the file and this becomes a small D1 follow-up. |
| A2 | The Plan agent ends by writing a `develop` action button, and "go to development" in prose is the user's cue to click it. | Design + owner deltas describe the handoff but not its trigger. `ask` (chatActions.ts:116-117) only loads the composer, so it cannot do it. | **Decision, P7.** If you'd rather the agent trigger it without a button, the alternative is a `dream-view` `{"type":"handoff"}` — more machinery for the same result. |
| A3 | The dev-server port cannot be derived server-side per session. | `agent-shelf` has no session→process mapping; `agent-terminal.ts` tracks children but not their listening sockets; scanning `lsof` would be privileged and ambiguous across projects. | **Decision, P8.** Agent-pinned. |
| A4 | Mode changes on a live session must respawn. | `--append-system-prompt-file` is applied at spawn (agent-chat.ts:443); the CLI's control protocol has `set_permission_mode` (chatSession.ts:469) but no system-prompt equivalent. | **Verified constraint.** |
| A5 | `.chat-permmode-*` rules live in `ChatPane.css` and `chat/overlays.css` as well as `composer.css`. | grep hit all three. | **Verified.** The deleting task must sweep all three. |
| A6 | Vitest runs in the plain Node environment — no jsdom. | `vitest.config.ts` (no `environment`), `tests/unit/checklist-store.test.ts:40` shims `globalThis.localStorage`. | **Verified.** Consequence: every shelf rule must live in the pure `shelfModel.ts`; the components stay untested by vitest and are covered by the verify scripts + manual checklist. |
| A7 | `ws` is available to a plain Node verify script. | `package.json:78` `"ws": "^8.21.0"` (a root dependency, not a dev one). | **Verified.** `scripts/verify/chat-modes.mjs` can drive the chat WS with no browser. |
| A8 | The old checkout backend is genuinely absent. | `git log --all -- src/lib/git-checkout.ts src/server/routes/agent-checkout.ts` → empty; `ls src/lib/git-checkout.ts` → no such file. | **Verified.** `session-facts.ts` is fresh, minimal, and does not attempt to restore it. |
| A9 | The `worktree` marker's narrow glyph swap is CSS-only. | Design does it with a JS `narrow` prop; the repo's idiom is container queries (composer.css:668-715). | **Decision, P12.** Both spans render; the container query shows one. |
| A10 | The row-slot arbitration between a long pin and progress. | Board's CEILING + EXPANSION rules say two rows hard with the tag line counting as one; nothing states which wins. | **Decision, M3.9.** Progress wins while live; the displaced pin demotes to `⌃`. Flag if you want the reverse. |

---

## 5. Validation plan

Method fixed in Phase 6: **vitest unit tests + `scripts/verify/` HTTP/WS scripts against the real server + a manual visual checklist.** No Playwright.

### 5.1 Unit tests (vitest, `npm test`)

| File | Asserts | Criteria |
|---|---|---|
| `tests/unit/agent-composer-model-menu.test.ts` *(new)* | `splitModels` keeps the current model primary even when it's an "other"; `modelNoteFor` family-matches a full CLI id and returns `null` for an unknown one; `effortIndex`/`effortAt` clamp at both ends and never return `-1`; `usageLimits([], …)` omits absent limits entirely | D1 · 15, 22 |
| `tests/unit/chat-modes.test.ts` *(new)* | `sanitizeChatMode` maps `null`/`''`/`'JARVIS'`/`'plan; rm -rf'`/`'jarvis'` → `'basic'` and passes `plan`/`develop`; `modeBriefing('basic')===''`; the develop briefing contains a worktree permission **only** when `worktreeAllowed`, and an explicit prohibition otherwise; the plan briefing names the `develop` action | D1 · 17, 18 |
| `tests/unit/agent-ui-settings.test.ts` *(extend)* | `coerceAgentSettings` rejects a shell-metacharacter `chatDefaultModel` and an off-list `chatDefaultEffort`, both → `''` | D1 · 13 |
| `tests/unit/agent-sessions-roster.test.ts` *(extend)* | `coerceMeta` round-trips `mode` only for a known `CHAT_MODES` value **and** `kind:'chat'`; drops it otherwise | D1 · 19 |
| `tests/unit/chat-actions.test.ts` *(extend)* | `develop` accepted with a safe slug, dropped for `../x`, `a/b`, empty; `url` accepts `https://` **and** `http://localhost:5173`, `http://127.0.0.1:3000`, `http://[::1]:8080`, and rejects `http://localhost.evil.com`, `http://127.0.0.1.evil.com`, `http://user@localhost/`, `http://evil.com#@localhost`, `http://0.0.0.0`, `http://127.1`, `//localhost`, `javascript:` | D1 · 21 · D2 M2.9 |
| `tests/unit/chat-composer-height.test.ts` *(unchanged, must stay green)* | `composerBodyHeight` bounds are byte-identical after the redesign | D1 · 16 |
| `tests/unit/chat-view-pin.test.ts` *(new)* | `validatePin`: id grammar, `weight` default + notice on an unknown value, facts capped with a notice, a non-loopback http `url` dropped while the label survives, `ledeClamped` stripped from author input, lede/detail clamped with notices. `validateProgress`: slug grammar; an agent-supplied `percent`/`pct`/`done`/`total` dropped **with** the notice | D2 M2, M3 · X.1 |
| `tests/unit/shelf-model.test.ts` *(new)* | `layoutShelf` never returns more than one row for any input (20 row-weight pins → 1 row + 19 demoted tags); `effectiveWeight` demotes a `row` with no detail and a tag-sized lede; `clampLede` marks a clamp; `foldAt` folds at the right index and the folded count is non-zero; `foldViews` updates in place by id and reports `evicted` past the cap; server facts sort first and are `dismissable:false` | D2 M1 (ceiling, overflow, resting state), M2 (weight, in-place update), M2b (clamp) |
| `tests/unit/pin-store.test.ts` *(new)* | Vault A and vault B with the same pin id do not collide; a tampered envelope reads as absent; TTL sweep drops both halves; the write is debounced | D2 M2 (survive reload) · M2.11 |
| `tests/unit/task-progress.test.ts` *(new)* | `firstUnticked` returns the first `- [ ]` with emphasis stripped and `null` when all are ticked; the route handler's states — 11 criteria / 7 ticked → `percent:64, state:'ok'`; zero criteria → `percent:null, state:'no-criteria'` + notice; all ticked → `state:'all-done', now:null` + notice; unknown slug → `state:'unknown-slug'` + notice; `../etc/passwd` → 400 | D2 M3 (percent source, in-flight criterion, loud degradation) |
| `tests/unit/session-facts.test.ts` *(new)* | In a temp repo: branch reported; `worktree:false`; after `git worktree add`, from the worktree: `worktree:true` and `mainRoot` = the original root; a non-repo dir → all-null, `isRepo:false`, no throw; the memo does not re-fork within the TTL | D2 M2.8 |
| `tests/unit/chat-surface-lockstep.test.ts` *(extend)* | The four existing assertions (now covering 5 `VIEW_TYPES`) plus the no-percent lock | D2 X.2, X.5 |
| `tests/unit/chat-shelf-placement.test.ts` *(new)* | `PinShelf` appears in `ChatPane.tsx` after `.chat-transcript` closes; `PinShelf.tsx`/`useShelf.ts` contain no `scroll`/`scrollTop`/`onScroll`/`IntersectionObserver` token | D2 M1.2a |

### 5.2 Verify scripts (real server, no browser)

**`scripts/verify/chat-modes.mjs`** *(new — HTTP + `ws`, pattern: `past-chats.mjs` setup + a scripted `claude` stand-in that echoes its `--append-system-prompt-file` contents back as an assistant message)*
1. `mode=basic` → the echoed briefing is exactly `CHAT_SURFACE_BRIEFING`. → D1 · 17
2. `mode=plan` → the echo contains the planning half **and** the `develop` action. → D1 · 17, 21
3. `mode=develop` in a project with `brainRepo.mode:'in-tree'` and no linked repo → the echo **forbids** worktrees. → D1 · 18
4. Same with `brainRepo.mode:'full-repo'` → the echo **permits** them. → D1 · 18
5. `mode=jarvis` and `mode=%3Brm` → the echo is the basic briefing (coerced). → D1 · 17
6. `POST /api/agent/prompt` → token → WS upgrade with `sessionId=<fresh>&mode=develop&promptToken=<t>` → the stand-in receives the kickoff prompt naming the slug as its first user frame. → D1 · 21

**`scripts/verify/chat-shelf.mjs`** *(new — HTTP only, `past-chats.mjs` pattern: scratch vault, fake HOME, `DREAMCONTEXT_DESKTOP=1`, real `dist/index.js dashboard`)*
1. Fixture task, 11 criteria / 7 ticked → `GET /api/agent/task-progress?slug=…` → `{percent:64, done:7, total:11, state:'ok'}`, `now` = the 8th criterion, `last` = the newest changelog bullet. → M3 (percent, in-flight, just-done)
2. Tick an 8th on disk, re-GET → `73`, and `updatedAt` advanced. → M3 (refreshes as the file changes)
3. Zero-criteria task → `{percent:null, state:'no-criteria', notice: ≠ null}`. → M3 (loud degradation)
4. All-ticked task → `{percent:100, state:'all-done', now:null, notice: ≠ null}`. → M3
5. Unknown slug → `state:'unknown-slug'` + notice; `slug=../../etc/passwd` → 400. → M3 + path safety
6. `GET /api/agent/session-facts` in the scratch repo → branch matches `git symbolic-ref`, `worktree:false`, `mainRoot:null`.
7. `git worktree add` a second checkout, restart the server rooted there → `worktree:true`, `mainRoot` = the original root. → M2.8
8. Server without `DREAMCONTEXT_DESKTOP` → both routes return the empty shape, never a 500. → cross-cutting

*(Both scripts follow the collect-don't-fail-fast reporting of `dream-actions.mjs`: every check prints ✓/✗ with evidence, exit 0 iff all pass.)*

### 5.3 Manual visual checklist (owner)
Each item at **740px and 470px**, in **dark and light**.

**D1 — composer**
1. Toolbar reads: mode+permission · ＋ · ⟶ · ring · model+effort · send. Nothing wraps to a second line at either width.
2. Each of the three menus opens upward, is not clipped by the card, and closes the other two. Esc closes only the menu.
3. Mode menu: 2×2 grid, J.A.R.V.I.S disabled with "Soon", Auto/Bypass segment, permission note, **no** "Set as default".
4. Model menu: primary rows with price + insight, "Other models" discloses, effort slider moves through all five ticks, "Set as default" flips to "Saved as default".
5. Usage popover: context bar + used/free + cost + note. **No empty ring or zeroed bar for the 5h/weekly limits.**
6. At 470px: the mode trigger keeps its name and drops the permission word; at 380px the model trigger drops the effort word; **Send never shrinks.**
7. Typing grows the box; the drag handle still resizes; `/` opens the slash menu; ⌘V of a screenshot still attaches; ⏎ while busy still steers and ⇡ still queues.
8. Select Plan → the conversation reloads with its transcript intact; the mode trigger reads "Plan".
9. Plan agent ends with a task doc + a "Go to development" button → clicking it opens a NEW Develop tab seeded with the slug and closes the plan tab.

**D2 — shelf (the four states from the design doc)**
10. **rest** — one tag line: branch chip (+ `worktree` when applicable). Composer keeps its full radius; no border above the tag line.
11. **active** — a progress row opens above; **the tag line's and the composer's y do not move.** Percent, `7/11`, the in-flight criterion, and the accent track fill are visible.
12. **lede** — a long pin rests as one row with `…` (clamped) or without (authored) plus `⌄`; clicking grows it **upward**, capped near 40% of the pane and scrolling inside itself; the tag line and composer still do not move. Opening a second pin closes the first.
13. **demote / overflow** — a third row's arrival demotes the oldest to a `⌃` chip (clicking promotes it back); tags past the line's width fold into `+N`, and the fold opens **above**. Nothing disappears; the count is always visible.
14. **scroll invariance (M1.2b)** — scroll a long conversation to top, middle, bottom: the shelf does not move, resize, hide or reveal.
15. **dock seam** — with an open row, shelf and composer read as one object (shelf 12px top corners, composer squared top corners); at rest the composer is fully rounded again.
16. A `http://localhost:PORT` chip opens in the OS browser; a plain-http chip to any other host never renders as a link.
17. Reload the app → the pins are still there; dismiss one → the others do not move.
18. **The goal-skill live panel above the composer still renders and still works** (`GET /api/agent/goal-live`) alongside the shelf.
