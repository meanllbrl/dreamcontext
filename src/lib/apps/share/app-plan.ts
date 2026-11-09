/**
 * The action plan of each request kind (app-onay-karti plan r3, D5): built from the server's own
 * reads plus the agent's inputs. Whatever the server can derive it derives (an update's manifest
 * approval, an install's preview, a publish's tree digest); every input that changes behaviour or
 * waives a protection becomes a card line. Card words are Turkish and the server's; an agent's
 * words (a note, a repo name, a login, a config value) only ever sit in a line's value (D6).
 *
 * Each builder also returns `stillFresh`: the plan's bound fact rebuilt, checked at Onayla.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { AppRecord } from '../registry.js';
import { getApp } from '../registry.js';
import { cleanText } from '../manifest.js';
import { parseStoreReadme } from '../store-readme.js';
import { readCatalog } from '../catalog.js';
import { readAgentLogoFile } from '../app-logo.js';
import type { AppHost } from './host.js';
import { buildPublishTree, changedSincePublish, defaultPublishNote, lastPublishedFiles, publishDate, PublishError } from './publish.js';
import { InstallError, previewInstall, previewStillThere } from './install.js';
import { checkUpdate, localUpdateFacts } from './update.js';
import { AppRequestError, type ActionPlan } from './app-request.js';
import type { AppCardLine } from '../../assistant/proposals.js';

export interface BuiltPlan {
  plan: ActionPlan;
  stillFresh: () => Promise<boolean>;
  logo?: Buffer;
}

export interface PlanContext {
  home: string;
  vault: string;
  contextRoot: string;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const v = (s: string, max = 200) => cleanText(s, max);

/** A list as one line value: the first few, then "+N daha". */
function listValue(items: readonly string[], first = 8): string {
  const shown = items.slice(0, first).map((x) => v(x, 120));
  return items.length > first ? `${shown.join(', ')} +${items.length - first} daha` : shown.join(', ');
}

function ownApp(rec: AppRecord): boolean {
  return !(rec.origin === 'installed' && (rec.source || !rec.provenance));
}

// ─── Publish ────────────────────────────────────────────────────────────────────────

export interface PublishInput {
  public?: boolean;
  invite?: string[];
  approve?: string[];
  note?: string;
  catalog?: boolean;
}

export async function buildPublishPlan(ctx: PlanContext & { host: AppHost }, rec: AppRecord, input: PublishInput): Promise<BuiltPlan> {
  if (!ownApp(rec)) throw new PublishError('not_yours', 'This app was installed from someone else. Make it your own copy first.');
  const login = (await ctx.host.me()).login;
  const prev = rec.publish?.lastSha ? rec.publish : undefined;
  const visibility = prev?.public || input.public ? 'public' : 'private';
  const approvals = [...new Set((input.approve ?? []).filter((x) => typeof x === 'string' && x.length <= 200))].slice(0, 50);
  const invite = visibility === 'private' ? [...new Set((input.invite ?? []).flatMap((x) => String(x).split(/[\s,]+/)).map((x) => x.trim().replace(/^@/, '')).filter((x) => LOGIN_RE.test(x) && x !== login))].slice(0, 20) : [];
  const date = publishDate();
  const last = prev ? lastPublishedFiles(ctx.home, rec) : null;

  // First the tree as it is, no note: what is new since the last publish, and the README's draft.
  const bare = buildPublishTree(ctx.home, rec, { visibility, login, approvals, date });
  if (last && changedSincePublish(bare.files, last).length === 0) throw new AppRequestError('not_ready', 'Nothing changed since the last publish: there is no new version to ask for.');
  const agentNote = typeof input.note === 'string' ? v(input.note, 300) : '';
  const fallback = !agentNote && prev ? defaultPublishNote(rec, bare.sourceReadme, last) : null;
  // A draft the README already holds is shown, never written twice (D12).
  const note = agentNote || (fallback && !fallback.draft ? fallback.text : '') || null;
  const shownNote = agentNote || fallback?.text || '';
  const pv = note ? buildPublishTree(ctx.home, rec, { visibility, login, approvals, note, date }) : bare;
  if (!pv.report.ok) throw new PublishError('gate_blocked', pv.report.blocks.length ? `${pv.report.blocks.length} problem(s) must be fixed before publishing.` : `${pv.report.unapproved.length} line(s) wait for the owner's approval: name each with --approve, the card lists them.`, pv.report);

  const catalog = input.catalog === false ? false : input.catalog === true ? true : prev ? readCatalog(ctx.contextRoot).some((e) => e.slug === rec.slug) : true;
  const target = pv.fullName ?? `${login}/${pv.repoName}`;
  const readme = (pv.storeReadme ?? pv.sourceReadme?.toString('utf-8')) ?? '';
  const version = parseStoreReadme(readme, { full: true }).whatsNew[0]?.version ?? null;
  const turningPublic = visibility === 'public' && !!prev && !prev.public;

  const lines: AppCardLine[] = [
    { label: 'Nereye', value: v(target) },
    { label: 'Görünürlük', value: visibility === 'public' ? 'Herkese açık' : 'Yalnız davet ettiklerin', ...(visibility === 'public' ? { tone: 'bad' as const } : {}) },
  ];
  if (version) lines.push({ label: 'Sürüm', value: v(version, 40) });
  if (last) {
    const changed = changedSincePublish(pv.files, last);
    lines.push({ label: 'Değişen dosyalar', value: changed.length ? listValue(changed) : 'yok' });
  } else {
    lines.push({ label: 'Gidecek dosyalar', value: `${pv.files.length} dosya` });
  }
  if (shownNote) lines.push({ label: 'Ne değişti', value: v(shownNote, 300) });
  if (invite.length) lines.push({ label: 'Davet', value: listValue(invite) });
  const waived = pv.report.approvable.filter((a) => approvals.includes(a.id));
  for (const a of waived) lines.push({ label: 'Geçirilecek', value: `${v(a.label, 80)}: ${v(a.file, 120)}${a.line ? `:${a.line}` : ''} "${v(a.term ?? '', 60)}"`, tone: 'warn' });
  lines.push({ label: 'Beyin listesi', value: catalog ? 'Listelenir' : 'Listelenmez' });

  const plan: ActionPlan = {
    vault: ctx.vault, projectRoot: rec.projectRoot, key: rec.slug, appName: v(rec.name, 80),
    title: !prev ? (visibility === 'public' ? 'Herkese açık yayınla' : 'Yayınla') : turningPublic ? 'Herkese açık yayınla' : 'Yeni sürümü yayınla',
    lines,
    ...(visibility === 'public' ? { warn: 'Herkese açık yayın geri alınamaz.' } : {}),
    body: { action: 'publish', slug: rec.slug, visibility, target: v(target), repoName: prev ? null : pv.repoName, invite, approvals, note, catalog, digest: pv.digest, date, login },
  };
  const stillFresh = async () => {
    const now = getApp(ctx.home, rec.projectRoot, rec.slug);
    if (!now) return false;
    const again = buildPublishTree(ctx.home, now, { visibility, login, approvals, note: note ?? undefined, date });
    return again.report.ok && again.digest === pv.digest;
  };
  return { plan, stillFresh };
}

