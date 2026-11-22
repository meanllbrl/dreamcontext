// The live-link board viewer's fonts (dashboard/src/share/assetPath.ts): Excalidraw lists its CDN
// after the share's own copy in every font face; the viewer keeps only same-origin sources, so
// Chromium never checks (and logs a CSP violation for) a source the viewer's CSP refuses.
import { describe, it, expect } from 'vitest';
import { sameOriginFontSources } from '../../dashboard/src/share/assetPath.js';

const ORIGIN = 'https://kuzey-limon.trycloudflare.com';
const SELF = `url(${ORIGIN}/excalidraw-assets/fonts/Virgil/Virgil-Regular.woff2) format('woff2')`;
const CDN = "url(https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Virgil/Virgil-Regular.woff2) format('woff2')";

describe('sameOriginFontSources', () => {
  it('drops the CDN fallback and keeps the share\'s own source', () => {
    expect(sameOriginFontSources(`${SELF}, ${CDN}`, ORIGIN)).toBe(SELF);
  });

  it('keeps a relative or quoted same-origin source', () => {
    expect(sameOriginFontSources(`url('/excalidraw-assets/a.woff2') format('woff2'), ${CDN}`, ORIGIN)).toBe("url('/excalidraw-assets/a.woff2') format('woff2')");
  });

  it('never empties the list: no same-origin source passes it through unchanged', () => {
    expect(sameOriginFontSources(CDN, ORIGIN)).toBe(CDN);
  });

  it('keeps a local() source and the whole list when every source is the share\'s', () => {
    expect(sameOriginFontSources(`local(Virgil), ${SELF}`, ORIGIN)).toBe(`local(Virgil), ${SELF}`);
  });
});
