import { useState, useEffect } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { useSleep, getSleepLevel, getSleepLevelKey } from '../../hooks/useSleep';
import './Header.css';

const ZOOM_LEVELS = [0.85, 0.9, 1.0, 1.1, 1.2];
const ZOOM_STORAGE_KEY = 'dreamcontext-zoom';

function getStoredZoom(): number {
  try {
    const stored = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (stored !== null) {
      const val = parseFloat(stored);
      if (ZOOM_LEVELS.includes(val)) return val;
    }
  } catch { /* ignore */ }
  return 1.0;
}

function applyZoom(zoom: number) {
  document.documentElement.style.setProperty('--zoom', String(zoom));
}

export function Header() {
  const { theme, setTheme, resolved } = useTheme();
  const { data: sleep } = useSleep();
  const [zoom, setZoom] = useState(getStoredZoom);

  useEffect(() => {
    applyZoom(zoom);
  }, [zoom]);

  const debt = sleep?.debt ?? 0;
  const level = getSleepLevel(debt);
  const levelKey = getSleepLevelKey(debt);

  const cycleTheme = () => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
  };

  const themeLabel = theme === 'system' ? `System (${resolved})` : resolved === 'dark' ? 'Dark' : 'Light';

  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const canZoomOut = zoomIndex > 0;
  const canZoomIn = zoomIndex < ZOOM_LEVELS.length - 1;

  const changeZoom = (delta: -1 | 1) => {
    const nextIndex = zoomIndex + delta;
    if (nextIndex < 0 || nextIndex >= ZOOM_LEVELS.length) return;
    const next = ZOOM_LEVELS[nextIndex];
    setZoom(next);
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(next)); } catch { /* ignore */ }
  };

  return (
    <header className="header">
      <div className="header-left">
        <div className={`agent-avatar agent-avatar--${levelKey}`}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M14 2L24 14L14 26L4 14L14 2Z" fill="url(#diamond-gradient)" opacity={levelKey === 'must_sleep' ? 0.4 : levelKey === 'sleepy' ? 0.6 : levelKey === 'drowsy' ? 0.8 : 1} />
            <path d="M14 8L19 14L14 20L9 14L14 8Z" fill="url(#diamond-inner)" opacity={levelKey === 'must_sleep' ? 0.3 : 0.7} />
            <defs>
              <linearGradient id="diamond-gradient" x1="4" y1="2" x2="24" y2="26" gradientUnits="userSpaceOnUse">
                <stop stopColor="hsl(287, 100%, 33%)" />
                <stop offset="1" stopColor="hsl(311, 97%, 43%)" />
              </linearGradient>
              <linearGradient id="diamond-inner" x1="9" y1="8" x2="19" y2="20" gradientUnits="userSpaceOnUse">
                <stop stopColor="hsl(276, 74%, 50%)" />
                <stop offset="1" stopColor="hsl(287, 100%, 45%)" />
              </linearGradient>
            </defs>
          </svg>
          {levelKey === 'must_sleep' && <span className="zzz">zzz</span>}
        </div>
        <div className="header-brand">
          <span className="brand-name">dreamcontext</span>
          <span className={`sleep-badge sleep-badge--${levelKey}`}>
            {level} ({debt})
          </span>
        </div>
      </div>
      <div className="header-right">
        <div className="zoom-controls">
          <button
            className="zoom-btn"
            onClick={() => changeZoom(-1)}
            disabled={!canZoomOut}
            title="Zoom out"
          >-</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button
            className="zoom-btn"
            onClick={() => changeZoom(1)}
            disabled={!canZoomIn}
            title="Zoom in"
          >+</button>
        </div>
        <button className="theme-toggle" onClick={cycleTheme} title={`Theme: ${themeLabel}`}>
          {resolved === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 1zm0 10a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 11zm7-3a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 15 8zM5 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 5 8zm7.07-4.07a.5.5 0 0 1 0 .71l-1.41 1.41a.5.5 0 1 1-.71-.71l1.41-1.41a.5.5 0 0 1 .71 0zM6.05 10.66a.5.5 0 0 1 0 .71l-1.41 1.41a.5.5 0 0 1-.71-.71l1.41-1.41a.5.5 0 0 1 .71 0zm7.72 3.12a.5.5 0 0 1-.71 0l-1.41-1.41a.5.5 0 1 1 .71-.71l1.41 1.41a.5.5 0 0 1 0 .71zM5.34 6.05a.5.5 0 0 1-.71 0L3.22 4.64a.5.5 0 0 1 .71-.71l1.41 1.41a.5.5 0 0 1 0 .71zM8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}
