/**
 * Shared-app verbs of `dreamcontext apps` (paylasilan-app-ler plan r3). Every tool (Claude, Codex,
 * Antigravity) calls these same verbs. An install runs on the owner's tap on its card, in the chat that asks (`apps install --ask`). What else is the OWNER's to decide (an update,
 * making a copy one's own, removing) is a click on the Apps page: the CLI shows the preview and
 * says where the click is. A publish is the owner's Publish click too, but Claude does it: the
 * click hands it a one-hour grant for that app, and `publish --go --grant` spends it.
 */

import type { Command } from 'commander';
import { homedir } from 'node:os';
import { error, info, success } from '../../lib/format.js';
import { AppsClientError, appsApi, requestHeaders, type ProjectRef } from '../../lib/apps/client.js';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { readManifest, type AppManifest, type ConfigField } from '../../lib/apps/manifest.js';
import { readAppFile } from '../../lib/apps/store-facts.js';
import { getApp, updateAppShare, type AppRecord } from '../../lib/apps/registry.js';
import { ConfigError, missingRequired, newConfigId, presentSecretKeys, readAppConfig, setAppConfig } from '../../lib/apps/app-config.js';
import { writeEnvSecrets } from '../../lib/env-secrets.js';
import { resolveAppHost } from '../../lib/apps/share/host.js';
import { buildPublishTree, changedSincePublish, lastPublishedFiles, publishLogin, PublishError } from '../../lib/apps/share/publish.js';
import type { GateReport } from '../../lib/apps/share/gate.js';
import { listShared } from '../../lib/apps/share/shared.js';
import { matchShared, previewInstall, type NameMatch } from '../../lib/apps/share/install.js';
import { parseAppRepoRef } from '../../lib/apps/share/host.js';
import { configSuggestions } from '../../lib/apps/config-suggest.js';
import { publishJob, settingsJob } from '../../lib/apps/share/job.js';
import { parseStoreReadme } from '../../lib/apps/store-readme.js';
import { UNKNOWN_INVITER_TR } from '../../lib/apps/share/inviters.js';
import { checkUpdate } from '../../lib/apps/share/update.js';

interface Helpers {
  project: () => ProjectRef;
  fail: (e: unknown) => never;
}

function appOf(p: ProjectRef, slug: string): { rec: AppRecord; manifest: AppManifest } {
  const rec = getApp(homedir(), p.projectRoot, slug);
  if (!rec) throw new AppsClientError('app_not_found', `No app "${slug}" in this project (dreamcontext apps list).`);
  const m = readManifest(rec.root);
  if (!m.ok) throw new AppsClientError('manifest_invalid', `${slug}: ${m.errors.map((e) => `${e.field}: ${e.problem}`).join('; ')}`);
  return { rec, manifest: m.manifest };
}

/** `changed`: a new version lists only what changed since the last publish (the rest is the same). */
export function printGateReport(r: GateReport, changed?: readonly string[] | null): void {
  console.log(`Would send ${r.send.length} file(s), ${Math.round(r.totalBytes / 1024)} KB${changed ? `, ${changed.length} changed since the last publish` : ''}:`);
  const only = changed ? new Set(changed) : null;
  for (const f of r.send) if (!only || only.has(f.path)) console.log(`  + ${f.path}`);
  if (r.notSent.length) {
    console.log('Not sent:');
    for (const f of r.notSent) console.log(`  - ${f.path} (${f.why})`);
  }
  if (r.blocks.length) {
    console.log('Stops the publish (fix these; nobody can pass them):');
    for (const b of r.blocks) console.log(`  ✗ ${b.file}${b.line ? `:${b.line}` : ''}  ${b.label}`);
  }
  if (r.approvable.length) {
    console.log('Waits for the owner (generic words; `--ask` lists them on his card by word and one Onayla lets them all go):');
    for (const a of r.approvable) console.log(`  ? ${a.file}${a.line ? `:${a.line}` : ''}  ${a.label}: "${a.term}"  [${a.id}]`);
  }
  console.log(r.ok ? 'Gate: clear.' : r.blocks.length ? `Gate: ${r.blocks.length} to fix, ${r.unapproved.length} to approve.` : `Gate: ${r.unapproved.length} line(s) for the owner: \`--ask\` puts them on his card (his Onayla passes them); a --go under his Share click names them with --approve.`);
}

function suggestions(projectRoot: string, f: Pick<ConfigField, 'type' | 'choices'>): string[] {
  return configSuggestions(projectRoot, f);
}

/** An app named by the owner (K3), against what is shared with this account and its invitations. */
type Resolved = { fullName: string; invitation?: { from: string; known: boolean } } | { done: true };

