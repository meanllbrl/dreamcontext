import { Component, useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api, setActiveVault } from './api/client';
import { LauncherPage } from './pages/LauncherPage';
import { CaptureBar } from './pages/CaptureBar';
import { applySleepyHotkey, readSleepyConfig } from './lib/sleepy';
import { ThemeProvider } from './context/ThemeContext';
import { I18nProvider } from './context/I18nContext';
import { ProjectProvider } from './context/ProjectContext';
import { Shell, type ShellNavigation } from './components/layout/Shell';
import { TasksPage } from './pages/TasksPage';
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

  switch (nav.page) {
    case 'brain':
      return <BrainPage onNavigate={handleBrainNavigate} />;
    case 'tasks':
      return <TasksPage />;
    case 'sleep':
      return <SleepPage />;
    case 'core':
      return <CorePage onNavigateTaxonomy={() => nav.navigate('taxonomy', null)} />;
    case 'knowledge':
      return <KnowledgePage />;
    case 'features':
      return <FeaturesPage />;
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
if (initialVault) {
  setActiveVault(initialVault);
}

/** Registers the Sleepy global hotkey for the launcher window (no UI). */
function SleepyHotkeyRegistrar() {
  useEffect(() => {
    void applySleepyHotkey(readSleepyConfig());
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
            </I18nProvider>
          </ThemeProvider>
        </ProjectProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
