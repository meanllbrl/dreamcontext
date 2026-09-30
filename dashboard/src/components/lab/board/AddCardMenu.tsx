import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { AddCardMenuProps } from './boardTypes';
import {
  cardFromBlockType, cardFromHtml, cardFromInsight, entryOf, escapeHtml, insightChoices, libraryBlockTypes,
} from './editorModel';
import './editors.css';

/**
 * ADD A CARD, three ways (plan D3):
 *
 * - From an insight: the insight as a legacy card, drawn exactly as v1.
 *   Insights on no board come first and say so.
 * - From the library: one catalog block type, bound to the "Bind to" insight.
 * - Custom HTML: a vault library entry reused by ref (its declared inputs bound
 *   to the "Bind to" insight), or a blank inline block to write from scratch.
 *
 * Every pick is one whole new card through `onAdd`, already placed in the
 * first free slot of its default size; the page records undo and saves.
 */

export function AddCardMenu({ board, unplaced, insights, catalog, library, onAdd, onClose }: AddCardMenuProps) {
  const { t } = useI18n();
  const choices = useMemo(() => insightChoices(insights, unplaced), [insights, unplaced]);
  const [query, setQuery] = useState('');
  const [bindTo, setBindTo] = useState<string>(() => choices[0]?.slug ?? '');
  useEffect(() => {
    if (!choices.some((c) => c.slug === bindTo)) setBindTo(choices[0]?.slug ?? '');
  }, [choices, bindTo]);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);

  const q = query.trim().toLowerCase();
  const shown = q ? choices.filter((c) => c.title.toLowerCase().includes(q) || c.slug.includes(q)) : choices;
  const summaryOf = (slug: string) => insights.find((i) => i.slug === slug);
  const ctx = {
    insight: bindTo || null,
    tabLabel: t('lab.editor.tabs.defaultLabel').replace('{n}', '1'),
    htmlStarter: `<p>${escapeHtml(t('lab.editor.html.starter'))}</p>`,
  };

  return (
    <aside
      className="lab-editor"
      data-lab-add-card
      aria-label={t('lab.editor.add.title')}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <header className="lab-editor-head">
        <span className="lab-editor-title">{t('lab.editor.add.title')}</span>
        <button type="button" className="board-btn" onClick={onClose}>{t('lab.editor.close')}</button>
      </header>

      <section className="lab-editor-section" data-lab-add-section="insight">
        <span className="lab-editor-heading">{t('lab.editor.add.fromInsight')}</span>
        <input
          ref={searchRef}
          className="lab-editor-input"
          type="search"
          value={query}
          placeholder={t('lab.editor.add.search')}
          aria-label={t('lab.editor.add.search')}
          onChange={(e) => setQuery(e.target.value)}
        />
        {shown.length === 0 && <p className="lab-editor-hint">{t(choices.length === 0 ? 'lab.editor.add.noInsights' : 'lab.editor.add.noMatch')}</p>}
        <ul className="lab-editor-list">
          {shown.map((c) => (
            <li key={c.slug}>
              <button
                type="button"
                className="lab-editor-item"
                data-lab-add-insight={c.slug}
                data-lab-unplaced={c.unplaced ? 'true' : undefined}
                onClick={() => onAdd(cardFromInsight(catalog, board, c.slug, summaryOf(c.slug)))}
              >
                <span className="lab-editor-item-name">{c.title}</span>
                {c.unplaced && <span className="lab-editor-badge">{t('lab.editor.add.unplaced')}</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="lab-editor-section">
        <label className="lab-editor-field">
          <span className="lab-editor-label">{t('lab.editor.add.bindTo')}</span>
          <select className="lab-editor-input" data-lab-field="bind-to" value={bindTo} onChange={(e) => setBindTo(e.target.value)}>
            {choices.length === 0 && <option value="">{t('lab.editor.none')}</option>}
            {choices.map((c) => <option key={c.slug} value={c.slug}>{c.title}</option>)}
          </select>
          <span className="lab-editor-hint">{t('lab.editor.add.bindHint')}</span>
        </label>
      </section>

      <section className="lab-editor-section" data-lab-add-section="library">
        <span className="lab-editor-heading">{t('lab.editor.add.fromLibrary')}</span>
        <ul className="lab-editor-grid">
          {libraryBlockTypes(catalog).map((type) => {
            const entry = entryOf(catalog, type);
            const needsData = entry.data === 'binding';
            return (
              <li key={type}>
                <button
                  type="button"
                  className="lab-editor-tile"
                  data-lab-add-type={type}
                  disabled={needsData && !bindTo}
                  title={t(entry.descriptionKey)}
                  onClick={() => onAdd(cardFromBlockType(catalog, board, type, ctx))}
                >
                  <span className="lab-editor-item-name">{t(entry.labelKey)}</span>
                  <span className="lab-editor-item-detail">{t(entry.descriptionKey)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="lab-editor-section" data-lab-add-section="html">
        <span className="lab-editor-heading">{t('lab.editor.add.customHtml')}</span>
        <ul className="lab-editor-list">
          {library.map((entry) => (
            <li key={entry.slug}>
              <button
                type="button"
                className="lab-editor-item"
                data-lab-add-html={entry.slug}
                onClick={() => onAdd(cardFromHtml(catalog, board, entry, ctx))}
              >
                <span className="lab-editor-item-name">{entry.title}</span>
                {entry.description && <span className="lab-editor-item-detail">{entry.description}</span>}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="lab-editor-item"
              data-lab-add-html="blank"
              onClick={() => onAdd(cardFromHtml(catalog, board, null, ctx))}
            >
              <span className="lab-editor-item-name">{t('lab.editor.add.blankHtml')}</span>
              <span className="lab-editor-item-detail">{t('lab.editor.add.blankHtmlHint')}</span>
            </button>
          </li>
        </ul>
        {library.length === 0 && <p className="lab-editor-hint">{t('lab.editor.add.libraryEmpty')}</p>}
      </section>
    </aside>
  );
}
