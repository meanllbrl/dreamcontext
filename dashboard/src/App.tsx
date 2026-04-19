import { Component, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import type { Page } from './components/layout/Sidebar';
import './styles/global.css';

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
      return <CorePage />;
    case 'knowledge':
      return <KnowledgePage />;
    case 'features':
      return <FeaturesPage />;
    case 'council':
      return <CouncilPage />;
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

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ProjectProvider>
          <ThemeProvider>
            <I18nProvider>
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