async function resolveAppArg(p: ProjectRef, text: string, json: boolean | undefined): Promise<Resolved> {
  const direct = parseAppRepoRef(text);
  let list: Parameters<typeof matchShared>[1] | null = null;
  try { list = await appsApi(p, 'GET', '/api/apps/shared', undefined, { timeoutMs: 120_000 }) as unknown as Parameters<typeof matchShared>[1]; } catch { list = null; }
  const already = (fullName: string) => list?.shared.find((s) => s.fullName.toLowerCase() === fullName.toLowerCase() && s.installed)?.installed;
  if (direct) {
    const slug = already(direct);
    if (slug) { sayInstalled(slug, json); return { done: true }; }
    const inv = list?.invitations.find((i) => i.fullName.toLowerCase() === direct.toLowerCase());
    return { fullName: direct, ...(inv ? { invitation: { from: inv.inviter, known: inv.known } } : {}) };
  }
  if (!list) throw new AppsClientError('no_shared_list', `Could not read what is shared with you, so "${text}" cannot be found by name. Use its owner/repo, or open Apps → Shared with you.`);
  const hits = matchShared(text, list);
  if (!hits.length) throw new AppsClientError('no_match', `Nothing named "${text}" is shared with you or waiting as an invitation. \`dreamcontext apps shared\` lists what is.`);
  const one = hits.length === 1 ? hits[0]! : null;
  if (one?.installed) { sayInstalled(one.installed, json); return { done: true }; }
  // S2: one match from someone this account works with proceeds; several, or any from an unknown
  // inviter, are listed and open nothing (the owner says which, or installs from Apps).
  if (one && one.known) return { fullName: one.fullName, ...(one.kind === 'invitation' ? { invitation: { from: one.from, known: true } } : {}) };
  process.exitCode = 2;
  if (json) { console.log(JSON.stringify({ error: one ? 'unknown_inviter' : 'several', matches: hits }, null, 2)); return { done: true }; }
  error(one ? `"${text}" is an invitation from ${UNKNOWN_INVITER_TR} (${one.from}): nothing was opened.` : `"${text}" matches ${hits.length} apps: nothing was opened.`);
  for (const m of hits) console.log(`  ${matchLine(m)}`);
  info(one ? 'Tell the owner who invited him and ask whether he knows them. To go on anyway, install it by its owner/repo: his card shows the same warning.' : 'Ask the owner which one, then install it by its owner/repo.');
  return { done: true };
}

function matchLine(m: NameMatch): string {
  return `${m.fullName}  "${m.name}"  ${m.kind === 'invitation' ? `invitation from ${m.from}${m.known ? '' : ` (${UNKNOWN_INVITER_TR})`}` : `shared by ${m.from}`}${m.installed ? `  (installed as ${m.installed})` : ''}`;
}

function sayInstalled(slug: string, json: boolean | undefined): void {
  if (json) { console.log(JSON.stringify({ installed: slug }, null, 2)); return; }
  success(`Already installed as ${slug}: nothing to install.`);
  info(`Its settings: \`dreamcontext apps config ${slug}\`; a newer version: \`dreamcontext apps update ${slug}\`; it opens from its page in Apps.`);
}


/** `--wait` in seconds: default 60, at most 110 (under a tool call's two-minute limit). */
function waitSeconds(raw: string | undefined): number {
  const n = raw === undefined ? 60 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(110, Math.floor(n))) : 60;
}

export interface RequestAnswer { state: string; shown: string[]; failed?: string; stopped?: string; grant?: { id?: string; command?: string; expiresAt?: string } }

/** A grant the agent may still spend: approved, or approved and its last run failed (the hour still holds). */
export const spendable = (a: RequestAnswer): boolean => (a.state === 'approved' || a.state === 'failed') && !!a.grant?.id;

const SURFACE_WORDS: Record<string, string> = { chat: 'in this chat', super: 'on his Super Agent screen', notch: 'on the notch', telegram: 'on his Telegram' };

/**
 * Where the card really is, from the server's own record of the surfaces that DREW it (ek-4,
 * owner 2026-11-13: an agent told him "the card is on your notch" and there was none). Never a
 * guess at where it might be.
 */
export function shownLine(shown: readonly string[]): string {
  const where = shown.map((s) => SURFACE_WORDS[s]).filter(Boolean);
  return where.length
    ? `Shown: the card is drawn ${where.join(' and ')}. Only these places are true to name.`
    : 'Shown: nowhere yet. It is NOT on his screen: never say it is on the notch, Telegram or anywhere else.';
}

/** Waits for the owner's answer to a request; `quiet` leaves an approval's saying to the caller. */
async function waitForOwner(p: ProjectRef, id: string, seconds: number, json: boolean | undefined, quiet: boolean | 'silent' = false): Promise<RequestAnswer> {
  const r = await appsApi(p, 'GET', `/api/apps/requests/${encodeURIComponent(id)}?wait=${seconds}`, undefined, { timeoutMs: (seconds + 20) * 1000, headers: requestHeaders() });
  const answer: RequestAnswer = {
    state: String(r.state ?? 'unknown'),
    shown: Array.isArray(r.shown) ? r.shown.filter((x): x is string => typeof x === 'string') : [],
    ...(typeof r.failed === 'string' ? { failed: r.failed } : {}),
    ...(typeof r.stopped === 'string' ? { stopped: r.stopped } : {}),
    ...(r.grant ? { grant: r.grant as RequestAnswer['grant'] } : {}),
  };
  if (quiet === 'silent' || (quiet && spendable(answer))) return answer;
  if (json) { console.log(JSON.stringify({ request: id, ...r }, null, 2)); return answer; }
  sayAnswer(id, answer);
  return answer;
}

