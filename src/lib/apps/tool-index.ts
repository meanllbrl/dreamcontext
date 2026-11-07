/**
 * The prompt hook's app tools (app-araclari plan r3 §3b, the half that carries the load): every
 * tool of every app installed on THIS Mac is one document, every app of the project's catalog not
 * installed here is one document, and BM25 runs over that small set only. Independent of the
 * recall tier (it works in cloud mode too) and of the network: whether an app is shared with this
 * account is read from the server's offline snapshot.
 *
 * The instruction text is a constant of this file. The app's own words (a title, a `does`) enter
 * only quoted, one line, cut to 80 characters and labelled "(app text)": a title that says "ignore
 * previous instructions" stays a title.
 */

import { dirname } from 'node:path';
import { buildFields, bm25Search, type CorpusDoc } from '../recall.js';
import { cleanText } from './manifest.js';
import { projectAppTools, type InstalledApp, type InstalledTool, type NotInstalledApp } from './tools.js';

export const APP_TOOLS_MAX_LINES = 2;
export const APP_TOOLS_MAX_CHARS = 600;
/** Raw BM25 score a document must reach. The set is small (one app's tools), so one strong word. */
export const APP_TOOLS_MIN_SCORE = 0.9;

type Ref =
  | { kind: 'tool'; app: InstalledApp; tool: InstalledTool }
  | { kind: 'app'; app: NotInstalledApp };

function doc(id: string, title: string, description: string, tags: string[], body: string): CorpusDoc {
  const f = buildFields({ slug: id, title, description, tags, body });
  return {
    type: 'knowledge', path: id, relPath: `app:${id}`, slug: id, title, description, tags, body,
    tokens: f.tokens, tokenSet: new Set(f.tokens), termFreq: f.termFreq, fieldFreq: f.fieldFreq, fieldLen: f.fieldLen,
    links: f.links, identityTokens: f.identityTokens,
  };
}

/** The documents and what each one stands for. Exported for recall's `app` type. */
export function appToolDocs(home: string, contextRoot: string): Array<{ doc: CorpusDoc; ref: Ref }> {
  const list = projectAppTools(home, dirname(contextRoot), contextRoot);
  const out: Array<{ doc: CorpusDoc; ref: Ref }> = [];
  for (const app of list.installed) {
    for (const tool of app.tools) {
      const body = [tool.does ?? '', tool.output ?? '', ...(tool.params ? Object.entries(tool.params).map(([k, v]) => `${k} ${v.desc ?? ''}`) : [])].join(' ');
      out.push({ doc: doc(`${app.slug}/${tool.id}`, `${app.name} ${tool.title}`, tool.does ?? '', [...(tool.topics ?? []), app.slug, tool.id.replace(/-/g, ' ')], body), ref: { kind: 'tool', app, tool } });
    }
  }
  for (const app of list.notInstalled) {
    out.push({ doc: doc(app.slug, app.name, app.does, [app.slug], app.tools.map((t) => t.title).join(' ')), ref: { kind: 'app', app } });
  }
  return out;
}

const quote = (s: string) => `"${cleanText(s, 80).replace(/"/g, "'")}" (app text)`;

function toolLine(app: InstalledApp, tool: InstalledTool): string {
  const head = `→ APP TOOL (this Mac): ${app.slug} › ${tool.id} ${quote(tool.title)}`;
  const agent = tool.usesAgent ? ' · runs an agent turn (spends usage)' : '';
  if (tool.effect === 'read') {
    return `${head} · reads${agent}. Take the app's answer instead of computing it: dreamcontext apps do ${app.slug} ${tool.id} --json`;
  }
  return `${head} · CHANGES${agent}: say in one line what it will do; run dreamcontext apps do ${app.slug} ${tool.id} --confirm only after the owner says yes in this chat.`;
}

function appLine(app: NotInstalledApp): string {
  const name = quote(app.name);
  if (app.sharedWithMe === true) return `→ The project has the app ${name}, not installed on this Mac. Say: without it this takes longer or is approximate; offer to install it (an app-install button) or a Lab insight. Never install it yourself.`;
  if (app.sharedWithMe === false) return `→ The project has the app ${name}, but it is not shared with this account: ask ${app.publishedBy ?? 'its publisher'} to share it. No install button.`;
  return `→ The project has the app ${name}, not installed on this Mac: without it this takes longer or is approximate. Suggest a look at "Shared with you" on the Apps page, or a Lab insight. No install button.`;
}

/** The hook's block for this prompt, or null when no tool fits. Never throws. */
export function appToolsBlock(prompt: string, contextRoot: string, home: string): string | null {
  try {
    if (prompt.trim().length < 3) return null;
    const docs = appToolDocs(home, contextRoot);
    if (!docs.length) return null;
    const byKey = new Map(docs.map((d) => [d.doc.relPath, d.ref]));
    const hits = bm25Search(prompt, docs.map((d) => d.doc), APP_TOOLS_MAX_LINES).filter((h) => h.score >= APP_TOOLS_MIN_SCORE);
    if (!hits.length) return null;
    const lines: string[] = [];
    let used = 0;
    for (const h of hits) {
      const ref = byKey.get(h.doc.relPath);
      if (!ref) continue;
      const line = ref.kind === 'tool' ? toolLine(ref.app, ref.tool) : appLine(ref.app);
      if (used + line.length > APP_TOOLS_MAX_CHARS) break;
      lines.push(line);
      used += line.length;
    }
    return lines.length ? ['', '[App tools on this Mac]', ...lines].join('\n') : null;
  } catch {
    return null;
  }
}
