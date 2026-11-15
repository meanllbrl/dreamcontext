/**
 * The Telegram spoken summary's voice core (plan telegram-sesli-ozet, C2 + encode): sentence
 * chunks, the shared gate, all-or-nothing, the OGG/Opus encoder. No network: `synthChunk` and the
 * encoder are injected; the one real-ffmpeg case runs only where ffmpeg is installed.
 */
import { describe, expect, it } from 'vitest';
import { speakSummary, summaryChunks, MAX_SUMMARY_CHARS, SUMMARY_CHUNK_CHARS, type SpeakDeps } from '../../src/server/voice-speak.js';
import { opusArgs, pcmToOggOpus } from '../../src/lib/voice/encode.js';
import { findFfmpeg } from '../../src/lib/voice/transcribe.js';
import { VoiceGate } from '../../src/lib/voice/limits.js';
import type { SynthResult, synthChunk } from '../../src/server/routes/agent-voice.js';

type SynthArgs = Parameters<typeof synthChunk>[0];

/** A fake synth: each chunk is pcm whose first byte is its index, so order is visible. */
function fakeDeps(over: Partial<SpeakDeps> = {}, outcome: (a: SynthArgs, i: number) => SynthResult['outcome'] = () => 'spoken') {
  const calls: SynthArgs[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: SpeakDeps = {
    key: () => 'sk-or-test-key',
    model: async () => ({ ok: true, id: 'test/model' }),
    voice: () => 'onyx',
    gate: new VoiceGate({ concurrency: 3, perWindow: 240, windowMs: 60_000 }),
    sleep: async () => {},
    log: (e) => logs.push(e),
    encode: async (pcm) => ({ ok: true, ogg: Buffer.concat([Buffer.from('OggS'), pcm]) }),
    synth: async (a) => {
      const i = calls.push(a) - 1;
      const o = outcome(a, i);
      return o === 'spoken' ? { outcome: o, retried: false, pcm: Buffer.from([i, 0, 0, 0]) } : { outcome: o, retried: false };
    },
    ...over,
  };
  return { deps, calls, logs };
}

const LONG = Array.from({ length: 12 }, (_, i) => `Bu ${i + 1}. cümle ve biraz uzunca yazılmış bir açıklama içeriyor, okunacak.`).join(' ');

describe('summaryChunks', () => {
  it('groups whole sentences up to the chunk size, in order, losing no word', () => {
    const chunks = summaryChunks(LONG);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SUMMARY_CHUNK_CHARS);
    expect(chunks.join(' ')).toBe(LONG);
  });

  it('cuts a sentence longer than the chunk at a comma or a space', () => {
    const one = `${'kelime '.repeat(60).trim()}, ${'son '.repeat(10).trim()}.`;
    const chunks = summaryChunks(one, 100);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(one);
  });
});