// ─── Update ─────────────────────────────────────────────────────────────────────────

export async function buildUpdatePlan(ctx: PlanContext, rec: AppRecord, input: { how?: 'merge' | 'set-aside' }): Promise<BuiltPlan> {
  if (rec.origin !== 'installed' || !rec.source || rec.source.mode !== 'following') throw new AppRequestError('not_ready', 'This app does not follow an original: there is no update to apply.');
  const c = await checkUpdate(ctx.home, rec);
  if (c.state === 'none') throw new AppRequestError('not_ready', `${rec.slug} is up to date.`);
  if (c.state === 'problem') throw new AppRequestError('not_ready', c.message);
  const f = localUpdateFacts(ctx.home, rec, c.sha);
  if (!f) throw new AppRequestError('not_ready', 'The update moved while it was read; ask again.');
  const how = f.edited ? input.how ?? null : null;
  if (f.edited && !how) throw new AppRequestError('not_ready', `This copy has its own changes (${f.edited.files.length} file(s)): ask with --how merge (bring the update in beside them) or --how set-aside (keep them aside in a patch).`);
  const lines: AppCardLine[] = [
    { label: 'Kaynak', value: v(rec.source.fullName) },
    { label: 'Yeni sürüm', value: c.sha.slice(0, 7) },
  ];
  if (f.notes.length) lines.push({ label: 'Notlar', value: v(f.notes.slice(0, 5).join('; '), 300) });
  for (const m of f.manifestChanges) lines.push({ label: 'İzin değişikliği', value: v(m, 80), tone: 'warn' });
  if (f.edited) {
    lines.push({ label: 'Senin değişikliklerin', value: listValue(f.edited.files) });
    lines.push({ label: 'Nasıl', value: how === 'merge' ? 'Birleştir' : 'Değişikliklerin kenara alınır, güncellenir' });
    if (how === 'merge' && f.wouldLose.length) lines.push({ label: 'Çakışabilir', value: listValue(f.wouldLose), tone: 'warn' });
    if (how === 'set-aside') lines.push({ label: 'Kenara alınacak', value: listValue(f.edited.files), tone: 'warn' });
  }
  lines.push({ label: 'Geri alma', value: 'Önce geri alma noktası bırakır' });
  const facts = (x: NonNullable<ReturnType<typeof localUpdateFacts>>) => JSON.stringify([x.manifestChanges, x.edited?.files ?? [], x.edited?.commits ?? 0, x.wouldLose]);
  const bound = facts(f);
  const plan: ActionPlan = {
    vault: ctx.vault, projectRoot: rec.projectRoot, key: rec.slug, appName: v(rec.name, 80),
    title: 'Güncellemeyi uygula', lines,
    ...(f.manifestChanges.length ? { warn: 'Bu güncelleme app\'in yapabileceklerini değiştiriyor.' } : {}),
    body: { action: 'update', slug: rec.slug, sha: c.sha, how, approveManifest: f.manifestChanges.length > 0, manifestChanges: f.manifestChanges, edited: f.edited?.files ?? [], wouldLose: f.wouldLose },
  };
  const stillFresh = async () => {
    const again = localUpdateFacts(ctx.home, rec, c.sha);
    return !!again && facts(again) === bound;
  };
  return { plan, stillFresh };
}

