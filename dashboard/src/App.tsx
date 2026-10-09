import { Component, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createInstanceQueryClient } from './lib/instanceQueryClient';
import { LauncherPage } from './pages/LauncherPage';
import { ThemeProvider } from './context/ThemeContext';
import { I18nProvider } from './context/I18nContext';
import { UpgradeRelaunchBanner } from './components/layout/UpgradeRelaunchBanner';
import { HandsfreeBanner } from './components/handsfree/HandsfreeBanner';
import { ProjectSwitcher } from './components/search/ProjectSwitcher';
import { WindowChrome } from './components/layout/WindowChrome';
import { ChecklistWindow } from './components/checklist/ChecklistWindow';
import { Notch, ASSISTANT_VAULT } from './components/assistant/Notch';
import { VaultProvider } from './context/VaultContext';
import { ViewerWindow } from './components/appLink/ViewerWindow';
import { InboxWindow } from './components/appLink/InboxWindow';
import type { StartIntent } from './lib/desktop';
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
const checklistId = params.get('checklist');
const assistantMode = params.get('assistant') === '1';
/** `?viewer=<project-relative path>&vault=<v>`: the small document window (`openViewerWindow`). */
const viewerPath = params.get('viewer');
/** `?inbox=1`: the Notifications window (`openInboxWindow`). */
const inboxMode = params.get('inbox') === '1';
/**
 * `&open=<dreamcontext:// link>`: the link this project window was built to land. Read once and
 * then taken OFF the URL, so a reload of the window does not land the same link again.
 */
const initialLink = params.get('open');
if (initialLink !== null) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('open');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch (err) {
    console.warn('[app-link] could not clear the landed link from the URL:', err);
  }
}
/**
 * `&start=initializer`: the onboarding hand-off asked this NEW window to start a chat (only
 * `openVaultWindow` writes it). Read once, taken off the URL like `open` so a reload starts
 * nothing, and narrowed to the closed set: any other value is dropped.
 */
const initialStart: StartIntent | null = params.get('start') === 'initializer' ? 'initializer' : null;
if (params.has('start')) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('start');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch (err) {
    console.warn('[start-intent] could not clear the start intent from the URL:', err);
  }
}
/** The viewer's own bus: a lone window with no chips and no siblings. */
const viewerBus = new EventTarget();
/** The notch's one project instance has no chip strip and no siblings — its bus is its own. */
const assistantBus = new EventTarget();

export function App() {
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
   * The dreamcontext Assistant's notch (`?assistant=1`, window label `assistant`) — a panel at
   * the top of the screen, opened by the Rust shell (desktop/src-tauri/src/assistant.rs).
   *
   * ONE `VaultProvider`, pinned to the HIDDEN vault `__assistant__`: the reused ChatPane makes
   * the same per-vault REST calls as in any project (history, attachments, file previews,
   * voice), and the server resolves `__assistant__` for loopback desktop callers only. It is
   * never a chip, never in the Launcher, never in `vaults.json`.
   */
  if (assistantMode) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <QueryClientProvider client={windowQueryClient}>
            <I18nProvider>
              <VaultProvider vault={ASSISTANT_VAULT} instanceId="assistant" isActive bus={assistantBus}>
                <Notch />
              </VaultProvider>
            </I18nProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  /*
   * The document viewer (`?viewer=`, window label `viewer-<hash>`): one file, formatted. Under a
   * `VaultProvider` for its vault because the file routes it reads are vault-scoped. Runs under
   * the narrow `viewer-*` capability, so nothing in it may emit events or build windows.
   */
  if (viewerPath !== null) {
    const vault = params.get('vault') ?? '';
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <QueryClientProvider client={windowQueryClient}>
            <I18nProvider>
              <VaultProvider vault={vault} instanceId="viewer" isActive bus={viewerBus}>
                <ViewerWindow path={viewerPath} />
              </VaultProvider>
            </I18nProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  // The Notifications window (`?inbox=1`): recent banners, each one routed like its banner.
  if (inboxMode) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <QueryClientProvider client={windowQueryClient}>
            <I18nProvider>
              <InboxWindow />
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
              <HandsfreeBanner />
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
            <WindowChrome initialVault={initialVault} initialLink={initialLink} initialStart={initialStart} />
          </I18nProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
