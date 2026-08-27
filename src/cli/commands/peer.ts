import { Command } from 'commander';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { VaultError } from '../../lib/vaults.js';
import { header, success, error, info, formatTable } from '../../lib/format.js';
import {
  archiveMessage,
  listMessages,
  listPending,
  quarantinedMail,
  readMessage,
  readThread,
  updateMessage,
  type PeerMessage,
  type PeerMessageKind,
} from '../../lib/peer-mail.js';
import {
  checkSendConsent,
  resolvePeer,
  selfVaultName,
  sendToPeer,
  type SendResult,
} from '../../lib/peer-delivery.js';

const KINDS: PeerMessageKind[] = ['note', 'question', 'command'];

/** Compact, sortable local time for a message list. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function preview(body: string, width = 62): string {
  return body.length > width ? `${body.slice(0, width - 1)}…` : body;
}

function kindLabel(kind: PeerMessageKind): string {
  if (kind === 'command') return chalk.yellow('command');
  if (kind === 'question') return chalk.cyan('question');
  return chalk.dim('note');
}

/** Render one message as a block — used by `read`, `thread`, and reply echoes. */
function printMessage(msg: PeerMessage, selfName: string): void {
  const outbound = msg.from === selfName;
  const arrow = outbound ? `${chalk.dim('you')} → ${chalk.bold(msg.to)}` : `${chalk.bold(msg.from)} → ${chalk.dim('you')}`;
  console.log(`${arrow}  ${kindLabel(msg.kind)}  ${chalk.dim(when(msg.createdAt))}  ${chalk.dim(msg.id)}`);
  console.log(msg.body);
  console.log('');
}

/**
 * Report the outcome of a send in the terms the user actually cares about:
 * whether the peer answered NOW, or whether the message is waiting for it to
 * wake up. A failed live run is reported as the second case plus the reason —
 * it is a downgrade, not a loss.
 */
function reportSend(result: SendResult, peerName: string): void {
  if (result.live && result.reply) {
    success(`${peerName} answered:`);
    console.log('');
    console.log(result.reply.body);
    console.log('');
    info(chalk.dim(`thread ${result.message.thread} — reply with \`dreamcontext peer reply ${result.reply.id} "…"\``));
    return;
  }
  if (result.error) {
    success(`Delivered to ${peerName}'s inbox.`);
    info(chalk.yellow(`Could not reach it live: ${result.error}`));
    info(chalk.dim(`It will see the message on its next session. Message id: ${result.message.id}`));
    return;
  }
  success(`Left in ${peerName}'s inbox — it will see it on its next session.`);
  info(chalk.dim(`Message id: ${result.message.id}`));
}

/**
 * Register the peer-mail verbs — the write half of federation.
 *
 * `connect` decides who may read whom; these decide who may SAY something to
 * whom. Every send is gated by {@link checkSendConsent} (we must be connected;
 * the peer must accept inbound from us) and every live delivery runs under
 * `auto` permissions in the PEER's directory, never `bypassPermissions`.
 */