/** The spend's check: the update's facts are still the ones the card showed. */
export function updateStillBound(home: string, rec: AppRecord, body: Extract<ActionPlan['body'], { action: 'update' }>): boolean {
  const f = localUpdateFacts(home, rec, body.sha);
  if (!f) return false;
  return JSON.stringify([f.manifestChanges, f.edited?.files ?? [], f.wouldLose]) === JSON.stringify([body.manifestChanges, body.edited, body.wouldLose]);
}

// ─── Install ────────────────────────────────────────────────────────────────────────

export async function buildInstallPlan(ctx: PlanContext & { projectRoot: string }, ref: string, input: { config?: Record<string, unknown> }): Promise<BuiltPlan> {
  const pv = await previewInstall({ home: ctx.home, projectRoot: ctx.projectRoot, ref });
  if (!pv.gate.ok) throw new InstallError('gate_blocked', `This app holds something an app may not: ${pv.gate.blocks.map((b) => `${b.file} (${b.label})`).slice(0, 5).join('; ')}.`);
  const allowed = new Set(pv.config.filter((f) => f.type !== 'secret').map((f) => f.key));
  const config: Record<string, string> = {};
  for (const [k, val] of Object.entries(input.config ?? {})) if (allowed.has(k) && typeof val === 'string') config[k] = v(val, 200);
  const f = pv.facts;
  const lines: AppCardLine[] = [
    { label: 'Yazan', value: `${v(pv.publisher, 60)}${pv.publisherSince ? ` (GitHub'da ${pv.publisherSince.slice(0, 4)} yılından beri)` : ''}` },
    { label: 'Repo', value: v(pv.fullName) },
    { label: 'Repo türü', value: pv.public ? 'Herkese açık' : 'Özel' },
    { label: 'Lisans', value: v(pv.license, 40) },
    { label: 'Çalıştırır', value: f.backend ? v(f.backend, 120) : 'Arka uç yok (yalnız sayfa)' },
  ];
  if (f.build) lines.push({ label: 'Derleme', value: v(f.build, 120) });
  if (f.mcp.length) lines.push({ label: 'MCP sunucuları', value: listValue(f.mcp), tone: 'warn' });
  if (f.schedules) lines.push({ label: 'Zamanlanmış iş', value: String(f.schedules) });
  if (f.dependencies) lines.push({ label: 'npm bağımlılığı', value: String(f.dependencies) });
  if (f.urls.length) lines.push({ label: 'Kodundaki adresler', value: listValue(f.urls, 6) });
  for (const [k, val] of Object.entries(config)) lines.push({ label: `Ayar: ${v(k, 40)}`, value: val });
  const secrets = pv.config.filter((c) => c.type === 'secret').map((c) => c.key);
  if (secrets.length) lines.push({ label: 'Anahtarlar', value: `${listValue(secrets)} (sonra sen girersin)` });
  const plan: ActionPlan = {
    vault: ctx.vault, projectRoot: ctx.projectRoot, key: pv.fullName.toLowerCase(), appName: v(pv.name, 80),
    title: 'Kur', lines,
    warn: 'Bu app senin Mac\'inde senin izinlerinle çalışır.',
    body: { action: 'install', fullName: pv.fullName, previewId: pv.previewId, sha: pv.sha, config },
  };
  return { plan, stillFresh: async () => previewStillThere(ctx.home, pv.previewId, pv.sha) };
}

// ─── Logo ───────────────────────────────────────────────────────────────────────────

/** `ownAppOnly`: an app's own assistant asks; its own folder is the only root (D15). */
export function buildLogoPlan(ctx: PlanContext, rec: AppRecord, path: string, opts: { ownAppOnly: boolean }): BuiltPlan {
  const roots = opts.ownAppOnly ? [rec.root] : [rec.root, rec.projectRoot];
  const img = readAgentLogoFile(path, roots);
  const sha256 = createHash('sha256').update(img.data).digest('hex');
  const plan: ActionPlan = {
    vault: ctx.vault, projectRoot: rec.projectRoot, key: rec.slug, appName: v(rec.name, 80),
    title: 'Logoyu değiştir',
    lines: [
      { label: 'Dosya', value: v(basename(path), 120) },
      { label: 'Boyut', value: `${Math.max(1, Math.round(img.data.length / 1024))} KB, ${img.type === 'image/png' ? 'PNG' : 'JPEG'}` },
      { label: 'Nerede', value: 'Yalnız bu Mac\'te; app\'in kendi dosyalarına dokunmaz' },
    ],
    body: { action: 'logo', slug: rec.slug, sha256, type: img.type },
  };
  return { plan, stillFresh: async () => true, logo: img.data };
}
