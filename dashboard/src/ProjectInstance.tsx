import { useEffect, useRef } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { VaultProvider, useInstanceEvent } from './context/VaultContext';
import { ProjectProvider } from './context/ProjectContext';
import { I18nProvider } from './context/I18nContext';
import { createInstanceQueryClient, setInstanceActive } from './lib/instanceQueryClient';
import { Shell, type ShellNavigation } from './components/layout/Shell';
import { AnnouncementsModal } from './components/layout/AnnouncementsModal';
import { AgentSurface, PROJECT_ROLLUP_EVENT } from './components/sleepy/AgentSurface';
import type { ProjectRollup } from './components/sleepy/agentStatus';
import { TasksPage } from './pages/TasksPage';
import { RoadmapPage } from './pages/RoadmapPage';
import { HypothesesPage } from './pages/HypothesesPage';
import { LabPage } from './pages/LabPage';
import { AutomationsPage } from './pages/AutomationsPage';
import { SleepPage } from './pages/SleepPage';
import { CorePage } from './pages/CorePage';
import { KnowledgePage } from './pages/KnowledgePage';
import { BrainPage, type BrainNavigatePage } from './pages/BrainPage';
import { CouncilPage } from './pages/CouncilPage';
import { SettingsPage } from './pages/SettingsPage';
import { PacksPage } from './pages/PacksPage';
import { AboutPage } from './pages/AboutPage';
import { TaxonomyPage } from './pages/TaxonomyPage';
import { SavedBlocksPage } from './pages/SavedBlocksPage';
import { AnnouncementsPage } from './pages/AnnouncementsPage';
import type { Page } from './components/layout/Sidebar';
import './ProjectInstance.css';

/**
 * ONE live project, mounted inside a window that may be holding several.
 *
 * This is the unit that used to be an entire OS window. Everything a project owns now hangs
 * off this subtree instead of off module scope: its API client's vault, its query cache, its
 * event bus, its agent surface and its PTYs. Two of these can be mounted side by side and
 * share nothing.
 *
 * The load-bearing rule is that a background instance is HIDDEN, never unmounted. Unmounting
 * would dispose its agent surface, which kills the WebSocket, which kills the PTY, which ends
 * a conversation the user only meant to look away from. So `isActive` reaches exactly three
 * things — `hidden`, `inert`, and page-data polling — and never a session, a socket or a
 * session factory.
 */

/**
 * The listener half of the agent surface's "open this in the app" bridge.
 *
 * `AgentSurface` is mounted OUTSIDE `Shell` (so its PTY/scrollback survives navigation), which
 * leaves it with no handle on Shell's navigation state — it fires a
 * `dreamcontext-agent-open-page` event on this instance's bus instead. Until this existed
 * nothing listened, so the chat's "Open in app ↗" collapsed the overlay onto whatever page
 * happened to be underneath. This closes that loop, and is what makes the transcript's
 * `task`/`knowledge`/`core` action buttons actually land on the item.
 *
 * THE BUS, NOT `window`. The payload's `id` is a task/knowledge slug that exists in exactly
 * one vault. Heard by every mounted instance, project A's "Open in app ↗" would also navigate
 * project B's Shell to a slug B has never had — the visible result being B silently jumping
 * to its Tasks page with nothing focused. Scoped to the bus, only the project the chat
 * belongs to moves.
 *
 * Rendered inside Shell's children — so it has `nav`, and it is under this instance's
 * `VaultProvider`, which is where `useInstanceEvent` reads the bus from. Renders nothing.
 */
function AgentPageNavBridge({ nav }: { nav: ShellNavigation }) {
  useInstanceEvent<{ page?: unknown; id?: unknown } | undefined>(
    'dreamcontext-agent-open-page',
    (detail) => {
      const page = detail?.page;
      if (page !== 'tasks' && page !== 'knowledge' && page !== 'core') return;
      nav.navigate(page, typeof detail?.id === 'string' && detail.id ? detail.id : null);
    },
  );
  return null;
}

/**
 * The forwarding half of the chip strip's signal.
 *
 * `AgentSurface` is the only surface that can see a project's sessions, but it has no idea it
 * is one of several projects in a window — so it publishes a rollup on this instance's bus and
 * says nothing about who it is. This bridge is where the rollup gets its NAME: it is mounted
 * once per instance, closes over that instance's vault, and hands both to the chrome's sink.
 *
 * Rendered inside `VaultProvider`, because that is where `useInstanceEvent` reads the bus
 * from — a hook called in `ProjectInstance`'s own body would subscribe to the off-instance
 * fallback bus and never hear a thing. Renders nothing.
 */
function RollupBridge({
  vault, onRollup,
}: { vault: string; onRollup?: (vault: string, rollup: ProjectRollup) => void }) {
  useInstanceEvent<ProjectRollup>(PROJECT_ROLLUP_EVENT, (rollup) => onRollup?.(vault, rollup));
  return null;
}

