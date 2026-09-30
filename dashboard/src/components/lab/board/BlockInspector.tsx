import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useInsightCache } from '../../../hooks/useBoards';
import type { InsightSummary } from '../../../hooks/useLab';
import type {
  Block, BlockCatalog, BlockType, Card, InspectorProps, LibraryBlock,
} from './boardTypes';
import {
  addBlock, addTab, canRemoveBlock, cardProblems, changeType, datasetKeys, effectiveBlocks, entryOf, enumLabelKey,
  escapeHtml, fieldsFor, formatListField, formatSortField, formatWhereField, getBlock, inlineToRef, inputRows,
  inputsRecord, moveBlock, movedPath, moveTab, newBlock, parseBinding, parseListField, parseNumberField,
  parseSortField, parseWhereField, pathKey, refBlock, refToInline, removeBlock, removeTab, renameTab, setBinding,
  setInputs, setOption, typeChoices, updateBlock, type EditorProblem, type FieldSpec,
} from './editorModel';
import { SaveToLibraryDialog } from './SaveToLibraryDialog';
import './editors.css';

/**
 * THE BLOCK INSPECTOR: a card's blocks and every setting they have, without code.
 *
 * Top: the card (title, primary insight). Then the block outline: add, remove
 * and reorder blocks, and inside a `tabs` block its tabs and their blocks (one
 * level). Then the selected block: its type (changed in place, only to types
 * that read the same frame kinds), its data binding (an insight, optionally
 * one of its datasets) and one field per catalog option, generated from the
 * catalog schema (`fieldsFor`), never listed by hand. An html block edits its
 * markup and declared inputs, and saves the markup to the vault library.
 *
 * Every edit is the card's whole next value through `onChange`, so the page's
 * save queue and undo stack own it. An edit the engine's strict write would
 * refuse (a filter with no dimension, an html block with neither markup nor a
 * library ref) stays a local draft with its problem shown until it is fixed;
 * the draft is dropped as soon as the page hands in a different card (undo, a
 * reload). Text fields commit on blur or Enter, not per keystroke, so one
 * edit is one undo step.
 */

type Draft = { base: Card; card: Card };

/**
 * The inspector's heading, in the words a reader knows the card by: its title, its insight's
 * name, the library entry its first block reuses, the first block's type ("Custom HTML"), and
 * only then "Untitled card". Never the internal card id.
 */
export function inspectorTitle(
  card: Card,
  blocks: readonly Block[],
  insights: readonly { slug: string; title: string }[],
  library: readonly { slug: string; title: string }[],
  t: (key: string) => string,
): string {
  if (card.title?.trim()) return card.title;
  if (card.insight) return insights.find((i) => i.slug === card.insight)?.title ?? card.insight;
  const first = blocks[0];
  if (!first) return t('lab.editor.untitledCard');
  const ref = typeof first.options.ref === 'string' ? first.options.ref : null;
  const entry = ref ? library.find((b) => b.slug === ref) : undefined;
  if (entry?.title) return entry.title;
  const label = t(`lab.block.${first.type}`);
  return label === `lab.block.${first.type}` ? t('lab.editor.untitledCard') : label;
}

