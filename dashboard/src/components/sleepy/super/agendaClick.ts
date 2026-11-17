/**
 * What a press on an agenda line does, while the owner chooses between two drawings (2026-11-17,
 * "tıklayıp detaya gitsin"): `filter` (A) filters the Super chat and the strip's line name opens
 * the line's detail; `detail` (B) opens the detail, whose "Show in chat" filters. One is removed
 * once he picks. Kept on this Mac (`dc.agenda.click`); A by default, as today.
 */
export type AgendaClick = 'filter' | 'detail';

const KEY = 'dc.agenda.click';

export function agendaClick(): AgendaClick {
  try { return localStorage.getItem(KEY) === 'detail' ? 'detail' : 'filter'; } catch { return 'filter'; }
}

/** The strip's line name was pressed (A): the agenda card holding that row opens its detail. */
export const OPEN_ROW_DETAIL = 'dc:agenda-open-detail';

export function requestRowDetail(rowKey: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_ROW_DETAIL, { detail: rowKey }));
}
