import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';

interface HealthResponse {
  ok: boolean;
  contextRoot: string;
}

interface ProjectContextValue {
  projectId: string;
  contextRoot: string;
}

const ProjectContext = createContext<ProjectContextValue>({
  projectId: '',
  contextRoot: '',
});

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; value: ProjectContextValue };

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    api.get<HealthResponse>('/health').then((data) => {
      setState({
        kind: 'ready',
        value: {
          contextRoot: data.contextRoot,
          projectId: hashString(data.contextRoot),
        },
      });
    }).catch(() => {
      // Fallback: no project scoping (still render the app)
      setState({ kind: 'ready', value: { projectId: '', contextRoot: '' } });
    });
  }, []);

  if (state.kind === 'loading') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: 'var(--color-text-secondary, #888)',
          fontSize: '14px',
        }}
      >
        Loading project…
      </div>
    );
  }

  return (
    <ProjectContext.Provider value={state.value}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  return useContext(ProjectContext);
}
