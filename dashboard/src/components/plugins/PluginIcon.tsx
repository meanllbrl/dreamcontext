import type { CSSProperties, ReactElement } from 'react';
import { PLUGIN_LOOK, type PluginId } from '../../lib/plugins';
import './plugins.css';

/** A plugin's tile: the app-icon gradient style with a white glyph (Mağaza D1, approved list). */
export function PluginIcon({ id, size }: { id: PluginId; size: number }) {
  const look = PLUGIN_LOOK[id];
  const style = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.24),
    backgroundImage: `linear-gradient(160deg, ${look.from}, ${look.to})`,
  } as CSSProperties;
  const g = Math.round(size * 0.52);
  return (
    <span className="plg-ic" style={style} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={g} height={g} fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {GLYPH[id]}
      </svg>
    </span>
  );
}

const GLYPH: Record<PluginId, ReactElement> = {
  roadmap: <><path d="M4 17l5-5 4 3 7-7" /><path d="M4 20h16" /></>,
  hypotheses: <><path d="M9.5 3h5" /><path d="M10.5 3v6.2L5.6 18.1A2 2 0 0 0 7.4 21h9.2a2 2 0 0 0 1.8-2.9l-4.9-8.9V3" /><path d="M8 15h8" /></>,
  lab: <><path d="M5 20V10" /><path d="M10 20V5" /><path d="M15 20v-7" /><path d="M20 20V8" /></>,
  council: <><circle cx="12" cy="6" r="2.5" /><circle cx="5.5" cy="17" r="2.5" /><circle cx="18.5" cy="17" r="2.5" /><path d="M10.7 8.2 7 14.8M13.3 8.2 17 14.8M8 17h8" /></>,
  marketing: <><path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" /></>,
};
