/**
 * The bridge child for the Claude engine setting (`dist/t3-bridge-claude.js`): the same child as
 * main.ts plus T3's Claude driver, as its own bundle. See claude-kit.ts for why.
 */
import { claudeKit } from './claude-kit.js';
import { runBridgeChat, type T3ChatOptions } from './main.js';

export const runT3Chat = (o: T3ChatOptions): Promise<number> => runBridgeChat(o, claudeKit);