/** What to do next, in so many words. */
export function sayAnswer(id: string, a: RequestAnswer): void {
  const state = a.state;
  if (state === 'approved' && a.grant?.command) {
    success('The owner approved it. Run this once, exactly (the grant is good for one hour):');
    console.log(`  ${a.grant.command}`);
    return;
  }
  if (state === 'pending') {
    info('The card waits for the owner.');
    console.log(shownLine(a.shown));
    console.log(`Wait again with: dreamcontext apps grant ${id} --wait 110`);
    return;
  }
  if (state === 'running') {
    info('It is running now (an install can take a few minutes). Do not run it again.');
    console.log(`Check again with: dreamcontext apps grant ${id} --wait 110`);
    return;
  }
  process.exitCode = 2;
  if (state === 'failed') {
    error(`The last run did not finish: ${a.failed ?? 'no reason given'}.`);
    if (a.grant?.command) {
      info('The owner\'s yes still holds for this hour. Fix what the reason names, then run this once:');
      console.log(`  ${a.grant.command}`);
    }
    return;
  }
  if (state === 'rejected') error('The owner said no. Nothing runs: do not ask again unless something changed.');
  else if (state === 'expired') error('The request or its grant ran out. Run the same --ask command again: the owner sees a card and one tap gives a new hour.');
  else if (state === 'stale') error('The app changed after you asked, so nothing was approved. Run the same --ask command again.');
  else if (state === 'replaced') error('A newer request for the same app and action replaced this one: follow that one.');
  else if (state === 'used' && a.stopped) error(`This grant was used, but only in part: ${a.stopped}. Never run this one again: if a second card opened for that part, follow it; if none did, tell the owner plainly that nothing was installed and why.`);
  else if (state === 'used') error('This grant already ran. It is done: do not run it again.');
  else error('No such request (the app may have restarted). Run the same --ask command again.');
}

/**
 * The card the owner answers IN this chat, with one tap (owner 2026-11-13, app-kurulum-claude):
 * the agent pastes this block as is, so he never has to find the notch or another screen.
 */
export function requestCardBlock(proposalId: string): string {
  return ['```dream-view', JSON.stringify({ type: 'app-request', id: proposalId }), '```'].join('\n');
}

interface Opened { request: string; state: string; renewal?: boolean; proposal?: string; superScreen?: boolean }

/**
 * What the agent does with a waiting card. "Do not paste" only when the server RECORDED the Super
 * screen drawing it, and only for that project's own Super chat (a block there would be the same
 * card twice). Everywhere else, and whenever nothing drew it yet (the phone, an unfocused window,
 * another page), the block goes in the reply: the guidance never says more than the Shown: line.
 */
export function pendingGuidance(o: Pick<Opened, 'proposal' | 'superScreen'>, shown: readonly string[]): string[] {
  if (!o.proposal) return [];
  if (o.superScreen && shown.includes('super')) {
    return ['The card is on his Super Agent screen above your chat (Shown: says so): do not paste a block, it would be the same card twice. Say in one line what it does and why it needs his yes (one tap on Onayla). Never say his word is not enough.'];
  }
  return [
    'Put this card in your reply, as is: it is drawn right there and he approves it with one tap. Say in one line why it needs his yes (it runs code someone else wrote, on his Mac). Never say his word is not enough.',
    requestCardBlock(o.proposal),
  ];
}

/** Opens a request card for the owner (or answers with a grant he already gave for exactly this). */
async function openRequest(p: ProjectRef, body: Record<string, unknown>, json: boolean | undefined): Promise<Opened> {
  const out = await appsApi(p, 'POST', '/api/apps/requests', body, { timeoutMs: 600_000, headers: requestHeaders() });
  const o: Opened = {
    request: String(out.request ?? ''), state: String(out.state ?? ''), renewal: out.renewal === true,
    ...(typeof out.proposal === 'string' ? { proposal: out.proposal } : {}),
    ...(out.superScreen === true ? { superScreen: true } : {}),
  };
  if (json) return o;
  if (o.state === 'approved') info('The owner already approved exactly this, and the grant is still good.');
  return o;
}

/**
 * A pending request: the card block for this chat, the true "where is it", and the next command.
 * The command never blocks here: the card reaches his chat only with the agent's reply.
 */
async function sayPending(p: ProjectRef, o: Opened, json: boolean | undefined): Promise<void> {
  // A beat for the notch, the Super screen (it reads every 2 s) and Telegram to report a card they drew.
  const a = await waitForOwner(p, o.request, 3, json, 'silent');
  if (json) { console.log(JSON.stringify({ ...o, shown: a.shown, card: o.proposal ? requestCardBlock(o.proposal) : null }, null, 2)); return; }
  if (a.state !== 'pending') { sayAnswer(o.request, a); return; }
  if (o.renewal) info('The grant ran out unused: the card asks "Süresi doldu: yeniden onaylıyor musun?".');
  console.log(shownLine(a.shown));
  for (const line of pendingGuidance(o, a.shown)) console.log(line);
  console.log(`After your reply: dreamcontext apps grant ${o.request} --wait 110 (its Shown: line is the only truth about where the card is).`);
}

