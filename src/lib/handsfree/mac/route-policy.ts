/**
 * Hands-free MAC MODE — what the phone may reach (the audit table).
 *
 * EXHAUSTIVE: every route the dashboard server registers (`buildRouter().list()`) has a row,
 * keyed exactly as registered (`METHOD /api/pattern`, `:name` / `*name` params), with allow or
 * deny and the reason. The phone listener's gate matches a request against the router (first
 * match wins, the same match the handler runs on) and reads this row; a route with NO row is
 * refused (fail closed), and `tests/unit/route-policy.test.ts` fails the build when a registered
 * route is unclassified, so a new route can never silently reach the phone.
 *
 * The default is the whole dashboard: a signed-in phone can already run a bypass-mode chat on
 * this Mac, so the dashboard API adds no capability. What stays laptop-only is administration of
 * the Mac itself (Mac mode, windows, the Assistant, installers, secrets, voice, Finder/Terminal),
 * Settings and the launcher, and anything that lists or reaches ANOTHER registered project (one
 * project per hands-free run; the gate also refuses a request naming another vault).
 *
 * `body` says what an allowed route can send: `json`; `media` (raster images, audio, video or a
 * PDF from a fixed type table, nothing that runs script; an SVG there goes out sandboxed); or
 * `sandboxed` (any other body, always with `Content-Security-Policy: default-src 'none';
 * sandbox`). A test asserts every `sandboxed` row's handler really sends that header.
 *
 * `scope` says which project an allowed route acts on (AC16, the projects chosen at start):
 * `request` = the project the gate resolved (header / `?vault=`, checked against the chosen
 * set); `none` = no project (the phone's own session, push, health, display preferences);
 * `cross:filter` = it reads several projects and the handler itself narrows the answer to the
 * chosen ones (or to the request project's own connections). Every deny row that would reach
 * another project is `cross:deny`. A handler that takes a vault from a body, query or path is
 * never `request`: it is `cross:deny` unless it checks the value with `isMacExposed`.
 */

import { MAC_PUBLIC_ROUTES } from './contract.js';

export type RouteBody = 'json' | 'media' | 'sandboxed' | 'none';
export type RouteScope = 'request' | 'none' | 'cross:filter' | 'cross:deny';

export interface RoutePolicy {
  allow: boolean;
  why: string;
  body: RouteBody;
  scope: RouteScope;
}

const allow = (why: string, body: RouteBody = 'json', scope: RouteScope = 'request'): RoutePolicy => ({ allow: true, why, body, scope });
/** An allowed route that acts on no project. */
const agnostic = (why: string, body: RouteBody = 'json'): RoutePolicy => allow(why, body, 'none');
/** An allowed route that reads several projects; its handler narrows the answer itself. */
const filtered = (why: string, body: RouteBody = 'json'): RoutePolicy => allow(why, body, 'cross:filter');
const deny = (why: string, scope?: RouteScope): RoutePolicy => ({ allow: false, why, body: 'none', scope: scope ?? (why === OTHER_PROJECTS ? 'cross:deny' : 'none') });

// ─── Deny reasons (each row names one) ──────────────────────────────────────

const MAC_ADMIN = 'laptop-only: Mac mode administration (setup, start/stop, password, devices, tunnel) is driven from the laptop';
const SERVER_ADMIN = 'laptop-only: shuts the dashboard server down';
const WINDOW = 'laptop-only: drives the desktop app\'s own windows';
const ASSISTANT = 'laptop-only: the dreamcontext Assistant belongs to this Mac\'s desktop session (it drives every project and the screen)';
const INSTALL = 'laptop-only: installs, updates or downloads software on this Mac';
const SECRET = 'laptop-only: writes or reveals a secret, key or token';
const SIGN_IN = 'laptop-only: signs an account in or out on this Mac';
const OTHER_PROJECTS = 'laptop-only: lists, opens, registers or changes other projects on this Mac (the phone reaches only the projects chosen at start)';
const LAUNCHER = 'laptop-only: launcher administration (projects, logos, app updates, its settings)';
const SETTINGS = 'laptop-only: Settings (the phone shows no Settings page)';
const VOICE = 'laptop-only: this Mac\'s microphone, speaker and voice setup';
const DESKTOP = 'laptop-only: acts on the Mac\'s desktop (Finder, Terminal, Downloads, macOS banners, file grants)';
const BRAIN_WRITE = 'laptop-only: brain sync writes (git remote, fetch, sync) run from the laptop';
const ONBOARDING = 'laptop-only: first-run setup of this Mac';

// ─── Allow reasons ──────────────────────────────────────────────────────────

