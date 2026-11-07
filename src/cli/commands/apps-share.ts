/**
 * Shared-app verbs of `dreamcontext apps` (paylasilan-app-ler plan r3). Every tool (Claude, Codex,
 * Antigravity) calls these same verbs. What is the OWNER's to decide (an install, an update,
 * making a copy one's own, removing) is a click on the Apps page: the CLI shows the preview and
 * says where the click is. A publish is the owner's Publish click too, but Claude does it: the
 * click hands it a one-hour grant for that app, and `publish --go --grant` spends it.
 */

import type { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { error, info, success } from '../../lib/format.js';
import { AppsClientError, appsApi, type ProjectRef } from '../../lib/apps/client.js';
import { readManifest, type AppManifest, type ConfigField } from '../../lib/apps/manifest.js';
import { getApp, updateAppShare, type AppRecord } from '../../lib/apps/registry.js';
import { ConfigError, missingRequired, newConfigId, presentSecretKeys, readAppConfig, setAppConfig } from '../../lib/apps/app-config.js';
import { writeEnvSecrets } from '../../lib/env-secrets.js';
import { resolveAppHost } from '../../lib/apps/share/host.js';
import { buildPublishTree, PublishError } from '../../lib/apps/share/publish.js';
import type { GateReport } from '../../lib/apps/share/gate.js';
import { listShared } from '../../lib/apps/share/shared.js';
import { previewInstall } from '../../lib/apps/share/install.js';
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

export function printGateReport(r: GateReport): void {
  console.log(`Would send ${r.send.length} file(s), ${Math.round(r.totalBytes / 1024)} KB:`);
  for (const f of r.send) console.log(`  + ${f.path}`);
  if (r.notSent.length) {
    console.log('Not sent:');
    for (const f of r.notSent) console.log(`  - ${f.path} (${f.why})`);
  }
  if (r.blocks.length) {
    console.log('Stops the publish (fix these; nobody can pass them):');
    for (const b of r.blocks) console.log(`  ✗ ${b.file}${b.line ? `:${b.line}` : ''}  ${b.label}`);
  }
  if (r.approvable.length) {
    console.log('Waits for the owner, line by line ("a generic word, let it go"):');
    for (const a of r.approvable) console.log(`  ? ${a.file}${a.line ? `:${a.line}` : ''}  ${a.label}: "${a.term}"  [${a.id}]`);
  }
  console.log(r.ok ? 'Gate: clear.' : `Gate: ${r.blocks.length} to fix, ${r.unapproved.length} to approve.`);
}

function suggestions(projectRoot: string, type: ConfigField['type']): string[] {
  const ctx = join(projectRoot, '_dream_context');
  const ls = (dir: string, ext?: string) => { try { return readdirSync(dir).filter((f) => !f.startsWith('.') && (!ext || f.endsWith(ext))).map((f) => (ext ? f.slice(0, -ext.length) : f.replace(/\.md$/, ''))); } catch { return []; } };
  if (type === 'insight') return ls(join(ctx, 'lab', 'insights'), '.md');
  if (type === 'objective') return ls(join(ctx, 'core', 'objectives'), '.md');
  if (type === 'agent') return ls(join(ctx, 'agents'));
  return [];
}

export function registerAppsShareCommands(apps: Command, h: Helpers): void {
  apps
    .command('publish <slug>')
    .description("Check what a publish would send and what stops it; with --go and the grant the owner's Publish click gave you, publish it")
    .option('--public', 'As a public app (strict check: LICENSE and README required; public is for good, and only a grant from the owner\'s "Share publicly" click allows it)')
    .option('--dry-run', 'Only the report (the default; kept for clarity)')
    .option('--repo <name>', 'Repo name (default <slug>-app)')
    .option('--go', 'Publish now (needs --grant)')
    .option('--grant <id>', "The one-hour grant from the owner's Publish click (in the prompt it handed you)")
    .option('--invite <logins...>', 'GitHub usernames to invite (a private app)')
    .option('--approve <ids...>', 'Generic-word lines the owner let go in the chat (the [id] in the report)')
    .option('--note <text>', "What changed, one line (becomes the README's What's new entry and the commit)")
    .option('--tagline <text>', "The store page's one line (README tagline:)")
    .option('--confirm-name <name>', "Not needed with a grant (the owner's \"Share publicly\" click confirms a public app)")
    .option('--json', 'JSON output')
    .action(async (slug: string, opts: { public?: boolean; repo?: string; go?: boolean; grant?: string; invite?: string[]; approve?: string[]; note?: string; tagline?: string; confirmName?: string; json?: boolean }) => {
      try {
        const p = h.project();
        const { rec } = appOf(p, slug);
        if (opts.go) {
          if (!opts.grant) throw new AppsClientError('grant_missing', "Publishing needs the grant the owner's Publish click opened (the app's page → Manage → Share). Ask him to press it, then use the --grant in its prompt.");
          const out = await appsApi(p, 'POST', `/api/apps/${encodeURIComponent(slug)}/publish`, {
            grant: opts.grant, visibility: opts.public ? 'public' : 'private',
            ...(opts.repo ? { repoName: opts.repo } : {}),
            invite: (opts.invite ?? []).flatMap((x) => x.split(/[\s,]+/)).filter(Boolean),
            approvals: opts.approve ?? [],
            ...(opts.note !== undefined ? { note: opts.note } : {}),
            ...(opts.tagline !== undefined ? { tagline: opts.tagline } : {}),
            ...(opts.confirmName !== undefined ? { confirmName: opts.confirmName } : {}),
          }, { timeoutMs: 900_000 });
          if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }
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
        const pv = buildPublishTree(homedir(), rec, { visibility: opts.public ? 'public' : 'private', login, repoName: opts.repo, approvals: opts.approve, note: opts.note, tagline: opts.tagline });
        if (opts.json) { console.log(JSON.stringify({ repoName: pv.repoName, fullName: pv.fullName, license: pv.license, report: pv.report }, null, 2)); return; }
        info(`${pv.manifest.name} → ${pv.fullName ?? `${login}/${pv.repoName}`} (${opts.public ? 'public' : 'private'}, licence ${pv.license})`);
        printGateReport(pv.report);
        info("Publishing: --go --grant <id> (the grant comes with the owner's Publish click).");
      } catch (e) {
        if (e instanceof PublishError) h.fail(new AppsClientError(e.code, e.message));
        if (e instanceof AppsClientError && e.code === 'gate_blocked') h.fail(new AppsClientError(e.code, `${e.message} Run \`dreamcontext apps publish ${slug}\` for the report.`));
        h.fail(e);
      }
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
          ...(f.type === 'secret' ? { set: secrets.has(f.key) } : { value: values[f.key] ?? null }),
          ...(opts.suggest ? { candidates: suggestions(rec.projectRoot, f.type) } : {}),
        }));
        if (opts.json) { console.log(JSON.stringify({ fields: rows, missing }, null, 2)); return; }
        if (!fields.length) { info(`${slug} asks for no settings.`); return; }
        for (const r of rows) {
          const v = 'set' in r ? (r.set ? '(set in .env)' : '(not set: `dreamcontext apps secret ' + slug + ' ' + r.key + '`)') : r.value === null ? '(empty)' : JSON.stringify(r.value);
          console.log(`${r.required ? '*' : ' '} ${r.key} [${r.type}] ${r.label}: ${v}`);
          if ('candidates' in r && r.candidates && r.candidates.length) console.log(`    candidates: ${r.candidates.slice(0, 20).join(', ')}`);
        }
        if (missing.length) error(`required and empty: ${missing.join(', ')} (the app does not start until they are filled)`);
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
        const r = await listShared(resolveAppHost(homedir()), { force: true });
        if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
        for (const i of r.invitations) console.log(`invitation  ${i.fullName} from ${i.inviter} (accept on the Apps page)`);
        for (const a of r.shared) console.log(`shared      ${a.fullName}  ${a.name ?? ''}${a.installed ? '  (installed)' : ''}`);
        for (const a of r.mine) console.log(`published   ${a.fullName}  ${a.name ?? ''}`);
        if (!r.invitations.length && !r.shared.length && !r.mine.length) info('Nothing in Shared Apps yet.');
      } catch (e) { h.fail(e); }
    });

  apps
    .command('install <repo>')
    .description('Preview an app from a repo (owner/repo or its link) before the owner installs it on the Apps page')
    .option('--preview', 'Only the preview (the default: the install is the owner\'s click)')
    .option('--json', 'JSON output')
    .action(async (repo: string, opts: { json?: boolean }) => {
      try {
        const p = h.project();
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
        info('Installing is the owner\'s click: Apps page → Shared Apps, or "Install from a link".');
      } catch (e) { h.fail(e); }
    });

  apps
    .command('update <slug>')
    .description('Check an installed app for an update (applying it is the owner\'s click)')
    .option('--check', 'Check now (the default)')
    .option('--json', 'JSON output')
    .action(async (slug: string, opts: { json?: boolean }) => {
      try {
        const p = h.project();
        const { rec } = appOf(p, slug);
        const r = await checkUpdate(homedir(), rec);
        if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
        if (r.state === 'none') success(`${slug} is up to date.`);
        else if (r.state === 'available') { info(`${slug}: an update is there (${r.sha.slice(0, 7)})${r.manifestChanged ? ', and it changes what the app may do: the owner approves it again' : ''}${r.edited ? '; you changed this copy, so it will ask how to apply it' : ''}.`); for (const n of r.notes) console.log(`  · ${n}`); info('Apply it on the Apps page (Update).'); }
        else error(`${slug}: ${r.message}`);
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
