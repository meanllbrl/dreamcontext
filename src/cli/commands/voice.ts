import { Command } from 'commander';
import { request } from 'node:http';
import { windowEnv } from './window.js';

/**
 * `dreamcontext voice retry [ref] [--language <code>]` — a chat's agent asks the Mac to
 * transcribe a dictated message AGAIN, once, from the same audio (task sesli-giris-bozuk…).
 *
 * A message the owner dictated carries `<voice-take ref="vt_…" lang="…" quality="…"/>`. When
 * its text reads as nonsense, in an unexpected language, or loops, the agent runs this first
 * (`--language` = the language the two of them are speaking) and only then asks the owner.
 *
 * A THIN HTTP CLIENT in `window`'s shape: one call to `/api/agent/voice/retranscribe`,
 * authenticated by the chat's own window token, so it reaches only this chat's takes in this
 * chat's vault. From a terminal it refuses (`not_a_chat`). JSON out; a refusal exits 1.
 */

const NOT_A_CHAT = 'voice retry works only from an agent running in a dreamcontext chat tab';

interface CallResult { status: number; body: Record<string, unknown> }

export function callRetranscribe(body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<CallResult> {
  const e = windowEnv(env);
  if (!e) return Promise.resolve({ status: 401, body: { error: 'not_a_chat', message: NOT_A_CHAT } });
  const url = new URL('/api/agent/voice/retranscribe', e.url);
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        'x-dreamcontext-window-token': e.token,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { parsed = { message: data }; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: { error: 'unreachable', message: `the app is not reachable: ${err.message}` } }));
    req.write(payload);
    req.end();
  });
}

/** JSON is the contract. A refusal exits 1 with the reason on stderr. */
function print(r: CallResult): void {
  if (r.status >= 400 || r.status === 0) {
    process.stderr.write(`${JSON.stringify(r.body, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(r.body, null, 2)}\n`);
}

export function registerVoiceCommand(program: Command): void {
  const v = program
    .command('voice')
    .description('Dictation from inside a chat: retranscribe a voice message that reads as nonsense (only from a dreamcontext chat)');

  v.command('retry')
    .description('Transcribe a dictated message again, once, from the same audio (its <voice-take ref>); omit ref for this chat\'s latest take')
    .argument('[ref]', 'the take ref from the message\'s <voice-take ref="vt_…"> block')
    .option('--language <code>', 'force the language you two are speaking (a code like tr or en)')
    .action(async (ref: string | undefined, opts: { language?: string }) => {
      print(await callRetranscribe({ ...(ref ? { ref } : {}), ...(opts.language ? { language: opts.language } : {}) }));
    });
}
