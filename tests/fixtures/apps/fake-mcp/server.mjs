// A tiny stdio MCP server for the dreamcontext Apps tests: one tool, `echo`, which answers
// with its arguments and whether FAKE_KEY reached its env.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: JSON.stringify({ args: req.params.arguments, key: process.env.FAKE_KEY ?? null, cwd: process.cwd() }) }],
}));
console.error('fake mcp up with key ' + (process.env.FAKE_KEY ?? 'none'));
await server.connect(new StdioServerTransport());
