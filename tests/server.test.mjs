import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRuntime } from '../lib/runtime.js';
import { startServer } from '../lib/server.js';
import { token } from '../lib/paths.js';

test('real HTTP management, token isolation, origin fence and stdio MCP work without bridge files or network APIs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-http-')); let upstream = 0;
  const runtime = createRuntime({ stateDir: dir, fetchImpl: async () => { upstream++; throw new Error('must not call upstream'); } });
  const app = await startServer({ runtime, port: 0 });
  const client = new Client({ name: 'package-test', version: '1' });
  const post = (route, credential, data, extra = {}) => fetch(app.url + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: 'Bearer ' + credential } : {}), ...extra }, body: JSON.stringify(data) });
  try {
    const admin = token(dir, 'admin'), agent = token(dir, 'agent');
    assert.equal((await fetch(app.url + '/api/status')).status, 401);
    assert.equal((await post('/api/admin', agent, { action: 'settings', args: { upvoteEnabled: false } })).status, 401);
    assert.equal((await post('/api/tool', admin, { action: 'status' })).status, 401);
    assert.equal((await post('/api/tool', agent, { action: 'status' }, { origin: 'https://untrusted.invalid' })).status, 403);
    const rejectedHost = await new Promise((resolve, reject) => {
      const req = http.request(app.url + '/api/tool', { method: 'POST', headers: { host: 'untrusted.invalid', authorization: 'Bearer ' + agent, 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end('{"action":"status"}');
    });
    assert.equal(rejectedHost, 403);
    assert.equal((await post('/api/tool', agent, { action: 'configure_api' })).status, 400);
    const resumed = await post('/api/admin', admin, { action: 'resume_access' }); assert.equal(resumed.status, 200);
    const status = await (await post('/api/tool', agent, { action: 'status' })).json(); assert.equal(status.ok, true);
    assert.ok(!JSON.stringify(status).includes(admin)); assert.ok(!JSON.stringify(status).includes(agent));
    const page = await fetch(app.url); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await page.text(), /403\/40362/);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('bin/mcp.js')], env: { ...process.env, DSH_ZHIHU_HOME: dir, DSH_ZHIHU_URL: app.url }, stderr: 'pipe' }));
    const list = await client.listTools(); assert.equal(list.tools.length, 1); assert.equal(list.tools[0].name, 'zhihu_browse');
    assert.ok(list.tools[0].inputSchema.properties.action.enum.includes('vote_up'));
    assert.ok(!list.tools[0].inputSchema.properties.action.enum.includes('configure_api'));
    const result = await client.callTool({ name: 'zhihu_browse', arguments: { action: 'status' } });
    assert.equal(JSON.parse(result.content[0].text).ok, true);
    assert.equal(upstream, 0);
  } finally { await client.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
