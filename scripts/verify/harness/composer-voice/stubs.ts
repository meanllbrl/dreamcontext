/**
 * Runs before any dashboard module: the page believes it is the desktop shell (so the composer
 * draws its voice row) and answers the few routes the composer asks for at mount. Every shell
 * command is refused, so the take falls back to the page microphone, which the verify script
 * gives Chromium as a fake device.
 */

const w = window as unknown as Record<string, unknown>;
w.__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => { throw new Error(`command ${cmd} not found`); },
  transformCallback: () => 0,
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

const params = new URLSearchParams(location.search);
localStorage.setItem('dreamcontext-theme', params.get('theme') === 'light' ? 'light' : 'dark');
if (params.has('readAloud')) localStorage.setItem('dreamcontext-read-aloud', params.get('readAloud') === '1' ? '1' : '0');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const realFetch = window.fetch.bind(window);
/** Every `/tts` the page asks for, read by the verify script. */
(w as { __tts?: number }).__tts = 0;
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  if (!path.startsWith('/api/')) return realFetch(input, init);
  if (path.startsWith('/api/agent/voice/dictation')) return json({ installed: true });
  if (path.startsWith('/api/agent/voice/status')) {
    return json({ pushToTalk: 'Shift+V', pushToTalkMode: 'hold', speech: true, speechRate: 1, key: true });
  }
  if (path.startsWith('/api/agent/voice/tts')) { (w as { __tts: number }).__tts += 1; return new Response(null, { status: 204 }); }
  // The take is held in "transcribing" until the script lets it go.
  if (path.startsWith('/api/agent/voice/stt')) return new Promise<Response>(() => {});
  return json({});
}) as typeof fetch;
