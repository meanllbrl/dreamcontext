import {
  useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState,
  type DragEvent, type KeyboardEvent, type ReactNode,
} from 'react';
import { emitInstance, useVault } from '../../../context/VaultContext';
import { useKnowledgeList } from '../../../hooks/useKnowledge';
import { openExternalUrl } from '../../../lib/desktop';
import { externalHref } from '../../../lib/externalLinks';
import type { WikiPage, WikiSection } from '../../../lib/whiteboardWidgets';
import { DocumentReader, readerLinkAction } from '../../appLink/DocumentReader';
import { usePagePopup } from '../PagePopup';
import { BackIcon, CloseIcon, ForwardIcon, OpenInAppIcon } from '../PanelIcons';
import { PagePicker } from '../WidgetPickers';
import {
  CLOSED_STACK, canGoBack, canGoForward, currentPage, owningPage, pageStackReducer, pathToPageRef, targetPath,
} from '../pagePopupModel';
import { useWbText, useWhiteboardHost } from '../whiteboardHost';
import {
  addFirstPage, addPage, addSection, dropIndex, editWikiPayload, fitWikiRows, listPages, moveSection, movePage, newSectionId,
  readWikiList, removePage, removeSection, renameSection, renameWikiCard, sectionHasRef, stepPage, type WikiList,
} from '../wikiCardModel';
import { humanizeFileName, knowledgeTitle, pageCardTitle, pageTypeLabel, parseWidgetLink } from '../widgetModel';
import { WidgetButton, WidgetFrame } from './WidgetFrame';
import type { WidgetProps } from './types';
import './wikiWidget.css';

/**
 * THE WIKI CARD: a board's own reading list, kept in the card (`customData.dc`: a title and
 * sections of pages), so a board can carry several, each with its own list.
 *
 * S / M: the card IS its list — section headings, page rows with a readable title and a quiet
 * type label — and a page opens in the board's right side panel. L / XL: the list in a narrow
 * column on the left and the page read INSIDE the card on the right with the panel's own
 * reader (`DocumentReader variant="page"`), with the card's own back / forward (the panel's
 * stack reducer) and one highlight on the row being read. A link inside the page stays in the
 * card; the reader's one header button hands the page to the side panel, where its ⋯ menu
 * (Open on computer, Reveal in Finder, Copy path) lives.
 *
 * Editing happens inside the card, only while it is active (Excalidraw passes pointer events
 * to a widget only then) and only after "Edit", so a card at rest reads clean: add / rename /
 * delete a section (an inline confirm: `window.confirm` is a silent no-op in the desktop
 * app's WKWebView), add a page through the palette's page picker, remove a page, and reorder
 * sections and pages — across sections too — by drag and drop or by Alt+Up / Alt+Down on a
 * focused row. Every edit is a pure list operation (wikiCardModel.ts) written through
 * `commitWidget`, so it lands in the board file with the card.
 */

type Tx = (key: string, fallback: string) => string;

/** A row's identity across renders and moves: its section and its ref (unique in a section). */
const rowKey = (sectionId: string, ref: string) => `${sectionId}\u0000${ref}`;

type Drag = { kind: 'page'; section: string; index: number } | { kind: 'section'; id: string };
type Drop = { kind: 'page'; section: string; before: number } | { kind: 'section'; before: number };

/** The MIME type a wiki drag carries: our own, so a drop that escapes the card is no text. */
const DRAG_TYPE = 'application/x-dreamcontext-wiki';

