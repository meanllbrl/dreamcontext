import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * TEXT ON AN ACCENT FILL takes the strong accent — app-wide, and this file is what keeps it so.
 *
 * White on `--color-accent` measures 4.15:1 in light (#7b68ee) and 2.75:1 in dark (#9d8cff):
 * every filled violet button with a label failed WCAG AA, in dark badly. The owner's decision
 * (2026-09-25, round 2) is one token for every filled accent control that carries text —
 * `--color-accent-strong`, #6647f0, 5.64:1 with `--color-accent-text` in both themes — and its
 * gradient twin `--gradient-brand-strong` for the brand CTAs.
 *
 * WHY A SOURCE SCAN. There are dozens of such controls across the dashboard and no single
 * component they share; a runtime check can sample a handful, and the next button someone
 * writes with `background: var(--color-accent)` would pass every one of them. So this reads
 * every stylesheet (and every inline style object) as text and refuses an accent fill that is
 * not either converted or named below as a NON-TEXT fill, with the reason it may stay.
 *
 * An "accent fill" is a `background`/`background-color` of `var(--color-accent)` or
 * `var(--gradient-brand)`, or any gradient built from the accent (`var(--color-accent)`,
 * `#8b7bff`, `#6f5ce0`) — including a custom property that holds one. A rule that paints its
 * TEXT with the gradient (`background-clip: text`) is not a fill and is skipped.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = join(ROOT, 'dashboard/src');

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

/** Fills that carry no text — a dot, a bar, a track, a rule, a check mark — keep the plain
 *  accent. Keyed `file::selector` (file relative to dashboard/src). Each needs a reason. */
const NON_TEXT_FILLS: Record<string, string> = {
  'components/agents/AgentMemberCard.css::.agent-switch--on': 'switch track',
  'components/agents/AgentsFeed.css::.agent-msg--unread::before': 'unread bar',
  'components/automations/AutomationCard.css::.auto-card-status-dot--awaiting-review': 'status dot',
  'components/brain/TeamUpdatesBadge.css::.team-updates-badge .update-badge-dot': 'dot',
  'components/core/JsonPreview.css::.json-date-dot': 'dot',
  'components/council/_ds-council-primitives.css::.council-status--synth .council-status-dot': 'dot',
  'pages/CouncilPage.css::.council-hall-status--synth .council-hall-status-dot': 'dot',
  'pages/CouncilPage.css::.council-status--synth .council-status-dot': 'dot',
  'components/lab/funnel/FunnelBars.css::.funnel-bars-fill': 'bar',
  'components/lab/funnel/FunnelCompareView.css::.funnel-cmp-barfill': 'bar',
  'components/lab/funnel/FunnelLane.css::.funnel-node-volume-fill': 'bar',
  'components/lab/reports/ReportPage.css::.report-mark': 'decorative mark',
  'components/lab/reports/ReportPage.css::.report-rule': 'rule',
  'components/search/BrainSearch.css::.bsearch-score-track > i': 'score bar',
  'components/layout/Sidebar.css::.sidebar-sleepy-eye': 'mascot eye',
  'components/sleepy/SleepyMascot.css::.smascot-hand': 'mascot art',
  'components/sleepy/MobileChat.css::.mchat-dot[data-kind="ready"]': 'state dot',
  'components/sleepy/AgentTerminal.css::.agent-overlay-head': 'tinted surface (6% accent), body text on it',
  'components/sleepy/AgentTerminal.css::.agent-rail': 'tinted surface (4% accent), body text on it',
  'components/sleepy/AgentTerminal.css::.agent-pane-head': 'tinted surface (6% accent), body text on it',
  'components/settings/ClaudeAccounts.css::.dc-acct-bar-fill': 'bar',
  'pages/SettingsPage.css::.embed-model-bar-fill': 'bar',
  'components/sleepy/chat/pinShelf.css::.pin-track-fill': 'bar',
  'components/sleepy/chat/atoms.css::.chat-a-progress[data-status=\'running\'] .chat-a-progress-fill': 'progress bar',
  'components/sleepy/chat/composer.css::.chat-cmp-usagebar-fill': 'usage bar',
  'components/sleepy/AgentTerminal.css::.agent-composer-gauge-fill': 'gauge bar',
  'components/layout/Sidebar.css::.sidebar-item--nudge::after': 'nudge dot',
  'components/layout/Sidebar.css::.sidebar-item--active::before': 'active indicator',
  'components/sleepy/AgentTerminal.css::.agent-panes.split > .agent-pane.active::before': 'active pane indicator',
  'components/sleepy/chat/dreamaction.css::.chat-dreamcard::before': 'edge indicator',
  'components/roadmap/DependencyPicker.css::.dep-check--on': 'check mark (non-text, 3:1 rule)',
  'components/roadmap/InsightPicker.css::.inp-check--on': 'check mark (non-text, 3:1 rule)',
  'components/sleepy/chat/cards.css::.chat-surveycard-dot.done .chat-surveycard-dot-i': 'progress dot',
  'components/sleepy/chat/cards.css::.chat-surveycard-opt.on .chat-surveycard-opt-mark': 'check mark',
  'components/settings/SettingRow.css::.setting-switch:checked': 'switch track',
  'components/sleepy/AgentTerminal.css::.agent-tab-menu-switch[data-on]': 'switch track',
  'components/sleepy/chat/composer.css::.chat-cmp-handoffswitch-track[data-on]': 'switch track',
  'pages/BrainPage.css::.brain-toggle--on': 'switch track',
  'components/sleepy/chat/ChatViews.css::.chat-view-pending-dots span': 'pending dots',
  'components/sleepy/chat/HtmlView.css::.chat-htmlpending-dots span': 'pending dots',
  'components/sleepy/chat/overlays.css::.chat-working-dots span': 'working dots',
  'components/sleepy/chat/cards.css::.chat-msg-caret': 'typing caret',
  'components/sleepy/chat/atoms.css::.chat-a-glyph-brand': 'brand glyph square',
  'components/tasks/ActivityHeatmap.css::.heatmap-cell--l4': 'heatmap cell',
  'components/tasks/MiniCalendar.css::.mini-cal-day--today::after': 'today dot',
  'components/tasks/TimelineGantt.css::.gantt-today-rule': 'today rule',
};

/** Inline style objects that are non-text fills, matched by file and a distinctive snippet. */
const NON_TEXT_INLINE: { file: string; contains: string; why: string }[] = [
  { file: 'components/tasks/SyncChip.tsx', contains: 'syncJob.current', why: 'progress bar' },
  { file: 'components/tasks/BoardToolbar.tsx', contains: "fontSize: 8 }}>✓", why: 'check mark' },
];

const STRONG = /var\(--color-accent-strong\)|var\(--gradient-brand-strong\)/;
const ACCENT_TEXT = /(^|[;\s])color:\s*var\(--color-accent-text\)/;

function isAccentFillValue(value: string, customProperty = false): boolean {
  const v = value.trim();
  // A custom property that is only an ALIAS of the accent (`--kind-color: var(--color-accent)`)
  // paints nothing by itself; one that holds a whole gradient is a fill in waiting.
  if (!customProperty && /^var\(--color-accent\)(\s*!important)?$/.test(v)) return true;
  if (/var\(--gradient-brand\)/.test(v)) return true;
  if (/gradient\(/.test(v) && /(var\(--color-accent\)|#8b7bff|#6f5ce0)/i.test(v)) return true;
  return false;
}

interface Rule { file: string; selector: string; body: string }

function cssRules(): Rule[] {
  const rules: Rule[] = [];
  for (const abs of walk(SRC, ['.css'])) {
    const file = relative(SRC, abs);
    const src = readFileSync(abs, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const chunk of src.split('}')) {
      const i = chunk.lastIndexOf('{');
      if (i < 0) continue;
      const head = chunk.slice(0, i);
      const selector = head.slice(head.lastIndexOf('{') + 1).replace(/\s+/g, ' ').trim();
      rules.push({ file, selector, body: chunk.slice(i + 1) });
    }
  }
  return rules;
}

function declarations(body: string): [string, string][] {
  return body.split(';').map((d) => {
    const c = d.indexOf(':');
    return c < 0 ? null : [d.slice(0, c).trim(), d.slice(c + 1).trim()] as [string, string];
  }).filter((d): d is [string, string] => d !== null);
}

describe('text on an accent fill uses --color-accent-strong, app-wide', () => {
  const rules = cssRules();

  it('defines the two strong tokens once, in :root, at a contrast that passes', () => {
    const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf-8');
    const strong = /--color-accent-strong:\s*(#[0-9a-f]{6})\s*;/i.exec(tokens)?.[1];
    expect(strong, '--color-accent-strong must be a literal hex').toBeTruthy();
    expect(tokens).toMatch(/--gradient-brand-strong:\s*linear-gradient\([^;]*var\(--color-accent-strong\)/);
    // Defined once: the dark block must NOT override it (a fill carries its own contrast).
    expect(tokens.match(/--color-accent-strong:/g)).toHaveLength(1);

    const lum = (hex: string) => {
      const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (1 + 0.05) / (lum(strong!) + 0.05); // against white (--color-accent-text)
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('every accent fill in a stylesheet is converted or named as a non-text fill', () => {
    const offenders: string[] = [];
    for (const r of rules) {
      const decls = declarations(r.body);
      if (decls.some(([p, v]) => /^(-webkit-)?background-clip$/.test(p) && v.startsWith('text'))) continue;
      const fill = decls.some(([p, v]) =>
        ((p === 'background' || p === 'background-color') && isAccentFillValue(v))
        || (p.startsWith('--') && isAccentFillValue(v, true)));
      if (!fill) continue;
      const key = `${r.file}::${r.selector}`;
      if (NON_TEXT_FILLS[key]) continue;
      offenders.push(key);
    }
    expect(offenders, `accent fills that are neither strong nor listed as non-text:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('every non-text allowlist entry still exists (no stale exemptions)', () => {
    const keys = new Set(rules.map((r) => `${r.file}::${r.selector}`));
    const stale = Object.keys(NON_TEXT_FILLS).filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });

  it('every strong fill paints its text with --color-accent-text (or is a state of one that does)', () => {
    const missing: string[] = [];
    for (const r of rules) {
      const bg = declarations(r.body).find(([p]) => p === 'background' || p === 'background-color');
      if (!bg || !STRONG.test(bg[1])) continue;
      if (ACCENT_TEXT.test(r.body)) continue;
      if (/:(hover|focus|focus-visible|active|disabled)|\[aria-|\[data-/.test(r.selector)) continue;
      missing.push(`${r.file}::${r.selector}`);
    }
    expect(missing).toEqual([]);
  });

  it('every inline accent fill carrying text is converted too', () => {
    const offenders: string[] = [];
    for (const abs of walk(SRC, ['.tsx'])) {
      const file = relative(SRC, abs);
      const src = readFileSync(abs, 'utf-8');
      const re = /background:\s*'([^']*)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        if (!isAccentFillValue(m[1])) continue;
        const window = src.slice(Math.max(0, m.index - 300), m.index + 300);
        if (NON_TEXT_INLINE.some((n) => n.file === file && window.includes(n.contains))) continue;
        offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders, `inline accent fills carrying text:\n${offenders.join('\n')}`).toEqual([]);
  });
});
