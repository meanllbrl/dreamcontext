## Building with the dreamcontext design system

These are real, compiled components from the dreamcontext dashboard (a productivity/agent-memory UI on a "Canvas White / Deep Violet" ClickUp-style palette). They are exported on `window.DreamContextDS.*` (e.g. `DreamContextDS.TaskCard`, `DreamContextDS.StatusBadge`). Compose them; don't reimplement them.

### Setup — no provider needed, just the stylesheet
- These components are presentational. There is **no theme/context provider to wrap** — the entire system (tokens, fonts, and every component's styles) ships in `styles.css`. Load it once at your app root and the components are styled.
- Fonts (Inter, Plus Jakarta Sans, JetBrains Mono) load via a remote `@import` inside `styles.css` — nothing else to wire.
- **Theme:** the default is the light theme. A dark theme is available by setting `data-theme="dark"` on an ancestor (e.g. `<html data-theme="dark">`); all colors are token-driven, so the whole tree switches automatically. Don't hardcode colors — that breaks theming.

### Styling idiom — design tokens (CSS custom properties)
This is a **CSS-variable token system**, not a utility-class framework (no `bg-surface` classes) and not a prop-based style system. Each component already carries its own semantic classNames (`task-card`, `council-status`, `filter-chip`, …) styled by `styles.css` — you don't restyle them. For any layout/spacing/color **glue you add around** the components, use the tokens via `var(--…)`. Never hardcode px/hex values.

Token vocabulary (all defined in `styles.css`'s `:root`):
- **Spacing** (4px grid): `--space-1` (4px), `--space-2` (8), `--space-3` (12), `--space-4` (16), `--space-6` (24), `--space-8` (32) … up to `--space-28`.
- **Surfaces:** `--color-bg`, `--color-bg-elevated`, `--color-bg-secondary`, `--color-bg-tertiary`.
- **Text:** `--color-text`, `--color-text-secondary`, `--color-text-tertiary`.
- **Accent / brand:** `--color-accent` (Deep Violet), `--color-accent-soft`, `--color-accent-text`.
- **Borders:** `--color-border`, `--color-border-hover`, `--color-border-focus`.
- **Semantic:** `--color-error`, `--color-success`; priority `--color-priority-{critical,high,medium,low}`; status `--color-status-{todo,in-progress,in-review,completed}`.
- **Radius:** `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-2xl`, `--radius-full`.
- **Type:** families `--font-family-display` (Plus Jakarta Sans, headings), `--font-family-text` (Inter, body/UI), `--font-mono` (JetBrains Mono); sizes `--font-size-xs … --font-size-display`; weights `--font-weight-{light,normal,medium,semibold,bold}`.
- **Elevation:** `--shadow-sm … --shadow-xl`, `--shadow-glow`.

### Where the truth lives (read before composing)
- **Tokens + classes:** read `styles.css` and its `@import` target `_ds_bundle.css` — the `:root { --… }` block is the complete token list, and the component CSS shows the real class vocabulary.
- **Per component:** read `components/<group>/<Name>/<Name>.d.ts` (the `<Name>Props` API contract) and `<Name>.prompt.md` (usage). Components are grouped `council/*` (debate UI: StatusBadge, ModelBadge, StatTile, PersonaAvatar) and `tasks/*` (TaskCard, KanbanColumn, EisenhowerMatrix, RiceScatter, ActivityHeatmap, MiniCalendar, the filter controls, …).

### Idiomatic example — real components + token-based glue
```tsx
// A compact council-run header: DS components for the parts, tokens for the layout.
<div style={{
  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
  padding: 'var(--space-4)',
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  fontFamily: 'var(--font-family-text)',
}}>
  <DreamContextDS.StatusBadge status="round_1_running" />
  <DreamContextDS.StatTile value={7} label="Rounds" />
  <DreamContextDS.StatTile value="92%" label="Consensus" tone="brand" />
</div>
```