function PageRouter({ nav }: { nav: ShellNavigation }) {
  const handleBrainNavigate = (target: BrainNavigatePage, nodeId: string) => {
    const pageMap: Record<BrainNavigatePage, Page> = {
      tasks: 'tasks',
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
      return <RoadmapPage onNavigate={(page, id) => nav.navigate(page, id ?? null)} focus={focus} />;
    case 'hypotheses':
      return <HypothesesPage focus={focus} />;
    case 'lab':
      return <LabPage focus={focus} />;
    case 'automations':
      return <AutomationsPage />;
    case 'sleep':
      return <SleepPage />;
    case 'core':
      return <CorePage onNavigateTaxonomy={() => nav.navigate('taxonomy', null)} focus={focus} />;
    case 'knowledge':
      return <KnowledgePage focus={focus} />;
    case 'council':
      return <CouncilPage />;
    case 'settings':
      return <SettingsPage focus={focus} />;
    case 'packs':
      return <PacksPage />;
    case 'taxonomy':
      return <TaxonomyPage />;
    case 'saved':
      return <SavedBlocksPage />;
    case 'about':
      return <AboutPage />;
    case 'announcements':
      return <AnnouncementsPage focus={focus} />;
  }
}

export interface ProjectInstanceProps {
  /** Which project this subtree IS. Every request, storage key and session it owns is bound
   *  to this name — it is read once at mount and never changes for the life of the mount. */
  vault: string;
  /** Stable for this mount, never reused; namespaces anything two instances would collide on. */
  instanceId: string;
  /** Whether this is the chip the user is looking at. Gates visibility and polling ONLY. */
  isActive: boolean;
  /**
   * Rail width, hoisted to the window: N instances each running their own `useSidebarCollapse`
   * would diverge the moment one toggled, and two rails of different widths inside one window
   * reads as broken. Forwarded straight to `Shell`, which no longer owns the state.
   */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /**
   * Publishes this project's chip state (worst-of status, live conversations, how many are
   * blocked on the user) up to the window chrome, which is what draws its chip. Optional
   * because an instance is perfectly valid without a strip above it — it simply goes unheard.
   */
  onRollup?: (vault: string, rollup: ProjectRollup) => void;
}

export function ProjectInstance({
  vault, instanceId, isActive, sidebarCollapsed, onToggleSidebar, onRollup,
}: ProjectInstanceProps) {
  /*
   * Both of these are per-instance identities that must survive every re-render: a new
   * QueryClient would drop the project's whole cache mid-session, and a new EventTarget would
   * silently orphan every listener already subscribed to the old one. Lazily initialised
   * through a ref rather than `useRef(create())`, which would construct (and throw away) a
   * fresh client on every single render.
   */
  const clientRef = useRef<QueryClient | null>(null);
  if (clientRef.current === null) clientRef.current = createInstanceQueryClient();
  const queryClient = clientRef.current;

  const busRef = useRef<EventTarget | null>(null);
  if (busRef.current === null) busRef.current = new EventTarget();
  const bus = busRef.current;

  // Page-data polling follows visibility. Nothing else does — see this file's header.
  useEffect(() => {
    setInstanceActive(queryClient, isActive);
  }, [queryClient, isActive]);

  return (
    /*
     * `hidden` + `inert` is the whole hiding mechanism, and both halves are needed: `hidden`
     * (backed by the `!important` rule in ProjectInstance.css) takes the subtree out of layout
     * so nothing measures or paints it, and `inert` takes it out of the focus and interaction
     * order so a keystroke meant for the visible project can never land in a hidden one.
     */
    <div
      className="project-instance"
      data-instance={instanceId}
      hidden={!isActive}
      inert={!isActive}
    >
      <QueryClientProvider client={queryClient}>
        <VaultProvider vault={vault} instanceId={instanceId} isActive={isActive} bus={bus}>
          <ProjectProvider>
            <I18nProvider>
              <Shell sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar}>
                {(nav) => (
                  <>
                    <PageRouter nav={nav} />
                    <AgentPageNavBridge nav={nav} />
                    <AnnouncementsModal onOpenPage={(id) => nav.navigate('announcements', id ?? null)} />
                  </>
                )}
              </Shell>
              {/* BEFORE `AgentSurface`, and that is not cosmetic. Sibling effects are flushed
                  in tree order, so this subscribes to the bus before the surface's first
                  publish fires — mounted after it, the opening rollup would be emitted into
                  an empty bus and dropped. The chrome would then hold `rollup: null` for a
                  project that had already said what it was doing: its badge would sit blank
                  until the next status flip, and the ceiling would refuse to evict it. */}
              <RollupBridge vault={vault} onRollup={onRollup} />
              {/* Mounted OUTSIDE Shell, exactly as it was at the app root: the agent floater
                  keeps its PTY/scrollback alive across navigation and collapse/expand, which
                  only holds while it is not remounted by the page switch. */}
              <AgentSurface />
            </I18nProvider>
          </ProjectProvider>
        </VaultProvider>
      </QueryClientProvider>
    </div>
  );
}
