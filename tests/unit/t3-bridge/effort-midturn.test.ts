/**
 * `/effort` sent while a Codex turn runs (W1 re-check): the bridge sets the effort at once but
 * answers only AFTER the running turn's own result, because the chat server counts one turn per
 * result; an early answer would close the running turn on the server's books.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runBridgeStdio } from '../../../src/lib/t3-bridge/stdio.js';
import { loadFixture, policyFor, replayFactory } from './replay-harness.js';

describe('/effort mid-turn', () => {
  it('is answered after the running turn ends, never before', async () => {
    const f = loadFixture('tool_call_read_only_on_request');
    const input = new PassThrough();
    const out: Record<string, unknown>[] = [];
    let buf = '';
    const done = runBridgeStdio(
      { tool: 'codex', cwd: f.workspace, model: f.model, mode: 'bypassPermissions', paneId: 'pane-effort-mid' },
      {
        input, env: {}, home: mkdtempSync(join(tmpdir(), 'dc-effort-mid-')),
        clientFactory: replayFactory(f.transcript), runtimePolicyOverride: policyFor(f),
        write: (l) => { buf += l; let n; while ((n = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, n))); buf = buf.slice(n + 1); } },
      },
    );
    const wait = async (p: () => boolean) => { const e = Date.now() + 15_000; while (!p()) { if (Date.now() > e) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
    const user = (text: string) => input.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
    await wait(() => out.some((x) => x.dc_ready));
    user(f.prompt);
    await wait(() => out.some((x) => x.type === 'control_request'));
    user('/effort high');
    await new Promise((r) => setTimeout(r, 300));
    expect(out.filter((x) => x.type === 'result')).toEqual([]);
    const ask = out.find((x) => x.type === 'control_request')!;
    input.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'allow', updatedInput: {} } } }) + '\n');
    await wait(() => out.filter((x) => x.type === 'result').length >= 2);
    const results = out.filter((x) => x.type === 'result');
    expect(results[0]!.dc_synthetic).toBeUndefined();
    expect(results[1]).toMatchObject({ dc_synthetic: true });
    expect(out.indexOf(results[0]!)).toBeLessThan(out.findIndex((x) => JSON.stringify(x).includes('Set effort level to high')));
    input.end();
    await done;
  }, 40_000);
});
