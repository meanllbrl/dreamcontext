import { useI18n } from '../../context/I18nContext';
import './maturity-tag.css';

/**
 * THE ONE "not finished yet" marker, for every surface that has one.
 *
 * It replaces three near-identical implementations that had drifted apart: the rail's
 * `.sidebar-lab-tag`/`-beta-tag`/`-off-tag`, the composer menu's `.chat-cmp-badge`, and
 * Settings' `.settings-beta-badge`/`.settings-lab-badge`. Three chips, three vocabularies
 * ("Lab" / "ALPHA" / "BETA"), three stylesheets, one meaning.
 *
 * ── Two different claims, deliberately NOT collapsed ───────────────────────────────
 * `chatModes.ts` documents at length — and `tests/unit/chat-mode-mirror.test.ts` enforces —
 * that a mode carries EITHER:
 *   • `badge`    — announced but NOT offered, and always paired with `disabled`; or
 *   • `maturity` — offered and unfinished, and never implies `disabled`.
 * Overloading one field for both bought a word by deleting a guard that catches a real
 * mistake. So this component keeps them apart too: {@link MaturityTagProps.level} is the
 * ladder rung, {@link MaturityTagProps.label} is literal copy for an announcement. A
 * `label` is always muted — "Soon" is not a recommendation.
 *
 * ── Vocabulary ────────────────────────────────────────────────────────────────────
 * `alpha` → `beta`, and nothing else. "Lab" is gone: the style guide says plainly that
 * "Lab is Insights in the UI — the `lab` CLI name is an implementation detail and never
 * surfaces to a user", and the rail was printing `Lab` on five rows including the Insights
 * page itself. Copy is SENTENCE CASE (K15: no uppercase labels); the old chips shouted in
 * `text-transform: uppercase` and that is not coming back — `maturity-tag.css` has a test
 * that refuses it.
 */

export type MaturityLevel = 'alpha' | 'beta' | 'off';

export interface MaturityTagProps {
  /** A rung on the ladder. Renders that level's own ink, and its copy comes from i18n. */
  level?: MaturityLevel;
  /**
   * Literal copy for an ANNOUNCED-NOT-OFFERED chip (`ChatModeRow.badge`, a model note's
   * badge, Settings' "Experimental"). Verbatim — these are not a fixed vocabulary — and
   * always muted, because a thing you cannot pick must not read like a recommendation.
   */
  label?: string;
  /** Mute a `level` chip too. Implied by `label`. */
  muted?: boolean;
  /** Appended, so a surface keeps its own hook (`.chat-cmp-badge`, `.sidebar-maturity`). */
  className?: string;
}

/**
 * Null when there is nothing to say — so every call site can be an unconditional
 * `<MaturityTag …/>` instead of a ternary that has to re-derive "is there a chip here".
 */
export function MaturityTag({ level, label, muted, className }: MaturityTagProps) {
  const { t } = useI18n();
  if (!level && !label) return null;
  // `label` is copy the caller already chose; a `level` is looked up so Turkish survives.
  const text = label ?? t(`maturity.${level}`);
  const dataLevel = label || muted ? 'muted' : level;
  return (
    <span className={`dc-maturity${className ? ` ${className}` : ''}`} data-level={dataLevel}>
      {text}
    </span>
  );
}
