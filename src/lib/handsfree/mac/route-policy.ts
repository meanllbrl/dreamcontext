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
const SUPER = 'laptop-only: the Super Agent hand-over drives this Mac\'s Chat screen and the project\'s chats';
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
const STAGE = 'the remote stage, read and arrange only; the Mac window stays the Super\'s bridge';

export const ROUTE_POLICY: Readonly<Record<string, RoutePolicy>> = {
  // Health and the phone's own sign-in
  'GET /api/health': agnostic('public: the build version only on a phone socket (and the reachability probe value); side-effect free'),
  'POST /api/handsfree/login': agnostic('public: the phone signs in (rate-limited, scrypt-gated)'),
  'POST /api/handsfree/logout': agnostic('the phone signs itself out (only its own device)'),
  'GET /api/handsfree/phone': agnostic('the phone\'s Mac chip (battery, sleep allowed, heat state, Bag mode and when the run started); side-effect free'),
  'GET /api/handsfree/push/key': agnostic('the VAPID public key the phone subscribes with; side-effect free'),
  'PUT /api/handsfree/push/subscription': agnostic('the phone stores its own push subscription (device id from its cookie, never the body)'),
  'DELETE /api/handsfree/push/subscription': agnostic('the phone removes its own push subscription'),
  'POST /api/handsfree/phone-log': agnostic('the phone sends its own connection log to this Mac (signed-in phone only, 64 KB, shape-checked, no message text)'),
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
  'GET /api/tasks/:slug/assets': allow(READ),
  'GET /api/tasks/:slug/assets/raw': allow('read of a file in this project (a task attachment): a raster image, audio, video or PDF from a fixed type table (anything else is 415), images sandboxed, never the PDF', 'media'),
  'POST /api/tasks/:slug/assets': deny('laptop-only: attaching a file to a task is a desktop/laptop upload, like the agent file drop'),
  'GET /api/tasks/:slug': allow(READ),
  'GET /api/tasks/:slug/readiness': allow(READ),
  'DELETE /api/tasks/:slug': allow(PROJECT_WRITE),
  'PATCH /api/tasks/:slug': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/changelog': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/assign-agent': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/agent-action': allow('the owner answers its task\'s agent job from the drawer (start now, stop, continue, approve), as its inbox row does; a teammate\'s agent is refused not_owner'),
  'POST /api/tasks/:slug/objection': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/filing-approval': allow(PROJECT_WRITE),
  'POST /api/tasks/:slug/insert': allow(PROJECT_WRITE),

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
  'GET /api/launcher/global-agents': deny(LAUNCHER),
  'POST /api/launcher/global-agents': deny(LAUNCHER),
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
  'GET /api/launcher/self-update': deny(INSTALL),
  'POST /api/launcher/self-update': deny(INSTALL),
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
  'POST /api/super/v/:verb': deny(SUPER),
  'GET /api/super/state': deny(SUPER),
  'POST /api/super/enable': deny(SUPER),
  'POST /api/super/disable': deny(SUPER),
  'POST /api/super/layout': deny(SUPER),
  'POST /api/super/activity': deny(SUPER),
  'POST /api/super/recap': deny(SUPER),
  'POST /api/super/fresh': deny(SUPER),
  'POST /api/super/end': deny(SUPER),
  'POST /api/super/seen': deny(SUPER),
  'POST /api/super/pad': deny(SUPER),

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
  'POST /api/agent/accounts/owner-only': agnostic(`${CHAT}: which accounts unattended agent work may use`),
  'POST /api/agent/accounts/agent-threshold': agnostic(`${CHAT}: how full an account may be before unattended agent work waits`),
  // MCP management (task mcp-management): Settings' matrix, probes, sign-ins and store edits are
  // the owner window's alone (they spawn `claude` and save commands that run on every spawn).
  'GET /api/agent/mcp/overview': deny(SETTINGS),
  'POST /api/agent/mcp/check': deny(SETTINGS),
  'POST /api/agent/mcp/connect': deny(SIGN_IN),
  'GET /api/agent/mcp/connect/:ticket': deny(SIGN_IN),
  'DELETE /api/agent/mcp/connect/:ticket': deny(SIGN_IN),
  'POST /api/agent/mcp/server': deny(SETTINGS),
  'POST /api/agent/mcp/server/remove': deny(SETTINGS),
  'POST /api/agent/mcp/server/move': deny(SETTINGS),
  'POST /api/agent/mcp/import': deny(SETTINGS),
  // Owner window only since task mcp-management (requireOwnerWindow), so never the phone's.
  'GET /api/agent/mcp/project': deny(SETTINGS),
  'POST /api/agent/mcp/project/adopt': deny(SETTINGS),
  'POST /api/agent/mcp/project/remove': deny(SETTINGS),
  'GET /api/agent/session-model': allow(`${CHAT}: one chat's model; side-effect free`),
  'GET /api/agent/session-stats': allow(`${CHAT}: one chat's token stats; side-effect free`),
  'GET /api/agent/chat-history': allow(`${CHAT}: one chat's transcript; side-effect free`),
  'GET /api/agent/live-chats': allow(`${CHAT}: this project's running chats (names, never paths); side-effect free`),
  'GET /api/agent/super-questions': allow(`${CHAT}: a handed-over project's open Super Agent questions, each with its card (the child's question as it asks it); side-effect free`),
  'POST /api/agent/super-answer': allow(`${CHAT}: the owner answers a child's question the Super Agent escalated; the Mac window answers it through the child's own session`),
  'GET /api/agent/super-stage': allow(`${STAGE}; side-effect free`),
  'POST /api/agent/super-stage/layout': allow(`${STAGE}: an allowlist of arranging keys (no close, group or Others)`),
  'POST /api/agent/super-stage/seen': allow(`${STAGE}: the agenda's seen marks`),
  'GET /api/agent/slash-commands': allow(`${CHAT}: the slash command list; side-effect free`),
  'GET /api/agent/chat-sessions': allow(`${CHAT}: this project's past chats; side-effect free`),
  'GET /api/agent/bg-output': allow(`${CHAT}: a background shell's output; side-effect free`),
  'GET /api/agent/file': allow(`${CHAT}: a file inside this project: JSON, or (raw=1) media from a fixed type table, an SVG sandboxed. Outside the project the phone reads MEDIA only (raster image, audio, video), decided on the real path: under this project's own linked repos and their worktrees without asking, anywhere else after a one-tap phone grant; a file inside a project not chosen at start is refused. Desktop grants never count here`, 'media'),
  'GET /api/agent/board-assets': allow(`${CHAT}: a board's images inside this project; side-effect free`),
  'POST /api/agent/reveal': deny(DESKTOP),
  'POST /api/agent/grant': deny(DESKTOP),
  // The phone's own one-tap consent for ONE outside media file (task hands-free-phone-shows-every-
  // picture…): held in memory for that device only, never written to the desktop's grant file,
  // and refused for a file inside a project not chosen at start.
  'POST /api/agent/phone-grant': allow(`${CHAT}: the phone allows one media file outside the project for this device only (in memory, ends with its session); other projects refused`),
  'GET /api/agent/loopback-grants': deny(DESKTOP),
  'POST /api/agent/loopback-grant': deny(DESKTOP),
  'POST /api/agent/web-session': deny(DESKTOP),
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
  // A photo or any file from the phone (task hands-free-phone-shows-every-picture…, any type since
  // 2026-10-27): an image is decided by its bytes and named by the server; another file keeps its
  // sanitized basename behind a server prefix, stored as bytes (a zip is never extracted). Placed
  // in the project's gitignored tmp, capped per device in the handler (photo 10 MB, file 25 MB,
  // 2 in flight, 30 a minute, 500 MB of phone files per project).
  'POST /api/agent/drop': allow(`${CHAT}: a photo or file from the phone (stored as bytes, never extracted, in this project's gitignored tmp under a server-chosen prefix; phone caps: photo 10 MB, file 25 MB, 2 in flight, 30/min per device)`),
  'GET /api/notifications': deny(DESKTOP),
  'POST /api/notify': deny(DESKTOP),
  'POST /api/agent/secret': deny(SECRET),
  // The ONE voice route the phone reaches (task the-hands-free-phone-sends-a-voice-message…): its
  // take, recorded on the phone, transcribed by the engine the owner chose on this Mac (local
  // whisper, or OpenRouter when the cloud was chosen, 2026-10-27). Capped per phone socket
  // in the handler (4 MB, 2 minutes by the WAV header, 1 in flight, 12 a minute); the vocabulary
  // that primes whisper is the request project's. Read-aloud, warm, focus and setup stay here.
  'POST /api/agent/voice/stt': allow(`${CHAT}: a voice message from the phone, transcribed by this Mac's chosen dictation engine (phone caps: 4 MB, 2 min, 1 in flight, 12/min)`),
  'POST /api/agent/voice/tts': deny(VOICE),
  'POST /api/agent/voice/warm': deny(VOICE),
  // A chat's agent retranscribes its own take (`dreamcontext voice retry`): a CLI on this Mac,
  // never the phone. The handler refuses the phone socket too.
  'POST /api/agent/voice/retranscribe': deny(VOICE),
  'POST /api/agent/voice/log': deny(VOICE),
  'POST /api/agent/voice/focus': deny(VOICE),
  'GET /api/agent/voice/status': deny(VOICE),
  'GET /api/agent/voice/dictation': deny(VOICE),
  'POST /api/agent/voice/dictation': deny(INSTALL),
  'PUT /api/agent/voice/config': deny(VOICE),
  'POST /api/agent/download': deny(DESKTOP),
  'GET /api/agent/sessions': allow(`${CHAT}: the phone's own tab roster, or (\`?of=desktop\`) the Mac window's chat tabs narrowed to title, id, pane, kind and bypass for seeding; side-effect free`),
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
  // Agent sync (B1): reading the state and the inbox is free; confirming publishes this machine's
  // private agents to the team, so it is decided at the machine itself.
  'GET /api/agents/sync': allow(READ),
  'POST /api/agents/sync/confirm': deny('publishes this machine\'s private agents to the team: confirmed at the machine'),
  'GET /api/agents/inbox': allow(READ),
  'POST /api/agents/inbox/:id': allow('the owner answers a row waiting on this machine (start, ignore, adopt), as on the laptop'),
  'POST /api/agents/:slug/bring-here': deny('moves where an agent runs: decided at the machine that will run it'),
  'GET /api/agents/:slug': allow(READ),
  'POST /api/agents/:slug/update': allow(PROJECT_WRITE),
  'POST /api/agents/:slug/delete': allow(PROJECT_WRITE),
  'POST /api/agents/:slug/approve': allow('the owner approves this project\'s agent, as on the laptop'),
  'POST /api/agents/:slug/place': allow(PROJECT_WRITE),
  'GET /api/agents/:slug/stage': allow('read: an agent\'s stage (its live work, reports, files, routines); side-effect free'),
  'GET /api/agents/:slug/history': allow('read: one page of an agent\'s runs and talks (the stage pane); side-effect free beyond pruning its own machine-local index of glances'),
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
  'POST /api/whiteboards/groups/rename': allow(PROJECT_WRITE),
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
