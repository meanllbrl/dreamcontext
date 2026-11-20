/**
 * The v3 Dock at the stage's foot (plan super-v3 D1, D11, K2): Today, the jobs waiting on the
 * owner, the AI Team members, the running jobs, minimized cards and the Pool, in one row. Every
 * rect comes from `planStage`'s `jobDock` (never re-measured here). A tile is a door: a job opens
 * as the session window beside the Super, a mini comes back to the stage, Today opens the agenda.
 *
 * Named StageDock: `SuperDock` is the off-page Super pill (a different component).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { DockTile, JobDock, Rect } from './superLayout';
import './StageDock.css';

export type DockTone = 'working' | 'asking' | 'idle' | 'stuck';

/** What one tile shows (SuperSurface reads it from the record and the live sessions). */
export interface DockTileView {
  title: string;
  tone?: DockTone;
  /** One line under the title: "Needs you", the job's last action, a member's field. */
  line?: string;
  /** How many things it waits on the owner for (the pink badge). */
  badge?: number;
  /** A member's face: its initial (the Telegram/phone form of the 34 px face). */
  face?: string;
  /** A minimized card's thumbnail. */
  thumb?: ReactNode;
}

const ring = (tone: DockTone | undefined, size: number) => {
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const arc = tone === 'asking' || tone === 'stuck' ? c : c * 0.28;
  return (
    <svg className="sdock-ring" data-tone={tone ?? 'idle'} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="tr" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} />
      <circle className="fg" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${arc} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
};

const at = (r: Rect, dock: Rect) => ({ left: r.x - dock.x, top: r.y - dock.y, width: r.width, height: r.height });

export function StageDock({ dock, viewOf, onOpen, todayLine, pool, cap }: {
  dock: JobDock;
  viewOf: (tile: DockTile) => DockTileView;
  onOpen: (tile: DockTile) => void;
  /** The Today tile's line ("1 needs you", "Running 7 · in the Dock"). */
  todayLine: string;
  pool: number;
  cap?: string;
}) {
  const { t } = useI18n();
  const rowRef = useRef<HTMLDivElement | null>(null);
  // A row that scrolls (K2 step 3) rests at its start: the needs-you tiles are what show.
  const scrolls = dock.scrollFrom !== null;
  useEffect(() => { if (!scrolls && rowRef.current) rowRef.current.scrollLeft = 0; }, [scrolls]);
  const full = dock.tiles.length ? dock.tiles[dock.tiles.length - 1].rect.x + dock.tiles[dock.tiles.length - 1].rect.width - dock.rect.x + 9 : dock.rect.width;
  return (
    <div
      className="sdock"
      data-testid="super-dock"
      data-docked={dock.docked ? 'true' : undefined}
      data-scrolls={scrolls ? 'true' : undefined}
      role="toolbar"
      aria-label={t('superDock.label')}
      style={{ left: dock.rect.x, top: dock.rect.y, width: dock.rect.width, height: dock.rect.height }}
    >
      <div className="sdock-row" ref={rowRef}>
        <div className="sdock-inner" style={{ width: Math.max(full, dock.rect.width - 2), height: dock.rect.height - 2 }}>
          {dock.seps.map((s, i) => <span key={`sep-${i}`} className="sdock-sep" style={at(s, dock.rect)} aria-hidden />)}
          {dock.tiles.map((tile) => {
            const v = tile.kind === 'pool' ? { title: t('superDock.pool').replace('{n}', String(pool)) } as DockTileView
              : tile.kind === 'today' ? { title: t('superDock.today'), line: todayLine } as DockTileView
              : viewOf(tile);
            const label = tile.kind === 'needs' ? `${v.title}, ${t('superDock.needsYou')}` : v.title;
            return (
              <button
                key={`${tile.kind}:${tile.id}`}
                type="button"
                className="sdock-tile"
                data-kind={tile.kind}
                data-compact={tile.compact ? 'true' : undefined}
                data-tone={v.tone}
                data-testid={`super-dock-${tile.kind}`}
                data-tile={tile.id}
                title={v.title}
                aria-label={label}
                style={at(tile.rect, dock.rect)}
                onClick={() => onOpen(tile)}
              >
                {!!v.badge && <span className="sdock-badge">{v.badge}</span>}
                {tile.kind === 'mini' ? (
                  <span className="sdock-thumb">{v.thumb ?? <span className="sdock-thumb-title">{v.title}</span>}</span>
                ) : tile.kind === 'member' ? (
                  <>
                    <span className="sdock-face" data-tone={v.tone ?? 'idle'} aria-hidden>{v.face ?? v.title.slice(0, 1).toUpperCase()}</span>
                    <span className="sdock-ti">{v.title}</span>
                    {v.line && <span className="sdock-ln">{v.line}</span>}
                  </>
                ) : tile.kind === 'pool' ? (
                  <>
                    <span className="sdock-ti">{v.title}</span>
                    {cap && <span className="sdock-ln sdock-cap" data-testid="super-dock-cap">{cap}</span>}
                  </>
                ) : tile.compact ? (
                  <>
                    {tile.kind !== 'today' && ring(v.tone, 22)}
                    <span className="sdock-ti sdock-two">{v.title}</span>
                  </>
                ) : (
                  <>
                    <span className="sdock-head">
                      {tile.kind !== 'today' && ring(v.tone, 18)}
                      <span className={tile.kind === 'today' ? 'sdock-ti' : 'sdock-ti sdock-two'}>{v.title}</span>
                    </span>
                    {tile.kind === 'needs' ? <span className="sdock-ln sdock-wait">{t('superDock.needsYou')}</span>
                      : v.line ? <span className="sdock-ln">{v.line}</span> : null}
                    {tile.kind === 'job' && v.tone === 'working' && <span className="sdock-walk" aria-hidden><i /></span>}
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
