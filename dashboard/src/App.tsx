import { Component, useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api, setActiveVault } from './api/client';
import { LauncherPage } from './pages/LauncherPage';
import { CaptureBar } from './pages/CaptureBar';
import { SleepyPerch } from './components/sleepy/SleepyPerch';
import { applySleepyHotkey, readSleepyConfig, initSleepyFromServer, SLEEPY_CONFIG_KEY } from './lib/sleepy';
import { ThemeProvider } from './context/ThemeContext';
import { I18nProvider } from './context/I18nContext';
import { ProjectProvider } from './context/ProjectContext';
import { Shell, type ShellNavigation } from './components/layout/Shell';
import { AgentSurface } from './components/sleepy/AgentSurface';
import { TasksPage } from './pages/TasksPage';
import { RoadmapPage } from './pages/RoadmapPage';
import { SleepPage } from './pages/SleepPage';
import { CorePage } from './pages/CorePage';
import { KnowledgePage } from './pages/KnowledgePage';
import { FeaturesPage } from './pages/FeaturesPage';
import { BrainPage, type BrainNavigatePage } from './pages/BrainPage';
import { CouncilPage } from './pages/CouncilPage';
import { SettingsPage } from './pages/SettingsPage';
import { PacksPage } from './pages/PacksPage';
import { AboutPage } from './pages/AboutPage';
import { TaxonomyPage } from './pages/TaxonomyPage';
import type { Page } from './components/layout/Sidebar';
import './styles/global.css';

/** Required server capabilities for THIS bundle (see server/routes/health.ts). */
const REQUIRED_CAPABILITIES = ['tasks.members', 'tasks.delete', 'tasks.sync'];

function StaleServerBanner() {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<{ ok: boolean; capabilities?: string[] }>('/health'),
    staleTime: 60_000,
    retry: 1,
  });
  if (!data) return null;
  const caps = data.capabilities ?? [];
  const missing = REQUIRED_CAPABILITIES.filter(c => !caps.includes(c));
  if (missing.length === 0) return null;
  return (
    <div className="stale-server-banner">
      ⚠ The dashboard server is running an older build — some actions will fail.
      Restart it: <code>dreamcontext dashboard</code>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
      refetchOnWindowFocus: true,
      // Live-update while the app stays open (sleep debt, tasks, knowledge all
      // go stale as the agent works). Polls only when the tab is visible, and
      // react-query's structural sharing skips re-renders when nothing changed,
      // so this is cheap against the local server. The Header also exposes a
      // manual refresh button for an immediate pull.
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

function PageRouter({ nav }: { nav: ShellNavigation }) {
  const handleBrainNavigate = (target: BrainNavigatePage, nodeId: string) => {
    const pageMap: Record<BrainNavigatePage, Page> = {
      tasks: 'tasks',
      features: 'features',
      knowledge: 'knowledge',
      core: 'core',
    };
    nav.navigate(pageMap[target], nodeId);
  };

  // A navigation focus target (set by the ⌘K palette and the Brain map). The
  // `nonce` bumps on every navigate() so destination pages re-open the item even
  // when it's the same page or the same id. Without this, pages render their
  // default state and the navigated-to doc never opens.
  const focus = { id: nav.focusId, nonce: nav.nonce };

  switch (nav.page) {
    case 'brain':
      return <BrainPage onNavigate={handleBrainNavigate} />;
    case 'tasks':
      return <TasksPage focus={focus} />;
    case 'roadmap':
      return <RoadmapPage />;
    case 'sleep':
      return <SleepPage />;
    case 'core':
      return <CorePage onNavigateTaxonomy={() => nav.navigate('taxonomy', null)} focus={focus} />;
    case 'knowledge':
      return <KnowledgePage focus={focus} />;
    case 'features':
      return <FeaturesPage focus={focus} />;
    case 'council':
      return <CouncilPage />;
    case 'settings':
      return <SettingsPage />;
    case 'packs':
      return <PacksPage />;
    case 'taxonomy':
      return <TaxonomyPage />;
    case 'about':
      return <AboutPage />;
  }
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h1>Something went wrong.</h1>
          <p>{this.state.error.message}</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Read the `?vault=` URL param ONCE at module load and pin it as the active
 * vault before any query fires. Absent → launcher mode (render LauncherPage);
 * present → the normal vault Shell with every request carrying the vault header.
 */
const params = new URLSearchParams(window.location.search);
const initialVault = params.get('vault');
const captureMode = params.get('capture') === '1';
const perchMode = params.get('perch') === '1';
if (initialVault) {
  setActiveVault(initialVault);
}

/**
 * Owns the Sleepy global hotkey from the persistent launcher window. Registers on
 * mount and re-registers whenever the config changes in ANOTHER window (Settings
 * lives in a vault window) via the cross-window `storage` event — so the hotkey
 * survives opening/closing vault windows.
 */
function SleepyHotkeyRegistrar() {
  useEffect(() => {
    // Seed from the server-persisted config (localStorage is empty on each
    // launch's fresh port/origin), then register the hotkey.
    void initSleepyFromServer().then((cfg) => applySleepyHotkey(cfg));
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === SLEEPY_CONFIG_KEY) {
        void applySleepyHotkey(readSleepyConfig());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return null;
}

export function App() {
  // Notch quick-capture window (`?capture=1`) — its own transparent bar.
  if (captureMode) {
    return (
      <ErrorBoundary>
        <CaptureBar />
      </ErrorBoundary>
    );
  }

  // The always-on left-of-notch companion (`?perch=1`) — just the mascot.
  if (perchMode) {
    return (
      <ErrorBoundary>
        <SleepyPerch />
      </ErrorBoundary>
    );
  }

  // No vault pinned → this is the Launcher window (list of all projects).
  if (!initialVault) {
    return (
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <SleepyHotkeyRegistrar />
            <LauncherPage />
          </ThemeProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ProjectProvider>
          <ThemeProvider>
            <I18nProvider>
              <StaleServerBanner />
              <Shell>
                {(nav) => <PageRouter nav={nav} />}
              </Shell>
              {/* Mounted ONCE, outside the page switch: the global Agent floater (a
                  bottom-right FAB that expands to a fullscreen overlay) keeps its
                  PTY/scrollback alive across navigation and collapse/expand. */}
              <AgentSurface />
            </I18nProvider>
          </ThemeProvider>
        </ProjectProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
