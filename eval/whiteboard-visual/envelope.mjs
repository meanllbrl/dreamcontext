// Prints, as JSON, the spawn envelope the dashboard gives one chat, computed by the source tree
// under test (so a `before` run gets the old briefing and allowlist, an `after` run the new):
//   main   a Chat tab: the surface briefing, bypassPermissions
//   agent  a home-board agent's card: the surface briefing + the card briefing, the board scope
// Run with `node --import ./ts-register.mjs envelope.mjs <src> <contextRoot> <main|agent> [agent board]`.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [src, contextRoot, actor, agent, board] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(src, rel)).href);
const { CHAT_SURFACE_BRIEFING } = await load('src/server/chat-surface.ts');

if (actor === 'main') {
  console.log(JSON.stringify({ briefing: CHAT_SURFACE_BRIEFING, permissionArgs: ['--permission-mode', 'bypassPermissions'], env: {} }));
} else {
  const { prepareCardChat } = await load('src/lib/whiteboards/card-chat.ts');
  const prep = prepareCardChat(contextRoot, { agent, board });
  if (!prep.ok) {
    console.error(`card refused: ${prep.reason}`);
    process.exit(1);
  }
  // The scratch folder must outlive this process: the chat spawned next writes into it.
  console.log(JSON.stringify({ briefing: `${CHAT_SURFACE_BRIEFING}\n${prep.briefing}`, permissionArgs: prep.permissionArgs, env: prep.env }));
}
