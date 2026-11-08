/**
 * What a run is told about the app it serves (dreamcontext-apps plan r19, W4): the app's name, its
 * assigned brief, where it lives and the actions it already has. Everything here is project text,
 * so it reaches a prompt only inside a nonce fence (`buildAskBlock`'s `'app'` variant and
 * `buildAppContextBlock`, runner.ts), never as an instruction.
 */

import { homedir } from 'node:os';
import { getApp } from './registry.js';
import { cleanText, readManifest } from './manifest.js';

export interface AppRunBrief {
  slug: string;
  name: string;
  brief: string;
  root: string;
  actions: Array<{ id: string; title: string; method: string; path: string }>;
  /** The owner typed this in the app's embedded chat, rather than the app's backend sending it. */
  ownerTyped?: boolean;
}

/** The brief of an app registered to this project, or null: gone, or its manifest is broken. */
export function appRunBrief(projectRoot: string, slug: string, home: string = homedir()): AppRunBrief | null {
  const rec = getApp(home, projectRoot, slug);
  if (!rec) return null;
  const m = readManifest(rec.root);
  if (!m.ok) return null;
  return {
    slug: rec.slug,
    name: rec.name,
    brief: cleanText(m.manifest.agent?.brief ?? '', 2000),
    root: rec.root,
    actions: m.manifest.actions.map((a) => ({ id: a.id, title: a.title, method: a.method, path: a.path })),
  };
}
