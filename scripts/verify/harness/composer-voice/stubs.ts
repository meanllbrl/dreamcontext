/**
 * Runs before any dashboard module: the page believes it is the desktop shell (so the composer
 * draws its voice row) and answers the few routes the composer asks for at mount. Every shell
 * command is refused, so the take falls back to the page microphone, which the verify script
 * gives Chromium as a fake device.
 */

const w = window as unknown as Record<string, unknown>;
const params = new URLSearchParams(location.search);
/** `?perm=prompt|denied|granted|restricted`: the shell's microphone permission
 *  (`desktop/src-tauri/src/mic_permission.rs`). Absent, those commands are refused like every
 *  other one (an older shell), which the composer reads as "unknown". Every call is recorded. */
let perm = params.get('perm');
const invokes: string[] = [];
w.__invokes = invokes;
w.__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    invokes.push(cmd);
    if (perm && cmd === 'mic_permission') return perm;
    if (perm && cmd === 'mic_permission_request') { if (perm === 'prompt') perm = 'granted'; return perm === 'granted'; }
    if (perm && cmd === 'mic_open_settings') return null;
    throw new Error(`command ${cmd} not found`);
  },
  transformCallback: () => 0,
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

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
  if (path.startsWith('/api/agent/voice/dictation')) return dictation(init?.method ?? 'GET');
  if (path.startsWith('/api/agent/voice/status')) {
    return json({ pushToTalk: params.get('chord') ?? 'Shift+V', pushToTalkMode: 'hold', speech: true, speechRate: 1, key: true });
  }
  if (path.startsWith('/api/agent/voice/tts')) { (w as { __tts: number }).__tts += 1; return new Response(null, { status: 204 }); }
  // `?stt=garbled`: the Mac could not understand the take twice (task sesli-giris-bozuk…), so
  // the answer carries no text, what was heard, and the cue. Otherwise the take is held in
  // "transcribing" until the script lets it go.
  if (path.startsWith('/api/agent/voice/stt') && params.get('stt') === 'garbled') {
    return json({ garbled: true, heard: 'Men bisverðir hens frímóðundæðin', take: `vt_${'0'.repeat(32)}`, ms: 2100, passes: 2, cue: { mime: 'audio/wav', b64: silentWav() } });
  }
  if (path.startsWith('/api/agent/voice/stt')) return new Promise<Response>(() => {});
  return json({});
}) as typeof fetch;

/** 0.2 s of silence as a base64 WAV: a cue the page can decode and start. */
function silentWav(): string {
  const n = 16_000 * 0.2 * 2;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const tag = (o: number, t: string) => { for (let i = 0; i < 4; i++) b[o + i] = t.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + n, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true); v.setUint32(28, 32_000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, n, true);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

/** `?dict=0`: dictation not installed yet. A POST (the mic menu's "Set up dictation", the same
 *  route Settings uses) starts a fake download that every later GET advances by a quarter, then
 *  reports it installed. Absent: installed, as before. */
let dictPhase: 'idle' | 'model' | 'done' = params.get('dict') === '0' ? 'idle' : 'done';
let dictGot = 0;
const DICT_TOTAL = 466e6;
w.__dictPosts = 0;
function dictation(method: string): Response {
  if (method === 'POST') { (w as { __dictPosts: number }).__dictPosts += 1; dictPhase = 'model'; dictGot = 0; }
  else if (dictPhase === 'model') { dictGot += DICT_TOTAL / 4; if (dictGot >= DICT_TOTAL) dictPhase = 'done'; }
  const installed = dictPhase === 'done';
  return json({
    installed,
    choice: installed || dictPhase === 'model' ? { engine: 'local', model: 'small' } : null,
    engine: installed, model: installed ? 'small' : null, blocked: null, key: false,
    machine: { memGB: 16, chip: 'Apple M2' }, recommended: 'small',
    models: [{ id: 'small', downloadMB: 466, ramMB: 900, onDisk: false, fits: true }],
    brew: true, phase: dictPhase === 'model' ? 'model' : installed ? 'done' : 'idle',
    received: dictPhase === 'model' ? dictGot : 0, total: dictPhase === 'model' ? DICT_TOTAL : 0,
    error: null, pending: dictPhase === 'model' ? 'small' : null,
  }, method === 'POST' ? 202 : 200);
}
