#!/usr/bin/env node
// A tiny real stdio MCP server used as the proxy's upstream in tests. It is not PayPal and returns
// no payment data: every tool echoes the exact arguments it received and appends them to $ECHO_LOG,
// so a test can see what (if anything) the proxy forwarded. Tool names and the create_order input
// shape follow @paypal/agent-toolkit so the proxy's gating and amount computation are exercised.
const fs = require('fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const tools = [
  {
    name: 'create_order',
    description: 'echo fixture',
    inputSchema: {
      type: 'object',
      properties: { currencyCode: { type: 'string' }, items: { type: 'array' }, notes: { type: 'string' } },
      required: ['currencyCode', 'items'],
    },
  },
  { name: 'pay_order', description: 'echo fixture', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_order', description: 'echo fixture (read-only)', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_info', description: 'echo fixture (not gated)', inputSchema: { type: 'object', properties: {} } },
  // A money-moving tool the toolkit exposes under --tools=all; the proxy must neither list nor forward it.
  { name: 'create_refund', description: 'echo fixture (money-moving, not proof-gated)', inputSchema: { type: 'object' } },
];

let n = 0;
const server = new Server({ name: 'echo-upstream', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const entry = { tool: req.params.name, received: req.params.arguments ?? {}, n: ++n };
  if (process.env.ECHO_LOG) fs.appendFileSync(process.env.ECHO_LOG, JSON.stringify(entry) + '\n');
  return { content: [{ type: 'text', text: JSON.stringify(entry) }] };
});
server.connect(new StdioServerTransport());
