import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';

type Theme = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? getSystemTheme() : theme;
}

export function ThemeProvider({ children, forced }: { children: ReactNode; /** An app's frame: its own theme, never the app-global file's, never written to it. */ forced?: Theme }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (forced) return forced;
    const stored = localStorage.getItem('dreamcontext-theme') as Theme | null;
    return stored || 'system';
  });

  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(theme));

  const setTheme = (newTheme: Theme) => {
    if (forced) return;
    setThemeState(newTheme);
    localStorage.setItem('dreamcontext-theme', newTheme);
    // App-global too: the desktop app opens on a fresh port (an empty localStorage) every launch,
    // and dreamcontext App windows follow this file (src/server/routes/launcher.ts).
    void api.post('/launcher/ui-settings', { theme: newTheme }).catch(() => { /* a server without it */ });
  };

  // Hydrate from the app-global file, only when it holds a theme (a fresh origin has none).
  useEffect(() => {
    if (forced) return undefined;
    let live = true;
    api.get<{ theme?: unknown }>('/launcher/ui-settings').then((raw) => {
      const t = raw?.theme;
      if (live && (t === 'light' || t === 'dark' || t === 'system')) {
        setThemeState(t);
        localStorage.setItem('dreamcontext-theme', t);
      }
    }).catch(() => { /* offline or an older server */ });
    return () => { live = false; };
  }, [forced]);

  useEffect(() => {
    const r = resolveTheme(theme);
    setResolved(r);
    document.documentElement.setAttribute('data-theme', r);
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const r = getSystemTheme();
      setResolved(r);
      document.documentElement.setAttribute('data-theme', r);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
