import { useEffect, useState } from 'react';
import { api, setActiveVault } from '../../api/client';
import { isDesktop } from '../../lib/desktop';
import { SleepyMascot, type SleepyMood } from './SleepyMascot';
import './SleepyPerch.css';

function moodForDebt(d: number): SleepyMood {
  if (d >= 10) return 'sleeps';
  if (d >= 8) return 'sleepy';
  return 'idle';
}

/**
 * The always-on companion that lives just left of the physical notch when the
 * capture panel is closed. A small, animated Sleepy whose mood reflects sleep
 * debt; clicking it summons the full notch panel. Rendered in its own tiny
 * transparent NSPanel (see lib.rs) and hidden while the full panel is open.
 */
export function SleepyPerch() {
  const [mood, setMood] = useState<SleepyMood>('idle');

  // Transparent page so only the mascot paints.
  useEffect(() => {
    const html = document.documentElement;
    html.style.background = 'transparent';
    document.body.style.background = 'transparent';
  }, []);

  // Reflect the first live project's sleep debt in the mascot's mood.
  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ vaults: { name: string; exists?: boolean }[] }>('/vaults')
      .then((d) => {
        const v = d.vaults.find((x) => x.exists !== false) ?? d.vaults[0];
        if (!v) return undefined;
        setActiveVault(v.name);
        return api.get<{ debt?: number }>('/sleep');
      })
      .then((s) => {
        if (s && !cancelled) setMood(moodForDebt(typeof s.debt === 'number' ? s.debt : 0));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function open() {
    if (!isDesktop()) return;
    try {
      const { emit } = await import('@tauri-apps/api/event');
      await emit('sleepy:toggle');
    } catch {
      /* best-effort */
    }
  }

  return (
    <div className="perch-root" onClick={() => void open()} title="Open Sleepy">
      <SleepyMascot mood={mood} size={40} compact />
    </div>
  );
}
