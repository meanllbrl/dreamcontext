import { Component, useEffect, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createInstanceQueryClient } from './lib/instanceQueryClient';
import { LauncherPage } from './pages/LauncherPage';
import { CaptureBar } from './pages/CaptureBar';
import { SleepyPerch } from './components/sleepy/SleepyPerch';
import { applySleepyHotkey, readSleepyConfig, initSleepyFromServer, SLEEPY_CONFIG_KEY } from './lib/sleepy';
import { ThemeProvider } from './context/ThemeContext';
import { I18nProvider } from './context/I18nContext';
import { UpgradeRelaunchBanner } from './components/layout/UpgradeRelaunchBanner';
import { ProjectSwitcher } from './components/search/ProjectSwitcher';
import { WindowChrome } from './components/layout/WindowChrome';
import { ChecklistWindow } from './components/checklist/ChecklistWindow';
import { MeetingRoom } from './components/meeting/MeetingRoom';
import './styles/global.css';

/**
 * The window-level query cache: the launcher's project list, the server version handshake,
 * the upgrade banner. All of it is per-SERVER or per-machine, never per-vault, so it is the
 * one cache a window can share. Each open project gets its OWN client inside its
 * `ProjectInstance` — see `lib/instanceQueryClient.ts` for why that separation matters.
 *
 * One client for both branches below because they are mutually exclusive: a window is either
 * the launcher or a vault window, never both.
 */
const windowQueryClient = createInstanceQueryClient();

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
 * Read the `?vault=` URL param ONCE at module load. Absent → launcher mode (render
 * LauncherPage); present → the window's FIRST CHIP.
 *
 * It no longer pins anything globally. A window used to be one project, so the vault could be
 * a module-level fact that every request read back out of the API client; now a window holds
 * several live projects at once and that global would be shared state between unrelated ones.
 * The vault travels down the tree per instance instead (`VaultProvider` → `useApi()`), and
 * this param only decides which project the window opens WITH.
 */
const params = new URLSearchParams(window.location.search);
const initialVault = params.get('vault');
const captureMode = params.get('capture') === '1';
const perchMode = params.get('perch') === '1';
const checklistId = params.get('checklist');
const meetingMode = params.get('meeting') === '1';

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

  // The pinned checklist window (`?checklist=<id>`) — a separate, narrow-capability OS
  // window (plan §1.9). `ThemeProvider` is mandatory here, not decorative: it is what writes
  // `data-theme` onto <html>, which the whole dark palette (and `MarkdownPreview`, which
  // renders item text) is keyed off. This window makes zero API calls and never pins an
  // active vault — `vault` is read straight off the URL and passed through as a plain prop.
  if (checklistId) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <ChecklistWindow id={checklistId} vault={params.get('vault')} />
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  /*
   * The Meeting Room window (`?meeting=1`) — the machine-wide all-agents thread, which used to
   * be a modal over the launcher.
   *
   * NO `VaultProvider`, and that absence is the design rather than an omission: the room is
   * owned by no project (its store is `~/.dreamcontext/meeting-room/`, its routes are
   * vault-agnostic), so `useVault()` resolves to `DEFAULT_VAULT_CONTEXT` — `vault: null` — and
   * every surface it mounts reads that correctly. It is what makes the shared composer drop
   * its Attach control (no project temp dir to upload a pasted image into) and skip the
   * per-vault peer fetch in favour of the roster the room supplies.
   *
   * `QueryClientProvider` IS required: the composer's model/effort menu and its usage popover
   * are react-query reads (`/api/agent/model-config`, `/api/agent/usage-limits`), and both of
   * those routes are vault-agnostic, so they answer for a window with no project.
   */
  if (meetingMode) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <QueryClientProvider client={windowQueryClient}>
            <I18nProvider>
              <MeetingRoom />
            </I18nProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  // No vault pinned → this is the Launcher window (list of all projects).
  if (!initialVault) {
    return (
      <ErrorBoundary>
        <QueryClientProvider client={windowQueryClient}>
          <ThemeProvider>
            <I18nProvider>
              <UpgradeRelaunchBanner />
              <SleepyHotkeyRegistrar />
              <LauncherPage />
              <ProjectSwitcher />
            </I18nProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    );
  }

  /*
   * A vault window. Everything that used to be rendered here directly — Shell, the page
   * router, the agent surface — now belongs to a ProjectInstance, and this window may hold
   * more than one of them. `WindowChrome` owns the chip strip and mounts them.
   *
   * Theme and locale sit ABOVE the chrome because they are properties of the window, not of
   * any project in it: `ThemeProvider` writes `data-theme` onto <html> (one document, one
   * palette), and the chrome's own `UpgradeRelaunchBanner` reads translations, so it needs a
   * locale in scope before any instance exists.
   */
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={windowQueryClient}>
          <I18nProvider>
            <WindowChrome initialVault={initialVault} />
          </I18nProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