export function registerPeerCommand(program: Command): void {
  const peer = program
    .command('peer')
    .description('Talk to a connected project: send notes, ask questions, hand over commands');

  // ─── peer send ───────────────────────────────────────────────────────────────
  peer
    .command('send <vault> [message...]')
    .description('Send a message to a connected peer (note | question | command)')
    .option('-k, --kind <kind>', `Message kind: ${KINDS.join(' | ')}`, 'note')
    .option('--live', 'Wake the peer now, even for a note')
    .option('--deferred', 'Just leave it in the inbox, even for a question')
    .option('--thread <id>', 'Continue an existing thread')
    .option('--model <alias>', 'Model for the peer run')
    .option('--timeout <seconds>', 'Give the peer run this long before giving up')
    .action(async (vault: string, message: string[], opts: {
      kind?: string; live?: boolean; deferred?: boolean;
      thread?: string; model?: string; timeout?: string;
    }) => {
      const contextRoot = ensureContextRoot();
      const body = (message ?? []).join(' ').trim();
      if (!body) {
        error('Nothing to send.', 'dreamcontext peer send <vault> "your message"');
        process.exitCode = 1;
        return;
      }
      const kind = (opts.kind ?? 'note').toLowerCase() as PeerMessageKind;
      if (!KINDS.includes(kind)) {
        error(`Unknown kind '${opts.kind}'.`, `Use one of: ${KINDS.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      if (opts.live && opts.deferred) {
        error('--live and --deferred contradict each other.');
        process.exitCode = 1;
        return;
      }

      try {
        const target = resolvePeer(vault);
        const selfName = selfVaultName(contextRoot);
        const consent = checkSendConsent(contextRoot, target, selfName);
        if (!consent.ok) {
          error(consent.reason, consent.hint);
          process.exitCode = 1;
          return;
        }

        const live = opts.live ? true : opts.deferred ? false : undefined;
        if (live !== false && kind !== 'note') {
          info(chalk.dim(`Waking ${vault}…`));
        }
        const result = await sendToPeer(
          contextRoot,
          target,
          { kind, body, thread: opts.thread ?? null },
          {
            live,
            model: opts.model,
            timeoutMs: opts.timeout ? Number(opts.timeout) * 1000 : undefined,
          },
        );
        reportSend(result, vault);
      } catch (err) {
        error(err instanceof VaultError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // ─── peer ask ────────────────────────────────────────────────────────────────
  peer
    .command('ask <vault> [question...]')
    .description('Ask a connected peer a question and wait for its answer (live)')
    .option('--model <alias>', 'Model for the peer run')
    .option('--timeout <seconds>', 'Give the peer run this long before giving up')
    .action(async (vault: string, question: string[], opts: { model?: string; timeout?: string }) => {
      const contextRoot = ensureContextRoot();
      const body = (question ?? []).join(' ').trim();
      if (!body) {
        error('Nothing to ask.', 'dreamcontext peer ask <vault> "your question"');
        process.exitCode = 1;
        return;
      }
      try {
        const target = resolvePeer(vault);
        const selfName = selfVaultName(contextRoot);
        const consent = checkSendConsent(contextRoot, target, selfName);
        if (!consent.ok) {
          error(consent.reason, consent.hint);
          process.exitCode = 1;
          return;
        }
        info(chalk.dim(`Waking ${vault}…`));
        const result = await sendToPeer(
          contextRoot, target,
          { kind: 'question', body },
          { live: true, model: opts.model, timeoutMs: opts.timeout ? Number(opts.timeout) * 1000 : undefined },
        );
        reportSend(result, vault);
      } catch (err) {
        error(err instanceof VaultError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // ─── peer inbox ──────────────────────────────────────────────────────────────
  peer
    .command('inbox', { isDefault: true })
    .description('Show messages waiting in this vault')
    .option('-a, --all', 'Include messages already read, answered, or closed')
    .option('--json', 'Machine-readable output')
    .action((opts: { all?: boolean; json?: boolean }) => {
      const contextRoot = ensureContextRoot();
      const selfName = selfVaultName(contextRoot);
      const messages = opts.all
        ? listMessages(contextRoot, { includeArchived: true })
        : listPending(contextRoot);

      if (opts.json) {
        console.log(JSON.stringify({ messages, quarantined: quarantinedMail(contextRoot) }, null, 2));
        return;
      }

      if (messages.length === 0) {
        console.log(chalk.dim(opts.all ? '(no peer mail)' : '(no new peer mail)'));
        info(chalk.dim('Send one with `dreamcontext peer send <vault> "…"`.'));
      } else {
        console.log(header(opts.all ? 'Peer Mail' : 'Peer Mail — new'));
        const rows = messages.map((m) => [
          m.from === selfName ? `→ ${m.to}` : `← ${m.from}`,
          m.kind,
          preview(m.body),
          m.status,
          when(m.createdAt),
          m.id,
        ]);
        console.log(formatTable(['With', 'Kind', 'Message', 'Status', 'When', 'Id'], rows, { statusCol: 3 }));
        info(chalk.dim('Read one with `dreamcontext peer read <id>`.'));
      }

      const bad = quarantinedMail(contextRoot);
      if (bad.length > 0) {
        console.log('');
        info(chalk.yellow(`${bad.length} message(s) this vault cannot read:`));
        for (const b of bad) console.log(chalk.dim(`  ${b.file} — ${b.reason}`));
      }
    });

  // ─── peer read ───────────────────────────────────────────────────────────────
  peer
    .command('read <id>')
    .description('Read one message in full (marks it read)')
    .action((id: string) => {
      const contextRoot = ensureContextRoot();
      const msg = readMessage(contextRoot, id);
      if (!msg) {
        error(`No message "${id}" in this vault.`, 'List them with `dreamcontext peer inbox --all`.');
        process.exitCode = 1;
        return;
      }
      const selfName = selfVaultName(contextRoot);
      console.log('');
      printMessage(msg, selfName);
      // Only inbound mail transitions on read, and never backwards out of a
      // terminal state — re-reading an answered thread must not reopen it.
      if (msg.to === selfName && msg.status === 'pending') {
        updateMessage(contextRoot, id, { status: 'read' });
      }
      info(chalk.dim(`Reply with \`dreamcontext peer reply ${msg.id} "…"\` · whole thread: \`dreamcontext peer thread ${msg.thread}\``));
    });

  // ─── peer thread ─────────────────────────────────────────────────────────────
  peer
    .command('thread <id>')
    .description('Show a whole conversation (accepts a thread id or any message id in it)')
    .action((id: string) => {
      const contextRoot = ensureContextRoot();
      const anchor = readMessage(contextRoot, id);
      const threadId = anchor ? anchor.thread : id;
      const messages = readThread(contextRoot, threadId);
      if (messages.length === 0) {
        error(`No thread "${id}" in this vault.`);
        process.exitCode = 1;
        return;
      }
      const selfName = selfVaultName(contextRoot);
      console.log(header(`Thread ${threadId}`));
      console.log('');
      for (const m of messages) printMessage(m, selfName);
    });

  // ─── peer reply ──────────────────────────────────────────────────────────────
  peer
    .command('reply <id> [message...]')
    .description("Reply to a message, back to whoever sent it")
    .option('--live', 'Wake the peer now instead of leaving it in their inbox')
    .option('--model <alias>', 'Model for the peer run')
    .action(async (id: string, message: string[], opts: { live?: boolean; model?: string }) => {
      const contextRoot = ensureContextRoot();
      const body = (message ?? []).join(' ').trim();
      if (!body) {
        error('Nothing to reply with.', `dreamcontext peer reply ${id} "your reply"`);
        process.exitCode = 1;
        return;
      }
      const original = readMessage(contextRoot, id);
      if (!original) {
        error(`No message "${id}" in this vault.`);
        process.exitCode = 1;
        return;
      }
      const selfName = selfVaultName(contextRoot);
      // Reply goes to the OTHER end of this message, whichever end that is — so
      // replying to your own sent copy still addresses the peer, not yourself.
      const peerName = original.from === selfName ? original.to : original.from;

      try {
        const target = resolvePeer(peerName);
        const consent = checkSendConsent(contextRoot, target, selfName);
        if (!consent.ok) {
          error(consent.reason, consent.hint);
          process.exitCode = 1;
          return;
        }
        const result = await sendToPeer(
          contextRoot, target,
          { kind: 'note', body, thread: original.thread, replyTo: original.id },
          { live: opts.live === true, model: opts.model },
        );
        updateMessage(contextRoot, original.id, { status: 'answered' });
        reportSend(result, peerName);
      } catch (err) {
        error(err instanceof VaultError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // ─── peer done ───────────────────────────────────────────────────────────────
  peer
    .command('done <id>')
    .description('Close a message and move it out of the inbox')
    .action((id: string) => {
      const contextRoot = ensureContextRoot();
      const msg = readMessage(contextRoot, id);
      if (!msg) {
        error(`No message "${id}" in this vault.`);
        process.exitCode = 1;
        return;
      }
      updateMessage(contextRoot, id, { status: 'done' });
      archiveMessage(contextRoot, id);
      success(`Closed ${id}.`);
    });
}