export function BlockInspector({
  board, card, blockPath, catalog, library, insights, onChange, onSelectBlock, onClose,
}: InspectorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const view = draft && draft.base === card ? draft.card : card;
  const problems = useMemo(() => cardProblems(catalog, view), [catalog, view]);
  const selected = blockPath ? getBlock(view, blockPath) : null;
  const path = selected ? blockPath : null;
  useEffect(() => { setSavingToLibrary(false); }, [path ? pathKey(path) : null]);

  const commit = (next: Card) => {
    if (cardProblems(catalog, next).length === 0) {
      setDraft(null);
      onChange(next);
    } else {
      setDraft({ base: card, card: next });
    }
  };
  const editSelected = (fn: (b: Block) => Block) => { if (path) commit(updateBlock(view, path, fn)); };

  const ctx = {
    insight: view.insight ?? insights[0]?.slug ?? null,
    tabLabel: t('lab.editor.tabs.defaultLabel').replace('{n}', '1'),
    htmlStarter: `<p>${escapeHtml(t('lab.editor.html.starter'))}</p>`,
  };

  const add = (type: BlockType, tab: { at: number; tab: number } | null) => {
    const res = addBlock(view, newBlock(catalog, type, ctx), tab);
    if (!res) return;
    commit(res.card);
    onSelectBlock(res.path);
  };

  const blocks = effectiveBlocks(view);
  const title = inspectorTitle(view, blocks, insights, library, t);

  return (
    <aside className="lab-editor" data-lab-inspector aria-label={t('lab.editor.inspector')}>
      <header className="lab-editor-head">
        <span className="lab-editor-title" title={title}>{title}</span>
        <button type="button" className="board-btn" onClick={onClose}>{t('lab.editor.close')}</button>
      </header>

      <section className="lab-editor-section">
        <span className="lab-editor-heading">{t('lab.editor.card')}</span>
        <Field label={t('lab.editor.card.title')}>
          <CommitText
            field="card-title"
            value={view.title ?? ''}
            placeholder={insights.find((i) => i.slug === view.insight)?.title ?? ''}
            onCommit={(v) => {
              const next: Card = { ...view };
              if (v.trim()) next.title = v;
              else delete next.title;
              commit(next);
            }}
          />
        </Field>
        <Field label={t('lab.editor.card.insight')} hint={t('lab.editor.card.insightHint')}>
          <InsightSelect
            field="card-insight"
            insights={insights}
            value={view.insight ?? ''}
            emptyLabel={t('lab.editor.none')}
            onChange={(slug) => {
              const next: Card = { ...view };
              if (slug) next.insight = slug;
              else delete next.insight;
              commit(next);
            }}
          />
        </Field>
        {problems.some((p) => p.path === '') && <Problem code="card-empty" />}
      </section>

      <section className="lab-editor-section" data-lab-inspector-blocks>
        <span className="lab-editor-heading">{t('lab.editor.blocks')}</span>
        <ol className="lab-editor-outline">
          {blocks.map((b, i) => (
            <li key={i}>
              <OutlineRow
                block={b}
                path={[i]}
                card={view}
                catalog={catalog}
                selected={!!path && pathKey(path) === String(i)}
                problem={problems.some((p) => p.path === String(i))}
                onSelect={() => onSelectBlock([i])}
                onMove={(d) => { commit(moveBlock(view, [i], d)); if (path && pathKey(path) === String(i)) onSelectBlock(movedPath([i], d)); }}
                onRemove={() => { commit(removeBlock(view, [i])); onSelectBlock(null); }}
                count={blocks.length}
              />
              {b.type === 'tabs' && (
                <ol className="lab-editor-outline lab-editor-outline--nested">
                  {(b.tabs ?? []).map((tab, ti) => (
                    <li key={ti}>
                      <span className="lab-editor-tabname">{tab.label}</span>
                      <ol className="lab-editor-outline">
                        {tab.blocks.map((child, ci) => {
                          const cp = [i, ti, ci];
                          return (
                            <li key={ci}>
                              <OutlineRow
                                block={child}
                                path={cp}
                                card={view}
                                catalog={catalog}
                                selected={!!path && pathKey(path) === pathKey(cp)}
                                problem={problems.some((p) => p.path === pathKey(cp))}
                                onSelect={() => onSelectBlock(cp)}
                                onMove={(d) => { commit(moveBlock(view, cp, d)); if (path && pathKey(path) === pathKey(cp)) onSelectBlock(movedPath(cp, d)); }}
                                onRemove={() => { commit(removeBlock(view, cp)); onSelectBlock(null); }}
                                count={tab.blocks.length}
                              />
                            </li>
                          );
                        })}
                      </ol>
                      <AddBlock catalog={catalog} nested onAdd={(type) => add(type, { at: i, tab: ti })} label={t('lab.editor.addToTab')} />
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ol>
        <AddBlock catalog={catalog} nested={false} onAdd={(type) => add(type, null)} label={t('lab.editor.addBlock')} />
      </section>

      {selected && path && (
        <BlockSection
          key={pathKey(path)}
          block={selected}
          path={path}
          card={view}
          catalog={catalog}
          insights={insights}
          library={library}
          problems={problems.filter((p) => p.path === pathKey(path))}
          onEdit={editSelected}
          onEditCard={commit}
          onSaveToLibrary={() => setSavingToLibrary(true)}
        />
      )}

      {selected && path && savingToLibrary && selected.type === 'html' && (
        <SaveToLibraryDialog
          block={selected}
          library={library}
          onClose={() => setSavingToLibrary(false)}
          onSaved={(entry) => {
            setSavingToLibrary(false);
            editSelected((b) => inlineToRef(b, entry));
          }}
        />
      )}
      {board.warnings.some((w) => w.cardId === view.id) && (
        <section className="lab-editor-section">
          <span className="lab-editor-heading">{t('lab.editor.warnings')}</span>
          {board.warnings.filter((w) => w.cardId === view.id).map((w, i) => (
            <p key={i} className="lab-editor-hint">{w.message}</p>
          ))}
        </section>
      )}
    </aside>
  );
}

// ─── Outline ────────────────────────────────────────────────────────────────

function OutlineRow({
  block, path, card, catalog, selected, problem, onSelect, onMove, onRemove, count,
}: {
  block: Block;
  path: number[];
  card: Card;
  catalog: BlockCatalog;
  selected: boolean;
  problem: boolean;
  onSelect: () => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  count: number;
}) {
  const { t } = useI18n();
  const at = path[path.length - 1];
  const entry = entryOf(catalog, block.type);
  const detail = block.type === 'html'
    ? (typeof block.options.ref === 'string' ? block.options.ref : t('lab.editor.html.inline'))
    : block.data ?? (block.type === 'insight' ? card.insight ?? '' : '');
  return (
    <div className={`lab-editor-block${selected ? ' lab-editor-block--on' : ''}`} data-lab-inspector-block={pathKey(path)}>
      <button type="button" className="lab-editor-block-name" aria-pressed={selected} onClick={onSelect}>
        <span className="lab-editor-block-type">{t(entry.labelKey)}</span>
        {detail && <span className="lab-editor-block-detail">{detail}</span>}
        {problem && <span className="lab-editor-dot" aria-label={t('lab.editor.needsFix')} />}
      </button>
      <button type="button" className="lab-editor-icon" aria-label={t('lab.editor.moveUp')} disabled={at === 0} onClick={() => onMove(-1)}>↑</button>
      <button type="button" className="lab-editor-icon" aria-label={t('lab.editor.moveDown')} disabled={at >= count - 1} onClick={() => onMove(1)}>↓</button>
      <button type="button" className="lab-editor-icon" aria-label={t('lab.editor.remove')} disabled={!canRemoveBlock(card, path)} onClick={onRemove}>×</button>
    </div>
  );
}

function AddBlock({ catalog, nested, onAdd, label }: { catalog: BlockCatalog; nested: boolean; onAdd: (type: BlockType) => void; label: string }) {
  const { t } = useI18n();
  const types = catalog.types.filter((ty) => !(nested && ty === 'tabs'));
  const [type, setType] = useState<BlockType>(types[0]);
  return (
    <div className="lab-editor-row" data-lab-inspector-add={nested ? 'tab' : 'card'}>
      <select className="lab-editor-input" aria-label={t('lab.editor.blockType')} value={type} onChange={(e) => setType(e.target.value as BlockType)}>
        {types.map((ty) => <option key={ty} value={ty}>{t(entryOf(catalog, ty).labelKey)}</option>)}
      </select>
      <button type="button" className="board-btn" onClick={() => onAdd(type)}>{label}</button>
    </div>
  );
}

// ─── The selected block ─────────────────────────────────────────────────────

function BlockSection({
  block, path, card, catalog, insights, library, problems, onEdit, onEditCard, onSaveToLibrary,
}: {
  block: Block;
  path: number[];
  card: Card;
  catalog: BlockCatalog;
  insights: InsightSummary[];
  library: LibraryBlock[];
  problems: EditorProblem[];
  onEdit: (fn: (b: Block) => Block) => void;
  onEditCard: (card: Card) => void;
  onSaveToLibrary: () => void;
}) {
  const { t } = useI18n();
  const entry = entryOf(catalog, block.type);
  const choices = typeChoices(catalog, block.type);
  const fields = fieldsFor(entry);
  const optionProblem = (key: string) => problems.find((p) => p.key === key && p.code !== 'tab-label');

  return (
    <section className="lab-editor-section" data-lab-inspector-selected={pathKey(path)}>
      <span className="lab-editor-heading">{t(entry.labelKey)}</span>
      <p className="lab-editor-hint">{t(entry.descriptionKey)}</p>

      <Field label={t('lab.editor.type')} hint={choices.length <= 1 ? t('lab.editor.typeFixed') : undefined}>
        <select
          className="lab-editor-input"
          data-lab-field="type"
          value={block.type}
          disabled={choices.length <= 1}
          onChange={(e) => onEdit((b) => changeType(catalog, b, e.target.value as BlockType))}
        >
          {choices.map((ty) => <option key={ty} value={ty}>{t(entryOf(catalog, ty).labelKey)}</option>)}
        </select>
      </Field>

      {entry.data === 'binding' && (
        <BindingField block={block} insights={insights} onEdit={onEdit} />
      )}
      {entry.data === 'insight' && (
        <Field label={t('lab.editor.data')} hint={t('lab.editor.dataInsightHint')}>
          <InsightSelect
            field="data"
            insights={insights}
            value={block.data ?? ''}
            emptyLabel={t('lab.editor.cardInsight')}
            onChange={(slug) => onEdit((b) => setBinding(b, slug || null))}
          />
        </Field>
      )}
      {problems.some((p) => p.code === 'data-required' || p.code === 'data-unsafe' || p.code === 'insight-missing') && (
        <Problem code={problems.find((p) => p.code === 'data-required' || p.code === 'data-unsafe' || p.code === 'insight-missing')!.code} />
      )}

      {fields.map((f) => (
        <OptionField
          key={f.key}
          spec={f}
          block={block}
          path={path}
          card={card}
          insights={insights}
          library={library}
          problem={optionProblem(f.key)}
          onEdit={onEdit}
          onEditCard={onEditCard}
        />
      ))}

      {block.type === 'html' && problems.some((p) => p.code === 'html-source') && <Problem code="html-source" />}
      {block.type === 'tabs' && problems.some((p) => p.code === 'tabs-empty' || p.code === 'tab-label') && <Problem code="tab-label" />}

      {block.type === 'html' && typeof block.options.ref !== 'string' && (
        <button
          type="button"
          className="board-btn"
          data-lab-save-to-library
          disabled={!(typeof block.options.html === 'string' && block.options.html.trim())}
          onClick={onSaveToLibrary}
        >{t('lab.editor.library.open')}</button>
      )}
    </section>
  );
}

function BindingField({ block, insights, onEdit }: { block: Block; insights: InsightSummary[]; onEdit: (fn: (b: Block) => Block) => void }) {
  const { t } = useI18n();
  const listId = useId();
  const parsed = parseBinding(block.data);
  const insight = parsed?.insight ?? '';
  const cache = useInsightCache(insight || null);
  const keys = datasetKeys(cache.data?.cache);
  return (
    <>
      <Field label={t('lab.editor.data')}>
        <InsightSelect
          field="data"
          insights={insights}
          value={insight}
          emptyLabel={t('lab.editor.pickInsight')}
          onChange={(slug) => onEdit((b) => setBinding(b, slug || null, slug === insight ? parsed?.dataset ?? null : null))}
        />
      </Field>
      {insight && (
        <Field label={t('lab.editor.dataset')} hint={t('lab.editor.datasetHint')}>
          <CommitText
            field="dataset"
            mono
            list={listId}
            value={parsed?.dataset ?? ''}
            placeholder={t('lab.editor.datasetPrimary')}
            onCommit={(v) => onEdit((b) => setBinding(b, insight, v.trim() || null))}
          />
          <datalist id={listId}>{keys.map((k) => <option key={k} value={k} />)}</datalist>
        </Field>
      )}
    </>
  );
}

function OptionField({
  spec, block, path, card, insights, library, problem, onEdit, onEditCard,
}: {
  spec: FieldSpec;
  block: Block;
  path: number[];
  card: Card;
  insights: InsightSummary[];
  library: LibraryBlock[];
  problem: EditorProblem | undefined;
  onEdit: (fn: (b: Block) => Block) => void;
  onEditCard: (card: Card) => void;
}) {
  const { t } = useI18n();
  const { key, schema } = spec;
  const value = block.options[key];
  const label = t(spec.labelKey);
  const set = (v: unknown) => onEdit((b) => setOption(b, key, v));
  const bad = problem ? <Problem code={problem.code} /> : null;

  switch (spec.control) {
    case 'toggle': {
      const on = typeof value === 'boolean' ? value : schema.default === true;
      return (
        <label className="lab-editor-check">
          <input
            type="checkbox"
            data-lab-field={key}
            checked={on}
            onChange={(e) => set(e.target.checked === (schema.default === true) ? undefined : e.target.checked)}
          />
          <span>{label}</span>
        </label>
      );
    }
    case 'select': {
      const current = value ?? schema.default ?? '';
      const labelOf = (v: string | number) => {
        const k = enumLabelKey(key, v);
        const s = t(k);
        return s === k ? String(v) : s;
      };
      return (
        <Field label={label}>
          <select
            className="lab-editor-input"
            data-lab-field={key}
            value={String(current)}
            onChange={(e) => {
              const raw = e.target.value;
              const v = (schema.enum ?? []).find((x) => String(x) === raw);
              set(v === undefined || v === schema.default ? undefined : v);
            }}
          >
            {schema.default === undefined && <option value="">{t('lab.editor.default')}</option>}
            {(schema.enum ?? []).map((v) => <option key={String(v)} value={String(v)}>{labelOf(v)}</option>)}
          </select>
          {bad}
        </Field>
      );
    }
    case 'number':
      return (
        <Field label={label} hint={schema.min !== undefined && schema.max !== undefined
          ? t('lab.editor.range').replace('{min}', String(schema.min)).replace('{max}', String(schema.max))
          : undefined}>
          <CommitText
            field={key}
            type="number"
            value={typeof value === 'number' ? String(value) : ''}
            placeholder={schema.default !== undefined && schema.default !== null ? String(schema.default) : ''}
            onCommit={(v) => set(parseNumberField(v, schema))}
          />
          {bad}
        </Field>
      );
    case 'text':
      return (
        <Field label={label}>
          <CommitText field={key} value={typeof value === 'string' ? value : ''} onCommit={(v) => set(v)} />
          {bad}
        </Field>
      );
    case 'textarea':
      return (
        <Field label={label}>
          <CommitText field={key} multiline rows={4} value={typeof value === 'string' ? value : ''} onCommit={(v) => set(v)} />
          {bad}
        </Field>
      );
    case 'list':
      return (
        <Field label={label} hint={t('lab.editor.listHint')}>
          <CommitText field={key} value={formatListField(value)} onCommit={(v) => set(parseListField(v))} />
          {bad}
        </Field>
      );
    case 'where':
      return (
        <Field label={label} hint={t('lab.editor.whereHint')}>
          <CommitText field={key} multiline mono rows={2} value={formatWhereField(value)} placeholder="country: TR, DE" onCommit={(v) => set(parseWhereField(v))} />
          {bad}
        </Field>
      );
    case 'sort': {
      const s = formatSortField(value);
      return (
        <Field label={label}>
          <div className="lab-editor-row" data-lab-field={key}>
            <CommitText field={`${key}-by`} mono value={s.by} placeholder="v" onCommit={(v) => set(parseSortField(v, s.dir))} />
            <select
              className="lab-editor-input"
              aria-label={t('lab.editor.sortDir')}
              value={s.dir}
              onChange={(e) => set(parseSortField(s.by, e.target.value as 'asc' | 'desc'))}
            >
              <option value="desc">{t('lab.editor.sort.desc')}</option>
              <option value="asc">{t('lab.editor.sort.asc')}</option>
            </select>
          </div>
          {bad}
        </Field>
      );
    }
    case 'tabs':
      return <TabsField block={block} path={path} card={card} onEditCard={onEditCard} />;
    case 'inputs':
      return <InputsField block={block} library={library} insights={insights} onEdit={onEdit} />;
    case 'html':
      if (typeof block.options.ref === 'string') return null;
      return (
        <Field label={label}>
          <CommitText field={key} multiline mono rows={10} value={typeof value === 'string' ? value : ''} onCommit={(v) => set(v)} />
          {bad}
        </Field>
      );
    case 'library-ref': {
      const ref = typeof value === 'string' ? value : '';
      const current = library.find((b) => b.slug === ref) ?? null;
      return (
        <Field label={t('lab.editor.html.source')}>
          <select
            className="lab-editor-input"
            data-lab-field={key}
            value={ref}
            onChange={(e) => {
              const slug = e.target.value;
              if (!slug) onEdit((b) => refToInline(b, current ?? { html: '' }));
              else {
                const hit = library.find((b) => b.slug === slug);
                if (hit) onEdit((b) => refBlock(hit, null, inputsRecord(b.options.inputs) ?? {}));
              }
            }}
          >
            <option value="">{t('lab.editor.html.inline')}</option>
            {ref && !current && <option value={ref}>{ref}</option>}
            {library.map((b) => <option key={b.slug} value={b.slug}>{b.title}</option>)}
          </select>
          {ref && <span className="lab-editor-hint">{current?.description ?? t('lab.editor.html.refHint')}</span>}
          {bad}
        </Field>
      );
    }
  }
}

function TabsField({ block, path, card, onEditCard }: { block: Block; path: number[]; card: Card; onEditCard: (card: Card) => void }) {
  const { t } = useI18n();
  const at = path[0];
  const tabs = block.tabs ?? [];
  return (
    <div className="lab-editor-field" data-lab-field="tabs">
      <span className="lab-editor-label">{t('lab.editor.tabs')}</span>
      {tabs.map((tab, i) => (
        <div key={i} className="lab-editor-row">
          <CommitText field={`tab-${i}`} value={tab.label} onCommit={(v) => onEditCard(renameTab(card, at, i, v))} />
          <button type="button" className="lab-editor-icon" aria-label={t('lab.editor.moveUp')} disabled={i === 0} onClick={() => onEditCard(moveTab(card, at, i, -1))}>↑</button>
          <button type="button" className="lab-editor-icon" aria-label={t('lab.editor.moveDown')} disabled={i >= tabs.length - 1} onClick={() => onEditCard(moveTab(card, at, i, 1))}>↓</button>
          <button type="button" className="lab-editor-icon" aria-label={t('lab.editor.remove')} disabled={tabs.length <= 1} onClick={() => onEditCard(removeTab(card, at, i))}>×</button>
        </div>
      ))}
      <button
        type="button"
        className="lab-editor-link"
        onClick={() => onEditCard(addTab(card, at, t('lab.editor.tabs.defaultLabel').replace('{n}', String(tabs.length + 1))))}
      >{t('lab.editor.tabs.add')}</button>
    </div>
  );
}

function InputsField({
  block, library, insights, onEdit,
}: { block: Block; library: LibraryBlock[]; insights: InsightSummary[]; onEdit: (fn: (b: Block) => Block) => void }) {
  const { t } = useI18n();
  const listId = useId();
  const ref = typeof block.options.ref === 'string' ? block.options.ref : null;
  const entry = ref ? library.find((b) => b.slug === ref) ?? null : null;
  const bound = inputsRecord(block.options.inputs) ?? {};
  // A library block declares its names; an inline one declares whatever rows it has.
  const rows = ref
    ? (entry?.inputs ?? []).map((i) => ({ name: i.name, binding: bound[i.name] ?? '' }))
    : inputRows(block);
  const write = (next: Array<{ name: string; binding: string }>) => onEdit((b) => setInputs(b, next));
  return (
    <div className="lab-editor-field" data-lab-field="inputs">
      <span className="lab-editor-label">{t('lab.editor.inputs')}</span>
      <span className="lab-editor-hint">{t('lab.editor.inputs.hint')}</span>
      {rows.map((r, i) => (
        <div key={`${i}:${r.name}`} className="lab-editor-row">
          {ref ? (
            <span className="lab-editor-inputname">{r.name}</span>
          ) : (
            <CommitText
              field={`input-${i}-name`}
              mono
              value={r.name}
              placeholder={t('lab.editor.inputs.name')}
              onCommit={(v) => write(rows.map((x, j) => (j === i ? { ...x, name: v } : x)))}
            />
          )}
          <CommitText
            field={`input-${i}-binding`}
            mono
            list={listId}
            value={r.binding}
            placeholder={t('lab.editor.inputs.binding')}
            onCommit={(v) => write(rows.map((x, j) => (j === i ? { ...x, binding: v } : x)))}
          />
          {!ref && (
            <button type="button" className="lab-editor-icon" aria-label={t('lab.editor.remove')} onClick={() => write(rows.filter((_, j) => j !== i))}>×</button>
          )}
        </div>
      ))}
      <datalist id={listId}>{insights.map((i) => <option key={i.slug} value={i.slug}>{i.title}</option>)}</datalist>
      {!ref && (
        <button
          type="button"
          className="lab-editor-link"
          onClick={() => write([...rows, { name: nextInputName(rows), binding: insights[0]?.slug ?? '' }])}
        >{t('lab.editor.inputs.add')}</button>
      )}
    </div>
  );
}

function nextInputName(rows: ReadonlyArray<{ name: string }>): string {
  let n = rows.length + 1;
  while (rows.some((r) => r.name === `input${n}`)) n++;
  return `input${n}`;
}

// ─── Small controls ─────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="lab-editor-field">
      <span className="lab-editor-label">{label}</span>
      {children}
      {hint && <span className="lab-editor-hint">{hint}</span>}
    </label>
  );
}

function Problem({ code }: { code: EditorProblem['code'] }) {
  const { t } = useI18n();
  return <span className="lab-editor-problem" role="status">{t(`lab.editor.problem.${code}`)}</span>;
}

function InsightSelect({
  field, insights, value, emptyLabel, onChange,
}: { field: string; insights: InsightSummary[]; value: string; emptyLabel: string; onChange: (slug: string) => void }) {
  const known = insights.some((i) => i.slug === value);
  return (
    <select className="lab-editor-input" data-lab-field={field} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {value && !known && <option value={value}>{value}</option>}
      {insights.map((i) => <option key={i.slug} value={i.slug}>{i.title}</option>)}
    </select>
  );
}

/** A text field that commits on blur or Enter (Escape reverts), so typing is one edit, not one per key. */
function CommitText({
  field, value, onCommit, multiline = false, mono = false, rows, type = 'text', placeholder, list,
}: {
  field: string;
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  mono?: boolean;
  rows?: number;
  type?: 'text' | 'number';
  placeholder?: string;
  list?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const done = () => { if (text !== value) onCommit(text); };
  const className = `lab-editor-input${mono ? ' lab-editor-input--mono' : ''}${multiline ? ' lab-editor-textarea' : ''}`;
  if (multiline) {
    return (
      <textarea
        className={className}
        data-lab-field={field}
        rows={rows}
        value={text}
        placeholder={placeholder}
        spellCheck={!mono}
        onChange={(e) => setText(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); setText(value); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done(); }
        }}
      />
    );
  }
  return (
    <input
      className={className}
      data-lab-field={field}
      type={type}
      value={text}
      placeholder={placeholder}
      list={list}
      spellCheck={!mono}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); setText(value); }
        if (e.key === 'Enter') { e.preventDefault(); done(); }
      }}
    />
  );
}
