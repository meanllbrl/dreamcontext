import { emitInstance } from '../../../context/VaultContext';

/**
 * An agenda line's press filters the Super chat (owner 2026-11-17, his last word: "tıklar
 * tıklamaz filtreleyelim"); Ask on the row writes about it without filtering, and the filter
 * strip's line name opens the line's detail. This is that door: the strip asks, the agenda card
 * holding the row opens its detail. It travels on the project's own bus (`useVaultId().bus`),
 * never on `window`: one window holds several projects, and row keys repeat across them.
 */
export const OPEN_ROW_DETAIL = 'dc:agenda-open-detail';

export function requestRowDetail(bus: EventTarget, rowKey: string): void {
  emitInstance(bus, OPEN_ROW_DETAIL, rowKey);
}
