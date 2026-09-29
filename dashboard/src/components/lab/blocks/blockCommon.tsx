import { useEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { Block, BlockProps, EmptyReason, Frame, FrameKind } from '../board/boardTypes';

/** What every registry component receives: the block itself plus its BlockProps. */
export type BlockViewProps = BlockProps & { block: Block };

const EMPTY_KEYS: Record<EmptyReason, string> = {
  'no-cache': 'lab.blocks.empty.noCache',
  'missing-insight': 'lab.blocks.empty.missingInsight',
  'missing-dataset': 'lab.blocks.empty.missingDataset',
  'kind-mismatch': 'lab.blocks.empty.kindMismatch',
  'unsafe-ref': 'lab.blocks.empty.unsafeRef',
};

/** The one "nothing to draw" state every block shares, worded by why. */
export function BlockEmpty({ reason, message }: { reason?: EmptyReason | null; message?: string }) {
  const { t } = useI18n();
  const text = message ?? t(reason ? EMPTY_KEYS[reason] : 'lab.blocks.empty.noData');
  return <div className="lab-block-empty" data-empty-reason={reason ?? 'no-data'}>{text}</div>;
}

/**
 * The frame a data block may draw, or the empty state it must show instead:
 * no frame, an `empty` frame (its reason), or a kind the block does not take.
 */
export function drawableFrame<K extends FrameKind>(
  frame: Frame | null,
  accepts: readonly K[],
): { frame: Extract<Frame, { kind: K }> } | { empty: EmptyReason | null } {
  if (!frame) return { empty: null };
  if (frame.kind === 'empty') return { empty: frame.reason };
  if (!(accepts as readonly string[]).includes(frame.kind)) return { empty: 'kind-mismatch' };
  return { frame: frame as Extract<Frame, { kind: K }> };
}

/** A numeric option within bounds, else the fallback. */
export function numberOption(options: Record<string, unknown>, key: string, fallback: number, min = -Infinity, max = Infinity): number {
  const v = options[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

export function boolOption(options: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = options[key];
  return typeof v === 'boolean' ? v : fallback;
}

export function stringOption(options: Record<string, unknown>, key: string): string | null {
  const v = options[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function stringListOption(options: Record<string, unknown>, key: string): string[] | null {
  const v = options[key];
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(v)) return null;
  const out = v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  return out.length > 0 ? out : null;
}

/** The measured size of a block's drawing area (charts take pixel heights; the cell decides them). */
export function useBlockSize<T extends HTMLElement = HTMLDivElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((prev) => (Math.round(prev.width) === Math.round(width) && Math.round(prev.height) === Math.round(height)
        ? prev
        : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/** A chart height that fills the measured area, within sane bounds; the default before the first measure. */
export function fillHeight(measured: number, fallback: number, reserve = 0, min = 80): number {
  return measured > 0 ? Math.max(min, Math.floor(measured - reserve)) : fallback;
}
