/**
 * Scratch state for scripts/verify/telegram-uyandirma.mjs, run with tsx under the FAKE HOME:
 * main's Super on with a recorded session, an approved AI Team member `ege` whose own Super is
 * born, and two hub-written Telegram bindings (main's bot and Ege's bot) for one owner. Imports
 * the repo under test (argv[2]), so the same setup serves the before and the after run.
 * Prints `{ mainSession, egeSession }` as JSON.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repo, project] = process.argv;
const from = (p: string) => import(pathToFileURL(join(repo, p)).href);
const root = join(project, '_dream_context');
const home = process.env.HOME!;

const { emptySuperState } = await from('src/lib/super/types.ts');
const { SUPER_STATE_REL } = await from('src/lib/super/store.ts');
const { getAutomation } = await from('src/lib/automations/store.ts');
const { approveAutomation } = await from('src/lib/automations/registry.ts');
const { ensureMemberSuper } = await from('src/lib/super/member-birth.ts');
const { writeBinding, scopeOfContextRoot } = await from('src/lib/telegram/config.ts');

const mainSession = '11111111-2222-4333-8444-555555555555';
writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: mainSession, enabled: true }));
const m = getAutomation(root, 'ege', home);
if (!m) throw new Error('the ege agent is missing (agents create did not run)');
approveAutomation(project, m, new Date(), home);
const birth = await ensureMemberSuper(root, 'ege', home);
if (!birth.ok) throw new Error(`ege's Super was not born: ${birth.error} ${birth.message}`);
const scope = scopeOfContextRoot(root);
const owner = { chatId: 777, userId: 777, boundAt: new Date().toISOString() };
writeBinding(scope, 'super', { token: '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', botId: 111111, botUsername: 'acme_super_bot', ...owner }, home);
writeBinding(scope, 'ege', { token: '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', botId: 222222, botUsername: 'ege_bot', ...owner }, home);
process.stdout.write(`${JSON.stringify({ mainSession, egeSession: birth.session })}\n`);