const READ = 'read of this project\'s own data; side-effect free';
const PROJECT_WRITE = 'a change to this project\'s own data, the same as the dashboard on the laptop';
const CHAT = 'the chat surface the phone exists for';

export const ROUTE_POLICY: Readonly<Record<string, RoutePolicy>> = {
  // Health and the phone's own sign-in
  'GET /api/health': agnostic('public: the build version only on a phone socket (and the reachability probe value); side-effect free'),
  'POST /api/handsfree/login': agnostic('public: the phone signs in (rate-limited, scrypt-gated)'),
  'POST /api/handsfree/logout': agnostic('the phone signs itself out (only its own device)'),
  'GET /api/handsfree/phone': agnostic('the phone\'s Mac chip (battery, sleep allowed); side-effect free'),
  'GET /api/handsfree/push/key': agnostic('the VAPID public key the phone subscribes with; side-effect free'),
  'PUT /api/handsfree/push/subscription': agnostic('the phone stores its own push subscription (device id from its cookie, never the body)'),
  'DELETE /api/handsfree/push/subscription': agnostic('the phone removes its own push subscription'),
  'GET /api/handsfree/mac/status': deny(MAC_ADMIN),
  'POST /api/handsfree/mac/setup': deny(MAC_ADMIN),
  'POST /api/handsfree/mac/start': deny(MAC_ADMIN),
  'POST /api/handsfree/mac/stop': deny(MAC_ADMIN),
  'POST /api/handsfree/mac/qr': deny(MAC_ADMIN),
  'POST /api/handsfree/mac/password': deny(MAC_ADMIN),
  'GET /api/handsfree/mac/devices': deny(MAC_ADMIN),
  'POST /api/handsfree/mac/devices/revoke-all': deny(MAC_ADMIN),
  'POST /api/handsfree/mac/tunnel/fixed': deny(MAC_ADMIN),
  'DELETE /api/handsfree/mac/tunnel/fixed': deny(MAC_ADMIN),
  'POST /api/handsfree/mac/uninstall': deny(MAC_ADMIN),
  'POST /api/admin/shutdown': deny(SERVER_ADMIN),

  // Tasks
  'GET /api/tasks': allow(READ),
  'GET /api/task-proposals': allow(READ),
  'GET /api/task-proposals/count': allow(READ),
  'POST /api/task-proposals/filed/:slug/reject': allow('rejects a task sleep opened in this project, as the Tasks screen does'),
  'POST /api/task-proposals/filed/:slug/keep': allow('keeps a task sleep opened in this project, as the Tasks screen does'),
  'POST /api/task-proposals/changes/:slug/apply': allow('applies a reorganisation the task migration suggested in this project, as the Tasks screen does'),
  'POST /api/task-proposals/changes/:slug/keep': allow('keeps a task as it is against the task migration\'s suggestion, as the Tasks screen does'),
  'POST /api/task-proposals/:id/accept': allow('accepts one of sleep\'s task proposals in this project, as the Tasks screen does'),
  'POST /api/task-proposals/:id/reject': allow('rejects one of sleep\'s task proposals in this project, as the Tasks screen does'),
  'POST /api/task-filing-rules/:id/revert': allow('reverts one of this project\'s task-filing rules, as the Tasks screen does'),
  'POST /api/tasks': allow(PROJECT_WRITE),
  'GET /api/tasks/sync-status': allow(READ),
  'POST /api/tasks/sync': allow('syncs this project\'s tasks with its configured backend, as the dashboard does'),
  'POST /api/tasks/sync-jobs': allow('starts this project\'s task sync job'),
  'GET /api/tasks/sync-jobs/current': allow(READ),
  'POST /api/tasks/sync-test': allow('tests this project\'s backend connection with the stored token (the token is never returned)'),
  'GET /api/tasks/members': allow(READ),
  'GET /api/tasks/containers': allow(READ),
  'POST /api/tasks/provision': allow('creates this project\'s task containers on its backend, as the dashboard does'),
  'GET /api/tasks/token-status': allow('read: whether a token is set, never the token; side-effect free'),
  'POST /api/tasks/token': deny(SECRET),
  'GET /api/task-overrides': allow(READ),
  'GET /api/task-overrides/doc': allow(READ),
  'PUT /api/task-overrides/doc': allow(PROJECT_WRITE),
  'POST /api/task-overrides/fields': allow(PROJECT_WRITE),
  'DELETE /api/task-overrides/fields/:key': allow(PROJECT_WRITE),
  'POST /api/task-overrides/statuses': allow(PROJECT_WRITE),
  'DELETE /api/task-overrides/statuses/:key': allow(PROJECT_WRITE),
  'GET /api/tasks/:slug': allow(READ),
  'GET /api/tasks/:slug/readiness': allow(READ),
  'GET /api/tasks/:slug/journal': allow(READ),
  'DELETE /api/tasks/:slug': allow(PROJECT_WRITE),
  'PATCH /api/tasks/:slug': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/changelog': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/assign-agent': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/insert': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/verdict': allow('the owner approves a task in review or sends it back, as the Inbox does (audited with its via)'),
  'POST /api/tasks/:slug/plan': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/rank': allow(PROJECT_WRITE),

  // The Inbox, the Planning screen and the Close deck (C5)
  'GET /api/inbox': allow(READ),
  'GET /api/inbox/count': allow(READ),
  'POST /api/inbox/seen': allow('marks an Inbox record seen, as the Inbox does (who and through what are kept on it)'),
  'POST /api/learned/:id/revert': allow('the owner reverts a rule sleep learned in this project, as the Inbox does'),
  'GET /api/cycles': allow(READ),
  'GET /api/cycles/:id/close-plan': allow(READ),
  'POST /api/cycles': allow(PROJECT_WRITE),
  'POST /api/cycles/:id/start': allow(PROJECT_WRITE),
  'POST /api/cycles/:id/close': allow(PROJECT_WRITE),

  // Sleep
  'GET /api/sleep': allow(READ),
  'PATCH /api/sleep': allow(PROJECT_WRITE),
  'GET /api/sleep/specialists': allow(READ),
  'GET /api/sleep/auto': allow(READ),
  'PUT /api/sleep/auto': allow(PROJECT_WRITE),
  'POST /api/sleep/auto/cancel': allow(PROJECT_WRITE),

  // Local embeddings
  'GET /api/embeddings/status': agnostic('read: whether the local model is installed; side-effect free'),
  'POST /api/embeddings/download': deny(INSTALL),
  'GET /api/embeddings/index/status': allow(READ),
  'POST /api/embeddings/index': allow('builds this project\'s local recall index (no network)'),

  // Core and knowledge
  'GET /api/core': allow(READ),
  'GET /api/core/people': allow(READ),
  'GET /api/core/people/:slug': allow(READ),
  'PUT /api/core/people/:slug': allow(PROJECT_WRITE),
  'GET /api/core/:filename': allow(READ),
  'PUT /api/core/:filename': allow(PROJECT_WRITE),
  'GET /api/knowledge': allow(READ),
  'GET /api/knowledge-assets/*slug': allow(READ),
  'GET /api/knowledge/*slug': allow(READ),
  'PATCH /api/knowledge/*slug': allow(PROJECT_WRITE),

  // Recall
  'GET /api/recall/haiku': allow('a recall query over this project; side-effect free'),
  'GET /api/recall': allow('a recall query over this project; side-effect free'),
  'POST /api/recall/prompt': deny('laptop-only: an agent hook on this Mac hands its prompt recall to the running app (the phone has GET /api/recall)'),
  'GET /api/recall/options': deny(SETTINGS),
  'GET /api/recall/cloud/status': deny(SETTINGS),
  'POST /api/recall/cloud/key': deny(SECRET),
  'POST /api/recall/cloud/key/copy-voice': deny(SECRET),
  'POST /api/recall/cloud/enable': deny(SETTINGS),
  'POST /api/recall/cloud/disable': deny(SETTINGS),
  'POST /api/recall/cloud/index': deny(SETTINGS),
  'GET /api/recall/cloud/index/status': deny(SETTINGS),

  // Brain sync (the Brain page reads; every write stays on the laptop)
  'POST /api/brain/auth/device/start': deny(SIGN_IN),
  'POST /api/brain/auth/device/poll': deny(SIGN_IN),
  'GET /api/brain/auth/status': agnostic('read: the signed-in GitHub login name, never the token; side-effect free'),
  'POST /api/brain/auth/token': deny(SECRET),
  'POST /api/brain/auth/logout': deny(SIGN_IN),
  'GET /api/brain/team/updates': filtered('read: brain-sync counters per project, narrowed to the chosen projects on a phone; side-effect free'),
  'POST /api/brain/team/fetch': deny(BRAIN_WRITE, 'cross:deny'),
  'GET /api/brain/status': allow(READ),
  'POST /api/brain/sync': deny(BRAIN_WRITE),
  'GET /api/brain/settings': allow(READ),
  'POST /api/brain/settings': deny(BRAIN_WRITE),
  'POST /api/brain/origin/create': deny(BRAIN_WRITE),
  'POST /api/brain/origin/preview': deny(BRAIN_WRITE),
  'POST /api/brain/origin/attach': deny(BRAIN_WRITE),
  'POST /api/brain/origin/update': deny(BRAIN_WRITE),
  'POST /api/brain/origin/detach': deny(BRAIN_WRITE),
  'POST /api/brain/scrub/ignore': deny(BRAIN_WRITE),

  // Linked repos
  'GET /api/linked-repos': allow(READ),
  'POST /api/linked-repos/link': deny(OTHER_PROJECTS),
  'POST /api/linked-repos/clone': deny(OTHER_PROJECTS),
  'POST /api/linked-repos/unlink': deny(OTHER_PROJECTS),

  // Graph, council, config
  'GET /api/graph': allow(READ),
  'GET /api/graph/content': allow('read of a file in this project: JSON, or (raw=1) a PDF/image/audio/video from a fixed type table, images sandboxed', 'media'),
  'GET /api/council': allow(READ),
  'GET /api/council/:debateId': allow(READ),
  'GET /api/council/:debateId/:personaSlug/research/:researchSlug': allow(READ),
  'GET /api/config': allow(READ),
  'PATCH /api/config': deny(SETTINGS),

  // Launcher
  'GET /api/launcher/discover': deny(OTHER_PROJECTS),
  'GET /api/launcher/detect': deny(OTHER_PROJECTS),
  'GET /api/launcher/defaults': deny(LAUNCHER),
  'GET /api/launcher/catalog': deny(LAUNCHER),
  'POST /api/launcher/register': deny(OTHER_PROJECTS),
  'POST /api/launcher/scaffold': deny(OTHER_PROJECTS),
  'GET /api/launcher/agent-settings': agnostic('read: the Agents page display preferences; side-effect free'),
  'POST /api/launcher/agent-settings': deny(LAUNCHER),
  'GET /api/launcher/ui-settings': agnostic('read: the dashboard\'s display preferences; side-effect free'),
  'POST /api/launcher/ui-settings': deny(LAUNCHER),
  'GET /api/launcher/status': deny(OTHER_PROJECTS),
  'GET /api/launcher/logo': deny(OTHER_PROJECTS),
  'POST /api/launcher/logo': deny(LAUNCHER),
  'POST /api/launcher/touch': deny(OTHER_PROJECTS),
  'POST /api/launcher/unregister': deny(OTHER_PROJECTS),
  'POST /api/launcher/update': deny(INSTALL),
  'POST /api/launcher/upgrade': deny(INSTALL),
  'GET /api/launcher/upgrade/status': deny(INSTALL),
  'POST /api/launcher/relaunch': deny(LAUNCHER),
  'GET /api/launcher/federation-graph': deny(OTHER_PROJECTS),
  'POST /api/launcher/connection': deny(OTHER_PROJECTS),
  'POST /api/launcher/connection/remove': deny(OTHER_PROJECTS),
  'POST /api/launcher/sync': deny(OTHER_PROJECTS),
  'POST /api/launcher/sync/remove': deny(OTHER_PROJECTS),
  'GET /api/launcher/github/repos': deny(OTHER_PROJECTS),
  'POST /api/launcher/clone': deny(OTHER_PROJECTS),
  'GET /api/launcher/clone/status': deny(OTHER_PROJECTS),
  'POST /api/launcher/clone/cancel': deny(OTHER_PROJECTS),

  // The Assistant and window control
  'GET /api/assistant/status': deny(ASSISTANT),
  'GET /api/assistant/rollup': deny(ASSISTANT),
  'GET /api/assistant/glance': deny(ASSISTANT),
  'POST /api/assistant/answer': deny(ASSISTANT),
  'POST /api/assistant/delegations/dismiss': deny(ASSISTANT),
  'GET /api/assistant/inbox': deny(ASSISTANT),
  'POST /api/assistant/inbox/dismiss': deny(ASSISTANT),
  'POST /api/assistant/inbox/seen': deny(ASSISTANT),
  'POST /api/assistant/inbox/mute': deny(ASSISTANT),
  'POST /api/assistant/presence': deny(ASSISTANT),
  'POST /api/assistant/create': deny(ASSISTANT),
  'GET /api/assistant/profile': deny(ASSISTANT),
  'POST /api/assistant/profile': deny(ASSISTANT),
  'GET /api/assistant/avatar': deny(ASSISTANT),
  'POST /api/assistant/avatar': deny(ASSISTANT),
  'GET /api/assistant/proposals': deny(ASSISTANT),
  'POST /api/assistant/proposals/:id': deny(ASSISTANT),
  'POST /api/assistant/windows': deny(ASSISTANT),
  'POST /api/assistant/windows/release': deny(ASSISTANT),
  'GET /api/assistant/windows': deny(ASSISTANT),
  'POST /api/assistant/open': deny(ASSISTANT),
  'POST /api/assistant/commands/:id/bind': deny(ASSISTANT),
  'POST /api/assistant/commands/:id/claim': deny(ASSISTANT),
  'POST /api/assistant/commands/:id/result': deny(ASSISTANT),
  'GET /api/assistant/projects': deny(ASSISTANT),
  'GET /api/assistant/sessions': deny(ASSISTANT),
  'GET /api/assistant/watch': deny(ASSISTANT),
  'GET /api/assistant/recall': deny(ASSISTANT),
  'GET /api/assistant/index': deny(ASSISTANT),
  'GET /api/assistant/read': deny(ASSISTANT),
  'POST /api/assistant/broadcast': deny(ASSISTANT),
  'POST /api/assistant/ui/:verb': deny(ASSISTANT),
  'POST /api/assistant/look': deny(ASSISTANT),
  'POST /api/window/:verb': deny(WINDOW),

  // The chat's mascot
  'GET /api/sleepy/video': agnostic('read: the mascot clip (mp4 from a fixed set); side-effect free', 'media'),
  'GET /api/sleepy/anim': agnostic('read: the mascot animation (webp from a fixed set); side-effect free', 'media'),

  // Agent surface (chat)
  'GET /api/agent/capabilities': agnostic(`${CHAT}: what this host offers; side-effect free`),
  'GET /api/agent/model-config': agnostic(`${CHAT}: models and efforts; side-effect free`),
  'GET /api/agent/usage-limits': agnostic(`${CHAT}: the cached usage reading; side-effect free`),
  'GET /api/agent/accounts': agnostic(`${CHAT}: the account list (no credentials); side-effect free`),
  'POST /api/agent/accounts/adopt': deny(SIGN_IN),
  'POST /api/agent/accounts/login': deny(SIGN_IN),
  'POST /api/agent/accounts/relogin': deny(SIGN_IN),
  'POST /api/agent/accounts/preferred': agnostic(`${CHAT}: which signed-in account new chats use`),
  'POST /api/agent/accounts/reorder': agnostic(`${CHAT}: the order accounts are tried in`),
  'POST /api/agent/accounts/refresh': agnostic(`${CHAT}: re-reads the accounts' usage`),
  'POST /api/agent/accounts/remove': deny(SIGN_IN),
  'POST /api/agent/accounts/auto-switch': agnostic(`${CHAT}: switch accounts at a limit`),
  'POST /api/agent/accounts/switch-policy': agnostic(`${CHAT}: how accounts are switched`),
  'GET /api/agent/mcp': allow(`${CHAT}: the MCP servers and their state (no credentials); side-effect free`),
  'POST /api/agent/mcp/login': deny(SIGN_IN),
  'POST /api/agent/mcp/logout': deny(SIGN_IN),
  'GET /api/agent/mcp/project': allow(`${CHAT}: this project's MCP servers; side-effect free`),
  'POST /api/agent/mcp/project/adopt': deny(SETTINGS),
  'POST /api/agent/mcp/project/remove': deny(SETTINGS),
  'GET /api/agent/session-model': allow(`${CHAT}: one chat's model; side-effect free`),
  'GET /api/agent/session-stats': allow(`${CHAT}: one chat's token stats; side-effect free`),
  'GET /api/agent/chat-history': allow(`${CHAT}: one chat's transcript; side-effect free`),
  'GET /api/agent/live-chats': allow(`${CHAT}: this project's running chats (names, never paths); side-effect free`),
  'GET /api/agent/slash-commands': allow(`${CHAT}: the slash command list; side-effect free`),
  'GET /api/agent/chat-sessions': allow(`${CHAT}: this project's past chats; side-effect free`),
  'GET /api/agent/bg-output': allow(`${CHAT}: a background shell's output; side-effect free`),
  'GET /api/agent/file': allow(`${CHAT}: a file inside this project (grants refused on the phone): JSON, or (raw=1) media from a fixed type table; an SVG goes out sandboxed`, 'media'),
  'GET /api/agent/board-assets': allow(`${CHAT}: a board's images inside this project; side-effect free`),
  'POST /api/agent/reveal': deny(DESKTOP),
  'POST /api/agent/grant': deny(DESKTOP),
  'GET /api/agent/goal-live': allow(`${CHAT}: a Develop run's live map; side-effect free`),
  'GET /api/agent/teammates': allow(`${CHAT}: the chat's sub-agents; side-effect free`),
  'GET /api/agent/teammate-history': allow(`${CHAT}: one sub-agent's transcript; side-effect free`),
  'GET /api/agent/council-live': allow(`${CHAT}: a council's live state; side-effect free`),
  'GET /api/agent/task-progress': allow(`${CHAT}: the shelf's task progress; side-effect free`),
  'GET /api/agent/session-facts': allow(`${CHAT}: the shelf's branch and checkout; side-effect free`),
  'POST /api/agent/open-terminal': deny(DESKTOP),
  'POST /api/agent/install': deny(INSTALL),
  'GET /api/agent/install/status': deny(INSTALL),
  'GET /api/onboarding/readiness': deny(ONBOARDING),
  'POST /api/onboarding/fix': deny(ONBOARDING),
  'POST /api/onboarding/fix/cancel': deny(ONBOARDING),
  'POST /api/agent/prompt': filtered(`${CHAT}: hands an opening prompt to a new chat (the body's vault is checked with isMacExposed)`),
  'POST /api/agent/drop': deny(DESKTOP),
  'GET /api/notifications': deny(DESKTOP),
  'POST /api/notify': deny(DESKTOP),
  'POST /api/agent/secret': deny(SECRET),
  'POST /api/agent/voice/stt': deny(VOICE),
  'POST /api/agent/voice/tts': deny(VOICE),
  'POST /api/agent/voice/warm': deny(VOICE),
  'POST /api/agent/voice/log': deny(VOICE),
  'POST /api/agent/voice/focus': deny(VOICE),
  'GET /api/agent/voice/status': deny(VOICE),
  'GET /api/agent/voice/dictation': deny(VOICE),
  'POST /api/agent/voice/dictation': deny(INSTALL),
  'PUT /api/agent/voice/config': deny(VOICE),
  'POST /api/agent/download': deny(DESKTOP),
  'GET /api/agent/sessions': allow(`${CHAT}: the phone's own tab roster; side-effect free`),
  'PUT /api/agent/sessions': allow(`${CHAT}: the phone's own tab roster`),
  'GET /api/vaults': filtered('read: only the chosen projects, by name (never a path, never another project); side-effect free'),

  // Peers and federation (this project's own connections)
  'GET /api/connections': filtered('read: the request project\'s own connections (peer names); side-effect free'),
  'POST /api/connections': deny(OTHER_PROJECTS),
  'DELETE /api/connections/:vault': deny(OTHER_PROJECTS),
  'GET /api/peer/peers': filtered('read: the request project\'s own connected peers (names); side-effect free'),
  'GET /api/peer/logo': filtered('read: a logo of one of the request project\'s own connected peers, always sandboxed; side-effect free', 'sandboxed'),
  'GET /api/peer/mail': allow(READ),
  'POST /api/peer/send': deny(OTHER_PROJECTS),
  'POST /api/peer/mail/:id/status': allow(PROJECT_WRITE),
  'GET /api/federation/inbox': filtered('read: the request project\'s own federation inbox; side-effect free'),
  'POST /api/federation/sync': deny(OTHER_PROJECTS),

  // Packs and preferences
  'GET /api/packs': allow(READ),
  'POST /api/packs/:name/install': deny(INSTALL),
  'DELETE /api/packs/:name': deny(INSTALL),
  'GET /api/brain-settings': allow(READ),
  'PUT /api/brain-settings': allow(PROJECT_WRITE),
  'GET /api/roadmap-prefs': allow(READ),
  'PUT /api/roadmap-prefs': allow(PROJECT_WRITE),
  'GET /api/lab-prefs': allow(READ),
  'PUT /api/lab-prefs': allow(PROJECT_WRITE),
  'GET /api/whiteboard-prefs': allow(READ),
  'PUT /api/whiteboard-prefs': allow(PROJECT_WRITE),

  // Roadmap
  'GET /api/roadmap': allow(READ),
  'GET /api/objectives': allow(READ),
  'POST /api/objectives': allow(PROJECT_WRITE),
  'PATCH /api/objectives/:slug': allow(PROJECT_WRITE),
  'DELETE /api/objectives/:slug': allow(PROJECT_WRITE),
  'POST /api/objectives/:slug/dependencies': allow(PROJECT_WRITE),
  'DELETE /api/objectives/:slug/dependencies/:to': allow(PROJECT_WRITE),

  // Lab
  'GET /api/lab': allow(READ),
  'POST /api/lab/sync': allow('refreshes this project\'s insights from their sources with the stored credentials (never returned)'),
  'POST /api/lab/sync-jobs': allow('starts this project\'s insight sync job'),
  'GET /api/lab/sync-jobs/current': allow(READ),
  'GET /api/lab/credentials': deny(SECRET),
  'POST /api/lab/credentials': deny(SECRET),
  'GET /api/lab/boards': allow(READ),
  'POST /api/lab/boards': allow(PROJECT_WRITE),
  'GET /api/lab/boards/:slug': allow(READ),
  'PUT /api/lab/boards/:slug': allow(PROJECT_WRITE),
  'DELETE /api/lab/boards/:slug': allow(PROJECT_WRITE),
  'GET /api/lab/caches': allow(READ),
  'GET /api/lab/explorer/:slug': allow(READ),
  'GET /api/lab/blocks': allow(READ),
  'GET /api/lab/blocks/:slug': allow(READ),
  'PUT /api/lab/blocks/:slug': allow(PROJECT_WRITE),
  'GET /api/lab/:slug': allow(READ),
  'PATCH /api/lab/:slug/tweaks': allow(PROJECT_WRITE),
  'PATCH /api/lab/:slug/binding': allow(PROJECT_WRITE),

  // Agents
  'GET /api/agents': allow(READ),
  'POST /api/agents': allow(PROJECT_WRITE),
  'GET /api/agents/:slug': allow(READ),
  'POST /api/agents/:slug/update': allow(PROJECT_WRITE),
  'POST /api/agents/:slug/delete': allow(PROJECT_WRITE),
  'POST /api/agents/:slug/approve': allow('the owner approves this project\'s agent, as on the laptop'),
  'GET /api/agents/:slug/photo': allow('read: an agent photo (png/jpeg/gif/webp by magic bytes); side-effect free', 'media'),
  'POST /api/agents/:slug/photo': allow(PROJECT_WRITE),

  // Automations
  'GET /api/automations': allow(READ),
  'POST /api/automations': allow(PROJECT_WRITE),
  'GET /api/automations/runs': allow(READ),
  'GET /api/automations/dispatcher': allow('read: whether the scheduler is installed; side-effect free'),
  'POST /api/automations/dispatcher/install': deny(INSTALL),
  'POST /api/automations/dispatcher/uninstall': deny(INSTALL),
  'GET /api/automations/questions': allow(READ),
  'POST /api/automations/questions/:id': allow(PROJECT_WRITE),
  'GET /api/automations/queue': allow(READ),
  'GET /api/automations/attention': allow(READ),
  'POST /api/automations/attention/ack': allow(PROJECT_WRITE),
  'GET /api/automations/threads': allow(READ),
  'POST /api/automations/threads/read': allow(PROJECT_WRITE),
  'POST /api/automations/threads/say': allow(PROJECT_WRITE),
  'GET /api/automations/reply-job/:id': allow(READ),
  'GET /api/automations/:slug/thread': allow(READ),
  'POST /api/automations/:slug/thread/reply': allow(PROJECT_WRITE),
  'GET /api/automations/:slug/session': allow(READ),
  'GET /api/automations/:slug': allow(READ),
  'POST /api/automations/:slug/run': allow('runs this project\'s automation now, as on the laptop'),
  'POST /api/automations/:slug/approve': allow('the owner approves this project\'s automation, as on the laptop'),
  'POST /api/automations/:slug/enable': allow(PROJECT_WRITE),
  'POST /api/automations/:slug/disable': allow(PROJECT_WRITE),
  'POST /api/automations/:slug/update': allow(PROJECT_WRITE),
  'POST /api/automations/:slug/delete': allow(PROJECT_WRITE),
  'GET /api/automations/:slug/photo': allow('read: an automation photo (png/jpeg/gif/webp by magic bytes); side-effect free', 'media'),
  'POST /api/automations/:slug/photo': allow(PROJECT_WRITE),
  'GET /api/automations/:slug/flow': allow(READ),
  'GET /api/automations/:slug/telegram': deny(SECRET),
  'POST /api/automations/:slug/telegram': deny(SECRET),

  // Theses and learning
  'GET /api/theses': allow(READ),
  'POST /api/theses': allow(PROJECT_WRITE),
  'POST /api/theses/:slug/predictions': allow(PROJECT_WRITE),
  'POST /api/theses/:slug/evidence': allow(PROJECT_WRITE),
  'POST /api/theses/:slug/status': allow(PROJECT_WRITE),
  'POST /api/theses/:slug/links': allow(PROJECT_WRITE),
  'DELETE /api/theses/:slug/links/:kind/:target': allow(PROJECT_WRITE),
  'POST /api/theses/:slug/changelog': allow(PROJECT_WRITE),
  'POST /api/theses/:slug/promote': allow(PROJECT_WRITE),
  'GET /api/theses/:slug': allow(READ),
  'PATCH /api/theses/:slug': allow(PROJECT_WRITE),
  'DELETE /api/theses/:slug': allow(PROJECT_WRITE),
  'POST /api/learning/enable': allow(PROJECT_WRITE),
  'POST /api/learning/disable': allow(PROJECT_WRITE),

  // Boards and whiteboards
  'GET /api/board': allow(READ),
  'GET /api/chat/html-kit': allow(`${CHAT}: the dream-html kit; side-effect free`),
  'PUT /api/board/shared': allow(PROJECT_WRITE),
  'PUT /api/board/local': allow(PROJECT_WRITE),
  'GET /api/whiteboards': allow(READ),
  'POST /api/whiteboards': allow(PROJECT_WRITE),
  'GET /api/whiteboards/default': allow(READ),
  'GET /api/whiteboards/pages': allow(READ),
  'GET /api/whiteboards/trash': allow(READ),
  'POST /api/whiteboards/trash/:id/restore': allow(PROJECT_WRITE),
  'GET /api/whiteboards/:slug/rev': allow(READ),
  'POST /api/whiteboards/:slug/files/:id': allow(PROJECT_WRITE),
  'GET /api/whiteboards/:slug/files/:id': allow('read: a board file, always sent with the sandbox CSP; side-effect free', 'sandboxed'),
  'GET /api/whiteboards/:slug': allow(READ),
  'PUT /api/whiteboards/:slug': allow(PROJECT_WRITE),
  'PATCH /api/whiteboards/:slug': allow(PROJECT_WRITE),
  'DELETE /api/whiteboards/:slug': allow(PROJECT_WRITE),

  // Versions and releases
  'GET /api/version-check': allow('read: the cached update nudge; side-effect free'),
  'GET /api/taxonomy': allow(READ),
  'GET /api/changelog': allow(READ),
  'GET /api/releases': allow(READ),
  'GET /api/releases/unreleased': allow(READ),
  'GET /api/releases/active': allow(READ),
  'PUT /api/releases/active': allow(PROJECT_WRITE),
  'GET /api/releases/:version': allow(READ),
  'POST /api/releases': allow(PROJECT_WRITE),
  'PATCH /api/releases/:version': allow(PROJECT_WRITE),
  'DELETE /api/releases/:version': allow(PROJECT_WRITE),
  // Light mode's Auto reads THIS Mac's memory and power source for its own windows; the
  // phone's light mode is the phone's business (its request is refused locally, Auto stays off).
  'GET /api/app/machine': deny('laptop-only: this Mac\'s memory and power source, for its own windows\' Light mode'),
  // The sleep-eval test set is copies of this brain's past sleep rounds and stays on this Mac
  // (task: uyku-ve-gorev-acma-olculur…, "yalnız yerel, yayımlanmaz"); its labelling deck is a
  // desktop Tasks-screen surface.
  'GET /api/sleep-eval/labels': deny('laptop-only: the sleep-eval test set is local copies of past sleep rounds'),
  'POST /api/sleep-eval/labels': deny('laptop-only: labels the local sleep-eval test set'),
};

