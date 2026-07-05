import { LabError, type InsightManifest, type LabAdapter } from '../types.js';
import { genericHttpAdapter } from './generic-http.js';
import { customScriptAdapter } from './custom-script.js';

/** Resolve the adapter for a manifest's source (http | script). */
export function getAdapter(manifest: InsightManifest): LabAdapter {
  const source = manifest.source;
  if (!source) {
    throw new LabError(`Insight ${manifest.slug} has no valid source block.`);
  }
  if (source.adapter === 'http') return genericHttpAdapter;
  if (source.adapter === 'script') return customScriptAdapter;
  throw new LabError(`Unknown adapter for insight ${manifest.slug}.`);
}

export { genericHttpAdapter } from './generic-http.js';
export { customScriptAdapter, scriptFilePath } from './custom-script.js';