describe('speakSummary', () => {
  it('speaks every chunk with the previous one as context and joins them in order', async () => {
    const { deps, calls, logs } = fakeDeps();
    const r = await speakSummary(LONG, { deps });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = summaryChunks(LONG).length;
    expect(calls).toHaveLength(n);
    expect(calls[0]!.prev).toBeUndefined();
    expect(calls[1]!.prev).toBe(calls[0]!.spoken);
    expect(calls.every((c) => c.voice === 'onyx' && c.modelId === 'test/model' && c.key === 'sk-or-test-key')).toBe(true);
    // OggS + chunk 0, chunk 1, ... in order
    const order = Array.from({ length: n }, (_, i) => r.ogg[4 + i * 4]);
    expect(order).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(logs.at(-1)).toMatchObject({ kind: 'tts', outcome: 'summary-ok', chunks: n, retried: 0 });
    expect(JSON.stringify(logs)).not.toContain('sk-or-test-key');
    expect(JSON.stringify(logs)).not.toContain('cümle');
  });

  it('never more than two chunks at once, and every gate slot comes back', async () => {
    let live = 0;
    let peak = 0;
    const gate = new VoiceGate({ concurrency: 3, perWindow: 240, windowMs: 60_000 });
    const { deps } = fakeDeps({
      gate,
      synth: async () => {
        live += 1; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
        return { outcome: 'spoken', retried: false, pcm: Buffer.alloc(4) };
      },
    });
    expect((await speakSummary(LONG, { deps })).ok).toBe(true);
    expect(peak).toBe(2);
    expect(gate.state.inFlight).toBe(0);
  });

  it('any chunk not spoken fails the whole voice: nothing is encoded', async () => {
    let encoded = false;
    const { deps } = fakeDeps({ encode: async () => { encoded = true; return { ok: true, ogg: Buffer.from('OggS') }; } }, (_a, i) => (i === 1 ? 'dropped-not-read' : 'spoken'));
    expect(await speakSummary(LONG, { deps })).toEqual({ ok: false, reason: 'failed' });
    expect(encoded).toBe(false);
  });

  it('a rate-limited gate fails the voice, never a voice cut short', async () => {
    const gate = new VoiceGate({ concurrency: 3, perWindow: 1, windowMs: 60_000 });
    const { deps, calls } = fakeDeps({ gate });
    expect(await speakSummary(LONG, { deps })).toEqual({ ok: false, reason: 'failed' });
    expect(calls.length).toBeLessThanOrEqual(1);
    expect(gate.state.inFlight).toBe(0);
  });

  it('no key → no_key; a key the provider refuses → no_key; an unreachable model → failed', async () => {
    expect(await speakSummary('Merhaba.', { deps: fakeDeps({ key: () => null }).deps })).toEqual({ ok: false, reason: 'no_key' });
    expect(await speakSummary('Merhaba.', { deps: fakeDeps({ model: async () => ({ ok: false, reason: 'no_key' }) }).deps })).toEqual({ ok: false, reason: 'no_key' });
    expect(await speakSummary('Merhaba.', { deps: fakeDeps({ model: async () => ({ ok: false, reason: 'unreachable' }) }).deps })).toEqual({ ok: false, reason: 'failed' });
  });

  it('over the cap → too_long; only a link → nothing_speakable; a missing ffmpeg → no_ffmpeg', async () => {
    expect(await speakSummary('a. '.repeat(MAX_SUMMARY_CHARS), { deps: fakeDeps().deps })).toEqual({ ok: false, reason: 'too_long' });
    expect(await speakSummary('https://example.com/x', { deps: fakeDeps().deps })).toEqual({ ok: false, reason: 'nothing_speakable' });
    expect(await speakSummary('Merhaba.', { deps: fakeDeps({ encode: async () => ({ ok: false, reason: 'ffmpeg_missing' }) }).deps })).toEqual({ ok: false, reason: 'no_ffmpeg' });
  });

  it('a secret in the summary is redacted before it is spoken', async () => {
    const { deps, calls } = fakeDeps();
    await speakSummary('Anahtar sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 burada.', { deps });
    expect(calls.map((c) => c.spoken).join(' ')).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });
});

describe('pcmToOggOpus', () => {
  it('runs ffmpeg with an argument array: raw pcm16 24 kHz mono in, OGG/Opus out, pipes only', () => {
    const a = opusArgs();
    expect(a).toEqual(expect.arrayContaining(['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1']));
    expect(a[a.indexOf('-protocol_whitelist') + 1]).toBe('pipe');
  });

  it('no ffmpeg → ffmpeg_missing, never a throw', async () => {
    expect(await pcmToOggOpus(Buffer.alloc(480), { ffmpeg: null })).toEqual({ ok: false, reason: 'ffmpeg_missing' });
    expect(await pcmToOggOpus(Buffer.alloc(480), { ffmpeg: '/nonexistent/ffmpeg' })).toEqual({ ok: false, reason: 'ffmpeg_missing' });
  });

  it('a spawn that throws synchronously resolves failed, never rejects', async () => {
    const spawnImpl = (() => { throw Object.assign(new Error('bad args'), { code: 'EINVAL' }); }) as never;
    expect(await pcmToOggOpus(Buffer.alloc(480), { ffmpeg: '/bin/echo', spawnImpl })).toEqual({ ok: false, reason: 'failed' });
  });

  it.skipIf(!findFfmpeg())('real ffmpeg: a half second of tone becomes an OGG stream', async () => {
    const pcm = Buffer.alloc(24_000);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
    const r = await pcmToOggOpus(pcm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ogg.subarray(0, 4).toString('latin1')).toBe('OggS');
  });
});