export function WikiWidget({ elementId, payload, active, size, height }: WidgetProps) {
  const tx = useWbText();
  const host = useWhiteboardHost();
  const popup = usePagePopup();
  const { bus } = useVault();
  const knowledge = useKnowledgeList();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const sectionFallback = tx('whiteboard.wiki.untitledSection', 'Section');
  const list = useMemo(() => readWikiList(payload.sections, sectionFallback), [payload.sections, sectionFallback]);
  const pages = useMemo(() => listPages(list), [list]);
  const titles = useMemo(
    () => new Map((knowledge.data ?? []).map((k) => [k.slug, knowledgeTitle(k)])),
    [knowledge.data],
  );
  const pageTitle = useCallback(
    (page: WikiPage) => pageCardTitle(page.ref, page.label, titles.get(page.ref)),
    [titles],
  );
  const cardTitle = typeof payload.title === 'string' ? payload.title.trim() : '';
  const wide = size === 'l' || size === 'xl';

  // ── edit state: only while the card is active ─────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  /** The page picker: for a section, or (`null`) for the first page of an empty card. */
  const [picker, setPicker] = useState<{ section: string | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (active) return;
    setEditing(false);
    setPicker(null);
    setRenaming(null);
    setConfirming(null);
  }, [active]);

  /** Write one list edit, skipping the write when it changes nothing on the list drawn. */
  const edit = useCallback((op: (l: WikiList) => WikiList) => {
    if (op(list) === list) return;
    host.commitWidget(elementId, (cur) => editWikiPayload(cur, op, sectionFallback));
  }, [host, elementId, list, sectionFallback]);

  // After a keyboard move the row is drawn again in its new place: focus follows it.
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const el = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-wiki-focus]') ?? [])
      .find((node) => node.dataset.wikiFocus === key);
    if (el) { el.focus(); pendingFocus.current = null; }
  });

  // ── the in-card reader (L / XL) ───────────────────────────────────────────────────────────
  const [stack, dispatch] = useReducer(pageStackReducer, CLOSED_STACK);
  const [selected, setSelected] = useState<string | null>(null);
  const shown = currentPage(stack);
  const firstPath = pages.length ? targetPath({ kind: 'knowledge', ref: pages[0].page.ref }) : null;
  // A wide card opens on its first page rather than on an empty reader.
  useEffect(() => {
    if (wide && !shown && firstPath) dispatch({ type: 'open', path: firstPath });
  }, [wide, shown, firstPath]);

  /** The one row to highlight: the one clicked if it is still the page shown, else the first
   *  row of the page shown (a page listed in two sections is highlighted once). */
  const highlighted = useMemo(() => {
    if (!wide || !shown) return null;
    const rows = pages.map(({ section, page }) => ({
      key: rowKey(section.id, page.ref),
      path: targetPath({ kind: 'knowledge', ref: page.ref }),
    }));
    const pick = rows.find((r) => r.key === selected && r.path === shown) ?? rows.find((r) => r.path === shown);
    return pick?.key ?? null;
  }, [wide, shown, pages, selected]);

  const openRow = (section: WikiSection, page: WikiPage) => {
    if (wide && !editing) {
      const path = targetPath({ kind: 'knowledge', ref: page.ref });
      if (!path) return;
      setSelected(rowKey(section.id, page.ref));
      dispatch({ type: 'push', path });
      return;
    }
    if (popup?.openPage({ kind: 'knowledge', ref: page.ref }, elementId)) return;
    // Outside a board page there is no panel: a knowledge page still opens where it lives.
    if (pageTypeLabel(page.ref) === 'Knowledge') emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'knowledge', id: page.ref });
  };

  /** A link the in-card reader followed: another page in this card, or the web. */
  const follow = useCallback((next: string) => {
    if (readerLinkAction(next) !== 'url') { dispatch({ type: 'push', path: next }); return; }
    const link = parseWidgetLink(next);
    if (link && (link.kind === 'knowledge' || link.kind === 'task')) {
      const p = targetPath({ kind: link.kind, ref: link.id });
      if (p) dispatch({ type: 'push', path: p });
      return;
    }
    const href = externalHref(next);
    if (href) void openExternalUrl(href);
  }, []);

  // ── drag and drop ─────────────────────────────────────────────────────────────────────────
  const drag = useRef<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const endDrag = () => { drag.current = null; setDrop(null); };
  const startDrag = (e: DragEvent, d: Drag) => {
    e.stopPropagation();
    drag.current = d;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, d.kind);
  };
  const sameDrop = (a: Drop | null, b: Drop) =>
    !!a && a.kind === b.kind && a.before === b.before && (a.kind === 'section' || (b.kind === 'page' && a.section === b.section));
  const over = (e: DragEvent, target: Drop) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!sameDrop(drop, target)) setDrop(target);
  };
  /** Upper half of the element: before it; lower half: after it. */
  const lowerHalf = (e: DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  const commitDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const from = drag.current;
    const to = drop;
    endDrag();
    if (!from || !to) return;
    if (from.kind === 'page' && to.kind === 'page') {
      const index = dropIndex(from.section, from.index, to.section, to.before);
      const ref = list.sections.find((s) => s.id === from.section)?.pages[from.index]?.ref;
      edit((l) => movePage(l, from.section, from.index, to.section, index));
      if (ref) pendingFocus.current = `page:${to.section}:${ref}`;
    } else if (from.kind === 'section' && to.kind === 'section') {
      const fromIndex = list.sections.findIndex((s) => s.id === from.id);
      edit((l) => moveSection(l, from.id, fromIndex < to.before ? to.before - 1 : to.before));
    }
  };

  // ── keyboard ──────────────────────────────────────────────────────────────────────────────
  const movePageByKey = (e: KeyboardEvent, section: WikiSection, index: number) => {
    if (!editing || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const step = stepPage(list, section.id, index, e.key === 'ArrowUp' ? -1 : 1);
    if (!step) return;
    pendingFocus.current = `page:${step.section}:${section.pages[index].ref}`;
    edit((l) => movePage(l, section.id, index, step.section, step.index));
  };
  const moveSectionByKey = (e: KeyboardEvent, sectionIndex: number, id: string) => {
    if (!editing || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const to = sectionIndex + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= list.sections.length) return;
    pendingFocus.current = `section:${id}`;
    edit((l) => moveSection(l, id, to));
  };
  /** Keys typed in the card are the card's: Excalidraw would read Backspace as "delete the
   *  card" and the arrows as "nudge it". Esc closes the card's own layer first. */
  const onCardKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (picker) { setPicker(null); e.stopPropagation(); }
      else if (confirming) { setConfirming(null); e.stopPropagation(); }
      return;
    }
    e.stopPropagation();
  };

  // ── edits ─────────────────────────────────────────────────────────────────────────────────
  const addNewSection = () => {
    const id = newSectionId();
    edit((l) => addSection(l, tx('whiteboard.wiki.newSection', 'New section'), id));
    setRenaming(id);
  };
  const pickPage = (ref: string) => {
    const target = picker?.section ?? null;
    setPicker(null);
    if (target === null) {
      const id = list.sections[0]?.id ?? newSectionId();
      edit((l) => addFirstPage(l, { ref }, tx('whiteboard.wiki.firstSection', 'Pages'), id));
    } else {
      edit((l) => addPage(l, target, { ref }));
    }
    const path = targetPath({ kind: 'knowledge', ref });
    if (wide && !editing && path) dispatch({ type: 'push', path });
  };

  // ── fitting the list into the card ────────────────────────────────────────────────────────
  // An inactive card cannot scroll, so it shows the whole rows that fit and says how many are
  // left out ("+N more"). It is measured, not guessed: one render draws every row plus a hidden
  // copy of the "+N more" line, the layout effect reads where each row ends, and the next
  // render keeps only the rows `fitWikiRows` allows. Activating the card lifts the clip and the
  // list scrolls — except when the activating press was on the "+N more" line: the canvas hands
  // that click on to whatever is under the pointer a moment later, and with the clip lifted a
  // hidden row would be sitting there. Then the line's own click lifts it.
  const listRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const pressOnMore = useRef(false);
  const showEditor = active && editing;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!active) { setExpanded(false); return; }
    if (!pressOnMore.current) setExpanded(true);
    pressOnMore.current = false;
  }, [active]);
  // An inactive card receives no pointer events, so the press is read off the window.
  useEffect(() => {
    if (active) return;
    const onDown = (e: PointerEvent) => {
      const r = moreRef.current?.getBoundingClientRect();
      pressOnMore.current = !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [active]);
  const clipping = !showEditor && !expanded;
  const [fit, setFit] = useState<{ key: string; rows: number } | null>(null);
  const fitKey = `${size}:${height ?? ''}:${wide}:${JSON.stringify(list.sections)}`;
  const shownRows = clipping && fit?.key === fitKey ? fit.rows : null;
  useLayoutEffect(() => {
    if (!clipping || shownRows !== null || !listRef.current) return;
    setFit({ key: fitKey, rows: measureFit(listRef.current) });
  });
  // A card resized under the clip (a font that loads late, a free-form resize) is measured again.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !clipping || typeof ResizeObserver === 'undefined') return;
    let last = el.clientHeight;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === last) return;
      last = el.clientHeight;
      setFit(null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [clipping, wide, editing]);
  // A list scrolled while active starts at its top again when the clip comes back.
  useLayoutEffect(() => { if (clipping && listRef.current) listRef.current.scrollTop = 0; }, [clipping]);
  const hiddenRows = shownRows === null ? 0 : pages.length - shownRows;
  const expand = () => {
    const first = shownRows === null ? undefined : pages[shownRows];
    if (first) pendingFocus.current = `page:${first.section.id}:${first.page.ref}`;
    setExpanded(true);
  };

  // ── drawing ───────────────────────────────────────────────────────────────────────────────
  const empty = pages.length === 0;
  /** The first page's index, card-wide, of each section: which rows the clip keeps. */
  const sectionStart = new Map<string, number>();
  {
    let n = 0;
    for (const sec of list.sections) { sectionStart.set(sec.id, n); n += sec.pages.length; }
  }
  const rowShown = (sectionId: string, pi: number) =>
    shownRows === null || (sectionStart.get(sectionId) ?? 0) + pi < shownRows;
  const typeWord = (ref: string) => {
    const t = pageTypeLabel(ref);
    return t === 'Knowledge' ? tx('whiteboard.kind.knowledge', 'Knowledge') : t ?? '';
  };

  const listView = (
    <div ref={listRef} className={`wb-wiki-list${clipping ? ' is-clipped' : ''}`} onDragOver={showEditor ? (e) => { if (drag.current) e.preventDefault(); } : undefined} onDrop={showEditor ? commitDrop : undefined}>
      {showEditor && (
        <CardTitleField title={cardTitle} tx={tx} onCommit={(title) => host.commitWidget(elementId, (cur) => renameWikiCard(cur, title, sectionFallback))} />
      )}
      {list.sections.map((section, si) => {
        // A heading never stands alone: a section with no row shown is left out.
        if (!showEditor && !section.pages.some((_, pi) => rowShown(section.id, pi))) return null;
        const sectionDrop = drop?.kind === 'section' ? drop.before : -1;
        return (
          <section
            key={section.id}
            className={`wb-wiki-section${sectionDrop === si ? ' is-drop-before' : ''}${sectionDrop === si + 1 && si === list.sections.length - 1 ? ' is-drop-after' : ''}`}
            data-section-id={section.id}
            onDragOver={showEditor ? (e) => { if (drag.current?.kind === 'section') over(e, { kind: 'section', before: si + (lowerHalf(e) ? 1 : 0) }); } : undefined}
          >
            {showEditor ? (
              <SectionEditRow
                section={section}
                index={si}
                tx={tx}
                renaming={renaming === section.id}
                confirming={confirming === section.id}
                dropHere={drop?.kind === 'page' && drop.section === section.id && drop.before === 0 && section.pages.length === 0}
                onRename={() => { setConfirming(null); setRenaming(section.id); }}
                onRenameDone={(title) => {
                  setRenaming(null);
                  if (title !== null) edit((l) => renameSection(l, section.id, title));
                }}
                onAskDelete={() => { setRenaming(null); setConfirming(section.id); }}
                onDelete={() => { setConfirming(null); edit((l) => removeSection(l, section.id)); }}
                onCancelDelete={() => setConfirming(null)}
                onAddPage={() => setPicker({ section: section.id })}
                onKeyDown={(e) => moveSectionByKey(e, si, section.id)}
                onDragStart={(e) => startDrag(e, { kind: 'section', id: section.id })}
                onDragEnd={endDrag}
                onPageDragOver={(e) => { if (drag.current?.kind === 'page') over(e, { kind: 'page', section: section.id, before: 0 }); }}
              />
            ) : (
              <h3 className="wb-wiki-section-title" title={section.title}>{section.title}</h3>
            )}
            {section.pages.length > 0 && (
              <ul className="wb-wiki-pages">
                {section.pages.map((page, pi) => {
                  if (!rowShown(section.id, pi)) return null;
                  const key = rowKey(section.id, page.ref);
                  const dropBefore = drop?.kind === 'page' && drop.section === section.id ? drop.before : -1;
                  return (
                    <li
                      key={key}
                      data-wiki-fit="row"
                      className={`wb-wiki-row${highlighted === key && !showEditor ? ' is-current' : ''}${dropBefore === pi ? ' is-drop-before' : ''}${dropBefore === pi + 1 && pi === section.pages.length - 1 ? ' is-drop-after' : ''}`}
                      draggable={showEditor || undefined}
                      onDragStart={showEditor ? (e) => startDrag(e, { kind: 'page', section: section.id, index: pi }) : undefined}
                      onDragEnd={showEditor ? endDrag : undefined}
                      onDragOver={showEditor ? (e) => { if (drag.current?.kind === 'page') over(e, { kind: 'page', section: section.id, before: pi + (lowerHalf(e) ? 1 : 0) }); } : undefined}
                    >
                      {showEditor && <span className="wb-wiki-grip" aria-hidden="true"><GripIcon /></span>}
                      <button
                        type="button"
                        className="wb-wiki-row-open"
                        data-wiki-focus={`page:${section.id}:${page.ref}`}
                        data-page-ref={page.ref}
                        aria-current={highlighted === key && !showEditor ? 'page' : undefined}
                        aria-keyshortcuts={showEditor ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                        title={showEditor ? `${pageTitle(page)} · ${tx('whiteboard.wiki.moveHint', 'Drag, or press Alt+Up / Alt+Down, to move')}` : pageTitle(page)}
                        onClick={() => openRow(section, page)}
                        onKeyDown={(e) => movePageByKey(e, section, pi)}
                      >
                        <span className="wb-wiki-row-title">{pageTitle(page)}</span>
                        <span className="wb-wiki-row-type" data-page-type={pageTypeLabel(page.ref) ?? undefined}>{typeWord(page.ref)}</span>
                      </button>
                      {showEditor && (
                        <IconButton
                          className="wb-wiki-row-remove"
                          label={tx('whiteboard.wiki.removePage', 'Remove from this wiki')}
                          onClick={() => edit((l) => removePage(l, section.id, pi))}
                        >
                          <CloseIcon size={14} />
                        </IconButton>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      {clipping && shownRows === null && pages.length > 0 && (
        // The measuring copy: the real line's height, drawn invisibly while the rows are measured.
        <p className="wb-wiki-more wb-wiki-more--measure" data-wiki-measure aria-hidden="true">+0</p>
      )}
      {hiddenRows > 0 && (
        <button ref={moreRef} type="button" className="wb-wiki-more" onClick={expand}>
          {tx('whiteboard.wiki.more', '+{n} more').replace('{n}', String(hiddenRows))}
        </button>
      )}
      {showEditor && (
        <div className="wb-wiki-list-foot">
          <WidgetButton onClick={addNewSection}>
            <span className="wb-wiki-btn-inner"><PlusIcon />{tx('whiteboard.wiki.addSection', 'Add section')}</span>
          </WidgetButton>
          <span className="wb-wiki-hint">{tx('whiteboard.wiki.reorderHint', 'Drag rows to reorder, or Alt+Up / Alt+Down.')}</span>
        </div>
      )}
    </div>
  );

  const emptyView = (
    <div className="wb-wiki-empty">
      <p className="wb-wiki-empty-title">{tx('whiteboard.wiki.empty', 'No pages yet.')}</p>
      {active ? (
        <WidgetButton onClick={() => setPicker({ section: null })}>
          <span className="wb-wiki-btn-inner"><PlusIcon />{tx('whiteboard.wiki.addFirstPage', 'Add a page')}</span>
        </WidgetButton>
      ) : (
        <p className="wb-wiki-empty-hint">
          {tx('whiteboard.wiki.emptyHint', 'Click the card, then add a knowledge page or a project file.')}
        </p>
      )}
    </div>
  );

  let body: ReactNode;
  if (empty && !showEditor) body = emptyView;
  else if (!wide || showEditor) body = listView;
  else {
    body = (
      <div className="wb-wiki-split">
        {listView}
        <WikiReader
          path={shown}
          tx={tx}
          titleOf={(path) => {
            const ref = pathToPageRef(path);
            const row = ref ? pages.find((p) => p.page.ref === ref) : undefined;
            if (row) return pageTitle(row.page);
            if (ref && pageTypeLabel(ref) === 'Knowledge') return titles.get(ref) ?? pageCardTitle(ref);
            return humanizeFileName(path);
          }}
          canBack={canGoBack(stack)}
          canForward={canGoForward(stack)}
          onBack={() => dispatch({ type: 'back' })}
          onForward={() => dispatch({ type: 'forward' })}
          onFollow={follow}
          onOpenInPanel={popup ? (path) => {
            const ref = pathToPageRef(path);
            if (ref) { popup.openPage({ kind: 'knowledge', ref }, elementId); return; }
            const owner = owningPage(path);
            if (owner?.page === 'tasks') popup.openPage({ kind: 'task', ref: owner.id }, elementId);
          } : undefined}
        />
      </div>
    );
  }

  // The key boundary wraps EVERYTHING the card draws, the frame's Edit / Done button included:
  // with focus on that button, Backspace would otherwise reach Excalidraw and delete the card.
  return (
    <div className="wb-wiki-keys" onKeyDown={onCardKey}>
      <WidgetFrame
        kind="wiki"
        title={cardTitle}
        active={active}
        size={size}
        actions={(
          <WidgetButton onClick={() => { setEditing((v) => !v); setPicker(null); setRenaming(null); setConfirming(null); }}>
            {editing ? tx('whiteboard.wiki.done', 'Done') : tx('whiteboard.wiki.edit', 'Edit')}
          </WidgetButton>
        )}
      >
        <div
          ref={rootRef}
          className={`wb-wiki${wide ? ' wb-wiki--wide' : ''}${showEditor ? ' wb-wiki--editing' : ''}`}
          data-wiki-layout={wide && !showEditor && !empty ? 'split' : 'list'}
        >
          {body}
          {picker && active && (
            <div className="wb-wiki-picker" role="dialog" aria-label={tx('whiteboard.wiki.addPage', 'Add page')}>
              <div className="wb-wiki-picker-head">
                <span className="wb-wiki-picker-title">
                  {picker.section
                    ? tx('whiteboard.wiki.addTo', 'Add to {section}').replace('{section}', list.sections.find((s) => s.id === picker.section)?.title ?? '')
                    : tx('whiteboard.wiki.addPage', 'Add page')}
                </span>
                <IconButton label={tx('whiteboard.popup.close', 'Close')} onClick={() => setPicker(null)}><CloseIcon size={14} /></IconButton>
              </div>
              <PagePicker
                onPick={(p) => pickPage(p.ref)}
                isDisabled={picker.section ? (ref) => sectionHasRef(list, picker.section as string, ref) : undefined}
              />
            </div>
          )}
        </div>
      </WidgetFrame>
    </div>
  );
}

/**
 * How many rows of a fully drawn list fit, read from the layout itself: each row's bottom edge
 * against the list's inner height, with room for the measuring "+N more" line and the list's
 * gap above it. Bounding boxes are divided by the canvas zoom (the box's scale against its
 * layout height), so the answer is the same at any zoom.
 */
function measureFit(list: HTMLElement): number {
  const box = list.getBoundingClientRect();
  const scale = list.offsetHeight > 0 && box.height > 0 ? box.height / list.offsetHeight : 1;
  const style = getComputedStyle(list);
  const top = box.top + list.clientTop * scale;
  const limit = list.clientHeight - (parseFloat(style.paddingBottom) || 0);
  const bottoms = Array.from(list.querySelectorAll<HTMLElement>('[data-wiki-fit="row"]'))
    .map((row) => (row.getBoundingClientRect().bottom - top) / scale);
  const more = list.querySelector<HTMLElement>('[data-wiki-measure]');
  // The line sits snug under the last row (a negative top margin takes back the list's gap).
  const moreHeight = more
    ? more.offsetHeight + (parseFloat(style.rowGap) || 0) + (parseFloat(getComputedStyle(more).marginTop) || 0)
    : 0;
  return fitWikiRows(bottoms, limit, moreHeight);
}

/** The L / XL reader: a slim header (back, forward, the page's title, open in the side panel)
 *  over the panel's page reader. */
function WikiReader({ path, tx, titleOf, canBack, canForward, onBack, onForward, onFollow, onOpenInPanel }: {
  path: string | null;
  tx: Tx;
  titleOf: (path: string) => string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onFollow: (next: string) => void;
  onOpenInPanel?: (path: string) => void;
}) {
  return (
    <div className="wb-wiki-reader" data-page-path={path ?? undefined}>
      <div className="wb-wiki-reader-head">
        <IconButton label={tx('whiteboard.popup.back', 'Back')} onClick={onBack} disabled={!canBack}><BackIcon size={14} /></IconButton>
        <IconButton label={tx('whiteboard.popup.forward', 'Forward')} onClick={onForward} disabled={!canForward}><ForwardIcon size={14} /></IconButton>
        <span className="wb-wiki-reader-title" title={path ? titleOf(path) : undefined}>{path ? titleOf(path) : ''}</span>
        {path && onOpenInPanel && (
          <IconButton label={tx('whiteboard.wiki.openInPanel', 'Open in side panel')} onClick={() => onOpenInPanel(path)}>
            <OpenInAppIcon size={14} />
          </IconButton>
        )}
      </div>
      <div className="wb-wiki-reader-body">
        {path && <DocumentReader key={path} path={path} onOpen={onFollow} embedded vaultReads hostFileActions variant="page" />}
      </div>
    </div>
  );
}

/** A section's heading in edit mode: drag grip, title (click to rename), add page, delete —
 *  or, while deleting, the inline confirm. */
function SectionEditRow({
  section, index, tx, renaming, confirming, dropHere, onRename, onRenameDone, onAskDelete, onDelete, onCancelDelete,
  onAddPage, onKeyDown, onDragStart, onDragEnd, onPageDragOver,
}: {
  section: WikiSection;
  index: number;
  tx: Tx;
  renaming: boolean;
  confirming: boolean;
  dropHere: boolean;
  onRename: () => void;
  onRenameDone: (title: string | null) => void;
  onAskDelete: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onAddPage: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onPageDragOver: (e: DragEvent) => void;
}) {
  if (confirming) {
    const n = section.pages.length;
    const question = n === 0
      ? tx('whiteboard.wiki.deleteEmpty', 'Delete “{title}”?')
      : n === 1
        ? tx('whiteboard.wiki.deleteOne', 'Delete “{title}” and its page?')
        : tx('whiteboard.wiki.deleteMany', 'Delete “{title}” and its {n} pages?').replace('{n}', String(n));
    return (
      <div className="wb-wiki-confirm" role="alertdialog" aria-label={question.replace('{title}', section.title)}>
        <span className="wb-wiki-confirm-text">{question.replace('{title}', section.title)}</span>
        <span className="wb-wiki-confirm-actions">
          <button type="button" className="wb-widget-btn wb-wiki-danger" autoFocus onClick={onDelete}>{tx('whiteboard.wiki.delete', 'Delete')}</button>
          <WidgetButton onClick={onCancelDelete}>{tx('whiteboard.wiki.cancel', 'Cancel')}</WidgetButton>
        </span>
      </div>
    );
  }
  return (
    <>
      <div
        className="wb-wiki-section-edit"
        draggable={!renaming || undefined}
        onDragStart={renaming ? undefined : onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onPageDragOver}
      >
        <span className="wb-wiki-grip" aria-hidden="true"><GripIcon /></span>
        {renaming ? (
          <RenameField initial={section.title} label={tx('whiteboard.wiki.sectionTitle', 'Section title')} onDone={onRenameDone} />
        ) : (
          <button
            type="button"
            className="wb-wiki-section-name"
            data-wiki-focus={`section:${section.id}`}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            title={`${section.title} · ${tx('whiteboard.wiki.renameHint', 'Rename. Drag, or press Alt+Up / Alt+Down, to move')}`}
            onClick={onRename}
            onKeyDown={onKeyDown}
            data-section-index={index}
          >
            {section.title}
          </button>
        )}
        <IconButton label={tx('whiteboard.wiki.addPageTo', 'Add page to this section')} onClick={onAddPage}><PlusIcon /></IconButton>
        <IconButton label={tx('whiteboard.wiki.deleteSection', 'Delete section')} onClick={onAskDelete}><TrashIcon /></IconButton>
      </div>
      {section.pages.length === 0 && (
        <p className={`wb-wiki-section-empty${dropHere ? ' is-drop-target' : ''}`} onDragOver={onPageDragOver}>
          {tx('whiteboard.wiki.sectionEmpty', 'No pages here yet.')}
        </p>
      )}
    </>
  );
}

/** A one-line title field: Enter or leaving it saves, Esc cancels (`null`). */
function RenameField({ initial, label, onDone }: { initial: string; label: string; onDone: (title: string | null) => void }) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      className="wb-input wb-wiki-rename"
      aria-label={label}
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(draft); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      }}
    />
  );
}

/** The card's own title, editable at the top of the list in edit mode. Enter or leaving the
 *  field saves; Esc reverts the draft and stays in the field (the section rename's rule: Esc
 *  never saves), handled here so the card stays active. */
function CardTitleField({ title, tx, onCommit }: { title: string; tx: Tx; onCommit: (title: string) => void }) {
  const [draft, setDraft] = useState(title);
  useEffect(() => { setDraft(title); }, [title]);
  const save = () => {
    const clean = draft.replace(/\s+/g, ' ').trim();
    if (clean && clean !== title) onCommit(clean);
    else setDraft(title);
  };
  return (
    <label className="wb-wiki-card-title">
      <span className="wb-wiki-card-title-label">{tx('whiteboard.wiki.cardTitle', 'Title')}</span>
      <input
        className="wb-input"
        value={draft}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(title); }
        }}
      />
    </label>
  );
}

function IconButton({ label, onClick, disabled, className, children }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`wb-wiki-icon${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

// The edit glyphs PanelIcons.tsx does not carry (add, delete, drag grip), drawn on the same
// 24×24 grid with the same stroke so they read as one set with the panel's.
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} {...STROKE} aria-hidden="true" focusable="false">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} {...STROKE} aria-hidden="true" focusable="false">
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="9" cy="6.5" r="1.4" />
      <circle cx="15" cy="6.5" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="17.5" r="1.4" />
      <circle cx="15" cy="17.5" r="1.4" />
    </svg>
  );
}
