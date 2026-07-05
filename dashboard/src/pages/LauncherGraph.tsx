import { FederationBoard } from '../components/federation/FederationBoard';

/**
 * The Launcher's full-screen cross-project federation board. The interactive
 * board itself now lives in the reusable `FederationBoard` widget (also mounted,
 * bounded, inside Settings → Connections); this is the launcher-variant wrapper
 * so `LauncherPage` keeps importing `LauncherGraph` unchanged.
 */
export function LauncherGraph() {
  return <FederationBoard variant="full" />;
}