/** The row for a matched route (`method` as registered, `path` the registered pattern), or
 *  null when the route is unclassified (the caller refuses it). HEAD reads its GET row. */
export function routePolicyFor(method: string, path: string): RoutePolicy | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return ROUTE_POLICY[`${m} ${path}`] ?? null;
}

// ─── The phone listener's classifier ────────────────────────────────────────

/** How the phone listener's gate treats one request. */
export type MacRouteClass = 'public' | 'device' | 'unavailable';

/** The router's first match for a request (the same match its handler runs on), or null. */
export type RouteMatcher = (method: string, pathname: string) => { method: string; path: string } | null;

const PUBLIC_SET = new Set(MAC_PUBLIC_ROUTES);

/**
 * Classify one phone-listener request. `MAC_PUBLIC_ROUTES` are public; any non-API path is the
 * app shell (device: a session is required); an `/api` path is matched against the router and
 * allowed only when its row says so. No match, no row, a deny row, or a path the router cannot
 * decode is `unavailable`. HEAD reads its GET row.
 */
export function classifyMacRoute(method: string, pathname: string, match: RouteMatcher): MacRouteClass {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  if (PUBLIC_SET.has(`${m} ${pathname}`)) return 'public';
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return 'device';
  let hit: { method: string; path: string } | null;
  try { hit = match(m, pathname); } catch { return 'unavailable'; }
  if (!hit) return 'unavailable';
  return routePolicyFor(hit.method, hit.path)?.allow ? 'device' : 'unavailable';
}
