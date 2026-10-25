import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ACTIONS, DESCRIPTION } from './actions.js';
import { createClient } from './client.js';
import { zhihuToolContent } from './tool-content.js';

export function createMcpServer({ call = createClient(), authorize, qq = false } = {}) {
  const server = new McpServer({ name: qq ? 'dsh-zhihu-qq' : 'dsh-zhihu', version: '0.1.4' });
  const fields = {
    action: z.enum(ACTIONS), query: z.string().optional(), contentUrl: z.string().optional(),
    readToken: z.string().max(256).optional(), reason: z.string().min(1).max(300).optional(),
    questionUrl: z.string().optional(), favlistId: z.string().optional(),
    limit: z.number().int().min(1).max(10).optional(), offset: z.number().int().min(0).max(1000000).optional(),
    urls: z.array(z.string()).min(1).max(10).optional(), activityIds: z.array(z.string()).min(1).max(10).optional(),
    ...(qq ? { key: z.string(), token: z.string() } : {}),
  };
  server.tool(qq ? 'qq_zhihu_browse' : 'zhihu_browse', DESCRIPTION, fields, async input => {
    try {
      if (authorize) await authorize(input);
      const { action, key, token, ...args } = input;
      const data = await call(action, args);
      return { content: zhihuToolContent(data) };
    } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message).split('\n')[0].slice(0, 500) }] }; }
  });
  return server;
}
export async function serveMcp(options) {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