/** Opens a request card for the owner; an approval (still good) is said at once. */
async function askOwner(p: ProjectRef, body: Record<string, unknown>, _wait: string | undefined, json: boolean | undefined): Promise<void> {
  const o = await openRequest(p, body, json);
  if (o.state === 'approved') { await waitForOwner(p, o.request, 0, json); return; }
  await sayPending(p, o, json);
}

function gateFailure(slug: string, e: unknown): AppsClientError | null {
  if (e instanceof AppsClientError && e.code === 'gate_blocked') return new AppsClientError(e.code, `${e.message} Run \`dreamcontext apps publish ${slug}\` for the report.`);
  return null;
}

/** After an install: the settings are Claude's to fill next, in the same chat. */
export function installedNext(slug: string): string {
  return `Now its settings, in this chat: \`dreamcontext apps config ${slug} --suggest\` lists each one with where to find it. Fill every value you can find on this Mac yourself (\`apps config ${slug} --set key=value\`); a key (secret) goes through a secret card naming "app":"${slug}", never into the chat; ask the owner one plain question only for what you cannot find.`;
}

export function registerAppsShareCommands(apps: Command, h: Helpers): void {
  apps
    .command('publish <slug>')
    .description("Check what a publish would send and what stops it; --ask puts it in front of the owner; --go with the grant his click or Onayla gave you publishes it")
    .option('--public', 'As a public app (strict check: LICENSE and README required; public is for good, and only a grant from the owner\'s "Share publicly" click allows it)')
    .option('--dry-run', 'Only the report (the default; kept for clarity)')
    .option('--repo <name>', 'Repo name (default <slug>-app)')
    .option('--go', 'Publish now (needs --grant)')
    .option('--fresh', "With --go: publish to a NEW repo with today's version only (when the old repo is gone, public, or has history a publish did not make); default name <slug>-public")
    .option('--grant <id>', "The one-hour grant from the owner's Publish click (in the prompt it handed you)")
    .option('--invite <logins...>', 'GitHub usernames to invite (a private app)')
    .option('--approve <ids...>', "With --go under the owner's Share click: generic-word lines he let go (the [id] in the report). Not needed with --ask: its card lists them and his Onayla passes them")
    .option('--note <text>', "What changed, one line (becomes the README's What's new entry and the commit)")
    .option('--tagline <text>', "The store page's one line (README tagline:)")
    .option('--confirm-name <name>', "Not needed with a grant (the owner's \"Share publicly\" click confirms a public app)")
    .option('--ask', 'Ask the owner: a card with exactly what goes (an update of a published app keeps its visibility and invitees); Onayla gives you a one-time grant')
    .option('--wait <seconds>', 'Not used by --ask any more (it never blocks): wait with `apps grant <request> --wait 110` after your reply')
    .option('--no-catalog', "With --ask: keep the app off this project's brain list")
    .option('--json', 'JSON output')
    .action(async (slug: string, opts: { public?: boolean; repo?: string; go?: boolean; fresh?: boolean; grant?: string; invite?: string[]; approve?: string[]; note?: string; tagline?: string; confirmName?: string; ask?: boolean; wait?: string; catalog?: boolean; json?: boolean }) => {
      try {
        const p = h.project();
        const { rec } = appOf(p, slug);
        if (opts.fresh && !opts.go) throw new AppsClientError('fresh_needs_go', "--fresh starts a new repo, so it goes only with --go --grant <id> (the grant of the owner's Share click on the app's page).");
        if (opts.ask) {
          await askOwner(p, {
            action: 'publish', slug, ...(opts.public ? { public: true } : {}),
            invite: (opts.invite ?? []).flatMap((x) => x.split(/[\s,]+/)).filter(Boolean),
            ...(opts.note !== undefined ? { note: opts.note } : {}),
            ...(opts.catalog === false ? { catalog: false } : {}),
          }, opts.wait, opts.json);
          return;
        }
        if (opts.go) {
          if (!opts.grant) throw new AppsClientError('grant_missing', "Publishing needs the grant the owner's Publish click opened (the app's page → Manage → Share). Ask him to press it, then use the --grant in its prompt.");
          const out = await appsApi(p, 'POST', `/api/apps/${encodeURIComponent(slug)}/publish`, {
            grant: opts.grant, visibility: opts.public ? 'public' : 'private',
            ...(opts.repo ? { repoName: opts.repo } : {}),
            ...(opts.fresh ? { fresh: true } : {}),
            invite: (opts.invite ?? []).flatMap((x) => x.split(/[\s,]+/)).filter(Boolean),
            approvals: opts.approve ?? [],
            ...(opts.note !== undefined ? { note: opts.note } : {}),
            ...(opts.tagline !== undefined ? { tagline: opts.tagline } : {}),
            ...(opts.confirmName !== undefined ? { confirmName: opts.confirmName } : {}),
          }, { timeoutMs: 900_000, headers: requestHeaders() });
          if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }
          if (out.pushed) { success(`${slug} is on GitHub: ${String(out.fullName)}`); error(`It went out, but a step after it failed: ${String(out.warning)}. Do not publish again.`); return; }
          success(`${slug} is on GitHub: ${String(out.fullName)} (${Number(out.sent ?? 0)} file(s))`);
          const invited = (out.invited as string[] | undefined) ?? [];
          const failed = (out.inviteFailed as string[] | undefined) ?? [];
          if (invited.length) info(`Invited: ${invited.join(', ')}`);
          if (failed.length) error(`Could not invite: ${failed.join(', ')}`);
          if (out.readmeWrittenBack) info('The README with the new What\'s new entry went back into the app folder and is committed.');
          return;
        }
        let login = 'the-publisher';
        try { login = (await resolveAppHost(homedir()).me()).login; } catch { /* not signed in: the report still runs */ }
        // A published app: its update keeps the visibility it went out with (D12).
        const visibility = rec.publish?.lastSha && rec.publish.public ? 'public' : opts.public ? 'public' : 'private';
        if (rec.publish?.lastSha) login = publishLogin(rec);
        const pv = buildPublishTree(homedir(), rec, { visibility, login, repoName: opts.repo, approvals: opts.approve, note: opts.note, tagline: opts.tagline });
        const last = rec.publish?.lastSha ? lastPublishedFiles(homedir(), rec) : null;
        const changed = last ? changedSincePublish(pv.files, last) : null;
        if (opts.json) { console.log(JSON.stringify({ repoName: pv.repoName, fullName: pv.fullName, license: pv.license, ...(changed ? { changed } : {}), report: pv.report }, null, 2)); return; }
        info(`${pv.manifest.name} → ${pv.fullName ?? `${login}/${pv.repoName}`} (${visibility}, licence ${pv.license})`);
        if (changed && !changed.length) info('Nothing changed since the last publish.');
        printGateReport(pv.report, changed);
        info(rec.publish?.lastSha
          ? `A new version: \`dreamcontext apps publish ${slug} --ask\` (visibility and invitees stay; --note says what changed).`
          : `Ready? \`dreamcontext apps publish ${slug} --ask\` puts it in front of the owner (or --go --grant <id> with the grant his Share click gave you).`);
      } catch (e) {
        if (e instanceof PublishError) h.fail(new AppsClientError(e.code, e.message));
        const g = gateFailure(slug, e);
        if (g) h.fail(g);
        h.fail(e);
      }
    });

  apps
    .command('job <slug>')
    .description("The steps of the job the Apps page handed you for this app: with --grant, the publish its Paylaş click opened; without, its settings after an install")
    .option('--grant <id>', "The publish grant named in the line you were handed")
    .action(async (slug: string, opts: { grant?: string }) => {
      try {
        const p = h.project();
        const { rec, manifest } = appOf(p, slug);
        if (opts.grant) {
          const g = await appsApi(p, 'POST', `/api/apps/${encodeURIComponent(slug)}/publish/grant/check`, { grant: opts.grant }, { headers: requestHeaders() });
          const published = rec.publish?.lastSha ? { fullName: rec.publish.fullName, public: rec.publish.public } : null;
          console.log(publishJob({ slug, name: manifest.name, grant: opts.grant, visibility: g.visibility === 'public' ? 'public' : 'private', published }));
          return;
        }
        if (!manifest.config.length) { info(`${slug} asks for no settings: there is nothing to set up. Tell the owner it is ready to open from its page in Apps.`); return; }
        const values = readAppConfig(homedir(), rec.configId);
        const readme = readAppFile(rec.root, 'README.md', 256 * 1024);
        const about = readme ? parseStoreReadme(readme.toString('utf-8').slice(0, 64 * 1024)).about : null;
        console.log(settingsJob({
          slug, name: manifest.name, about,
          fields: manifest.config.map((f) => ({ key: f.key, type: f.type, label: f.label, required: f.required, ...(f.help ? { help: f.help } : {}), ...(f.find ? { find: f.find } : {}) })),
          missing: missingRequired(manifest.config, values, rec.root),
        }));
      } catch (e) { h.fail(e); }
    });

  apps
    .command('config <slug>')
    .description("Show or fill the app's settings on this Mac (values never go into the app's repo)")
    .option('--suggest', 'List candidates from this project for each setting')
    .option('--set <key=value...>', 'Set settings (not keys: those go through `apps secret`)')
    .option('--json', 'JSON output')
    .action((slug: string, opts: { suggest?: boolean; set?: string[]; json?: boolean }) => {
      try {
        const p = h.project();
        let { rec, manifest } = appOf(p, slug);
        const fields = manifest.config;
        if (opts.set?.length) {
          if (!rec.configId) rec = updateAppShare(homedir(), rec.projectRoot, rec.slug, { configId: newConfigId() }) ?? rec;
          const patch: Record<string, string> = {};
          for (const kv of opts.set) {
            const i = kv.indexOf('=');
            if (i < 1) throw new AppsClientError('bad_set', `"${kv}" is not key=value`);
            patch[kv.slice(0, i)] = kv.slice(i + 1);
          }
          setAppConfig(homedir(), rec.configId!, fields, patch);
          success(`${slug}: ${Object.keys(patch).join(', ')} set`);
        }
        const values = readAppConfig(homedir(), rec.configId);
        const secrets = presentSecretKeys(rec.root);
        const missing = missingRequired(fields, values, rec.root);
        const rows = fields.map((f) => ({
          key: f.key, type: f.type, label: f.label, required: f.required,
          ...(f.help ? { help: f.help } : {}), ...(f.find ? { find: f.find } : {}),
          ...(f.type === 'secret' ? { set: secrets.has(f.key) } : { value: values[f.key] ?? null }),
          ...(opts.suggest ? { candidates: suggestions(rec.projectRoot, f) } : {}),
        }));
        if (opts.json) { console.log(JSON.stringify({ fields: rows, missing }, null, 2)); return; }
        if (!fields.length) { info(`${slug} asks for no settings.`); return; }
        for (const r of rows) {
          const v = 'set' in r ? (r.set ? '(set in .env)' : '(not set: `dreamcontext apps secret ' + slug + ' ' + r.key + '`)') : r.value === null ? '(empty)' : JSON.stringify(r.value);
          console.log(`${r.required ? '*' : ' '} ${r.key} [${r.type}] ${r.label}: ${v}`);
          if ('find' in r && r.find) console.log(`    find it: ${r.find}`);
          if ('candidates' in r && r.candidates && r.candidates.length) console.log(`    candidates: ${r.candidates.slice(0, 20).join(', ')}`);
        }
        // Empty required settings are the normal state right after an install (K9): said, not an error.
        if (missing.length) info(`ℹ still to fill (required): ${missing.join(', ')}. The app opens once they are filled.`);
      } catch (e) {
        if (e instanceof ConfigError) h.fail(new AppsClientError(e.code, e.message));
        h.fail(e);
      }
    });

  apps
    .command('secret <slug> <key>')
    .description("Type a key into the app's own .env on this Mac (hidden input; a terminal only)")
    .action(async (slug: string, key: string) => {
      try {
        const p = h.project();
        const { rec, manifest } = appOf(p, slug);
        if (!manifest.config.some((f) => f.type === 'secret' && f.key === key)) throw new AppsClientError('unknown_key', `${slug} asks for no key named ${key}.`);
        if (!process.stdin.isTTY) throw new AppsClientError('needs_terminal', 'A key is typed by the owner: in a chat, use the secret card; in a terminal, run this yourself.');
        const value = await readHidden(`${key}: `);
        if (!value) throw new AppsClientError('empty', 'Nothing typed.');
        writeEnvSecrets(rec.root, '.env', [{ key, value }]);
        success(`${key} written to ${slug}'s .env (this Mac only)`);
      } catch (e) { h.fail(e); }
    });

  apps
    .command('shared')
    .description('Shared Apps: apps shared with you (and invitations waiting), from the signed-in GitHub account')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const r = await listShared(resolveAppHost(homedir()), { force: true, projectRoot: h.project().projectRoot });
        if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
        for (const i of r.invitations) console.log(`invitation  ${i.fullName}  "${i.title}" from ${i.inviter}${i.known ? '' : ` (${UNKNOWN_INVITER_TR})`}: \`dreamcontext apps install ${i.fullName} --ask\` accepts and installs on his yes`);
        for (const a of r.shared) console.log(`shared      ${a.fullName}  ${a.name ?? ''}${a.installed ? '  (installed)' : ''}`);
        for (const a of r.mine) console.log(`published   ${a.fullName}  ${a.name ?? ''}`);
        if (!r.invitations.length && !r.shared.length && !r.mine.length) info('Nothing in Shared Apps yet.');
      } catch (e) { h.fail(e); }
    });

  apps
    .command('install <app>')
    .description('Install an app shared with you: its name as the owner says it ("Toplantı Notu"), owner/repo or its link. --ask installs it once the owner taps Onayla on its card in this chat (an invitation is accepted by the same yes); no flag = only the preview')
    .option('--preview', 'Only the preview (the default)')
    .option('--ask', 'Install it with the owner\'s yes: a card he answers in this chat with one tap, then the install runs right here')
    .option('--set <key=value...>', 'With --ask: settings to fill at install (never keys)')
    .option('--wait <seconds>', 'Not used by --ask any more (it never blocks): wait with `apps grant <request> --wait 110` after your reply')
    .option('--go', 'Install now (needs --grant)')
    .option('--grant <id>', 'The one-time grant from the owner\'s Onayla')
    .option('--json', 'JSON output')
    .action(async (app: string, opts: { ask?: boolean; set?: string[]; wait?: string; go?: boolean; grant?: string; json?: boolean }) => {
      try {
        const p = h.project();
        let repo = app;
        let invitation: { from: string; known: boolean } | undefined;
        if (!opts.go) {
          const r = await resolveAppArg(p, app, opts.json);
          if ('done' in r) return;
          repo = r.fullName;
          invitation = r.invitation;
        }
        const spend = async (grant: string) => {
          const out = await appsApi(p, 'POST', '/api/apps/install', { grant, ref: repo }, { timeoutMs: 900_000, headers: requestHeaders() });
          if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }
          if (out.needsLook) {
            // K2: the invitation is accepted; its content holds something on the warn list.
            info(`The invitation is accepted, but nothing was installed: ${(out.warn as string[] | undefined ?? []).join('; ')}. That needs its own look.`);
            await sayPending(p, { request: String(out.request ?? ''), state: String(out.state ?? ''), ...(typeof out.proposal === 'string' ? { proposal: out.proposal } : {}) }, opts.json);
            return;
          }
          const slug = String(out.slug);
          success(`Installed as ${slug}${out.renamed ? ' (renamed: that name was taken)' : ''}.`);
          info(installedNext(slug));
        };
        if (opts.ask) {
          const config: Record<string, string> = {};
          for (const kv of opts.set ?? []) {
            const i = kv.indexOf('=');
            if (i < 1) throw new AppsClientError('bad_set', `"${kv}" is not key=value`);
            config[kv.slice(0, i)] = kv.slice(i + 1);
          }
          const o = await openRequest(p, { action: 'install', ref: repo, config }, opts.json);
          // Approved (a grant still good for exactly this): the install runs here, now.
          if (o.state !== 'approved') { await sayPending(p, o, opts.json); return; }
          const a = await waitForOwner(p, o.request, 0, opts.json, true);
          // Not spendable: waitForOwner already said why (running, used, expired…).
          if (spendable(a)) await spend(a.grant!.id!);
          return;
        }
        if (opts.go) {
          if (!opts.grant) throw new AppsClientError('grant_missing', `Installing needs the owner's yes: \`dreamcontext apps install ${repo} --ask\`.`);
          await spend(opts.grant);
          return;
        }
        if (invitation) {
          // A pending invitation cannot be read before it is accepted (K2): the card does both.
          if (opts.json) { console.log(JSON.stringify({ invitation: { fullName: repo, ...invitation } }, null, 2)); return; }
          info(`${repo} is an invitation from ${invitation.from}${invitation.known ? '' : ` (${UNKNOWN_INVITER_TR})`}, not accepted yet: its content can be read only after he says yes.`);
          info(`Install it: \`dreamcontext apps install ${repo} --ask\`: one card; his yes accepts the invitation, checks the content and installs (anything risky stops for a second card).`);
          return;
        }
        const pv = await previewInstall({ home: homedir(), projectRoot: p.projectRoot, ref: repo });
        if (opts.json) { console.log(JSON.stringify(pv, null, 2)); return; }
        info(`${pv.name} by ${pv.publisher} (${pv.fullName}, ${pv.public ? 'public' : 'private'}, licence ${pv.license})`);
        console.log(`  ${pv.warning}`);
        console.log(`  runs: ${pv.facts.backend ?? 'no backend (a page only)'}${pv.facts.build ? `; build: ${pv.facts.build}` : ''}`);
        if (pv.facts.mcp.length) console.log(`  MCP servers: ${pv.facts.mcp.join(', ')}`);
        if (pv.facts.schedules) console.log(`  schedules: ${pv.facts.schedules}`);
        if (pv.facts.dependencies) console.log(`  npm dependencies: ${pv.facts.dependencies}`);
        if (pv.facts.urls.length) console.log(`  addresses in its code: ${pv.facts.urls.slice(0, 10).join(', ')}`);
        if (pv.config.length) console.log(`  settings: ${pv.config.map((c) => `${c.key}${c.type === 'secret' ? ' (key)' : ''}`).join(', ')}`);
        if (!pv.gate.ok) error(`it cannot be installed: ${pv.gate.blocks.map((b) => `${b.file} (${b.label})`).join('; ')}`);
        info(`Install it: \`dreamcontext apps install ${pv.fullName} --ask\` (his card, in this chat, one tap).`);
      } catch (e) { h.fail(e); }
    });

  apps
    .command('update <slug>')
    .description('Check an installed app for an update; --ask puts applying it in front of the owner, --apply with his grant applies it')
    .option('--check', 'Check now (the default)')
    .option('--ask', 'Ask the owner: a card with the new version, every permission change and what your changes risk; Onayla gives you a one-time grant')
    .option('--how <how>', 'With --ask, for a copy with its own changes: merge, or set-aside (kept aside in a patch)')
    .option('--wait <seconds>', 'Not used by --ask any more (it never blocks): wait with `apps grant <request> --wait 110` after your reply')
    .option('--apply', 'Apply now (needs --grant)')
    .option('--grant <id>', 'The one-time grant from the owner\'s Onayla')
    .option('--json', 'JSON output')
    .action(async (slug: string, opts: { ask?: boolean; how?: string; wait?: string; apply?: boolean; grant?: string; json?: boolean }) => {
      try {
        const p = h.project();
        const { rec } = appOf(p, slug);
        if (opts.ask) {
          if (opts.how !== undefined && opts.how !== 'merge' && opts.how !== 'set-aside') throw new AppsClientError('bad_how', '--how is merge or set-aside.');
          await askOwner(p, { action: 'update', slug, ...(opts.how ? { how: opts.how } : {}) }, opts.wait, opts.json);
          return;
        }
        if (opts.apply) {
          if (!opts.grant) throw new AppsClientError('grant_missing', `Applying needs the owner's yes: \`dreamcontext apps update ${slug} --ask\`, then the command his Onayla gives you.`);
          const out = await appsApi(p, 'POST', `/api/apps/${encodeURIComponent(slug)}/update`, { grant: opts.grant }, { timeoutMs: 900_000, headers: requestHeaders() });
          if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }
          success(`${slug} is updated to ${String(out.sha ?? '').slice(0, 7)}. Undo is on its Apps page.`);
          if (out.patch) info(`Your changes are kept aside in ${String(out.patch)}.`);
          if (out.depsFailed) error(`Its dependencies did not install: ${String(out.depsFailed)}`);
          return;
        }
        const r = await checkUpdate(homedir(), rec);
        if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
        if (r.state === 'none') success(`${slug} is up to date.`);
        else if (r.state === 'available') { info(`${slug}: an update is there (${r.sha.slice(0, 7)})${r.manifestChanged ? ', and it changes what the app may do: the owner approves it again' : ''}${r.edited ? '; you changed this copy, so ask with --how merge or --how set-aside' : ''}.`); for (const n of r.notes) console.log(`  · ${n}`); info(`Apply it with the owner's yes: \`dreamcontext apps update ${slug} --ask\` (or his click on the Apps page).`); }
        else error(`${slug}: ${r.message}`);
      } catch (e) { h.fail(e); }
    });

  apps
    .command('logo <slug> [file]')
    .description("Ask the owner to make a PNG or JPEG this app's logo on this Mac (--ask); --grant with his grant sets it")
    .option('--ask', 'Ask the owner: a card with the picture itself; Onayla gives you a one-time grant')
    .option('--wait <seconds>', 'Not used by --ask any more (it never blocks): wait with `apps grant <request> --wait 110` after your reply')
    .option('--grant <id>', 'The one-time grant from the owner\'s Onayla: sets exactly the picture he saw')
    .option('--json', 'JSON output')
    .action(async (slug: string, file: string | undefined, opts: { ask?: boolean; wait?: string; grant?: string; json?: boolean }) => {
      try {
        const p = h.project();
        appOf(p, slug);
        if (opts.grant) {
          const out = await appsApi(p, 'POST', `/api/apps/${encodeURIComponent(slug)}/logo`, undefined, { headers: { ...requestHeaders(), 'x-dc-grant': opts.grant } });
          if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }
          success(`${slug} has its new logo on this Mac. The Dock shows it the next time the app is closed and opened.`);
          return;
        }
        if (!opts.ask || !file) throw new AppsClientError('usage', `Ask the owner first: \`dreamcontext apps logo ${slug} <file.png> --ask\`.`);
        await askOwner(p, { action: 'logo', slug, logoPath: isAbsolute(file) ? file : resolvePath(process.cwd(), file) }, opts.wait, opts.json);
      } catch (e) { h.fail(e); }
    });

  apps
    .command('grant <request>')
    .description('Wait for the owner\'s answer to a request you made with --ask; after his Onayla, prints the one command to run')
    .option('--wait <seconds>', 'Wait this long for the owner (default 60, at most 110)')
    .option('--json', 'JSON output')
    .action(async (request: string, opts: { wait?: string; json?: boolean }) => {
      try {
        await waitForOwner(h.project(), request, waitSeconds(opts.wait), opts.json);
      } catch (e) { h.fail(e); }
    });

  for (const [verb, what] of [['detach', 'Make your own copy (no more updates from the original)'], ['uninstall', 'Remove an installed app (to the trash, restorable)']] as const) {
    apps
      .command(`${verb} <slug>`)
      .description(`${what}: the owner's click on the Apps page`)
      .action((slug: string) => {
        try {
          const p = h.project();
          const { rec } = appOf(p, slug);
          if (rec.origin !== 'installed') throw new AppsClientError('not_installed', `${slug} is your own app.`);
          info(`${verb === 'detach' ? 'Making your own copy' : 'Removing'} is the owner's click: Apps page → ${rec.name} → ${verb === 'detach' ? 'Make it my own copy' : 'Uninstall'}.`);
        } catch (e) { h.fail(e); }
      });
  }
}

async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf-8');
  return new Promise((resolve) => {
    let v = '';
    const on = (c: string) => {
      for (const ch of c) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode?.(false); stdin.pause(); stdin.removeListener('data', on); process.stdout.write('\n'); resolve(v); return; }
        if (ch === '\u0003') { stdin.setRawMode?.(false); process.exit(130); }
        if (ch === '\u007f') v = v.slice(0, -1); else v += ch;
      }
    };
    stdin.on('data', on);
  });
}
