import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../lib/runtime.js';
import { initialize, token } from '../lib/paths.js';
import { savePrivateJson, makeZhihuAccessGate, ZhihuAccessError } from '../lib/core/zhihu-access.js';
import { nativeDefinition, apply } from '../lib/index.js';
import { bridgeAuthorizer } from '../lib/qq-bridge.js';

test('independent runtime separates credentials, denies management through tools and requires login before enabling votes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-package-'));
  let calls = 0;
  const runtime = createRuntime({ stateDir: dir, executablePath: '/must-not-launch', fetchImpl: async () => { calls++; return new Response(JSON.stringify({ Code: 0, Data: {} })); } });
  try {
    assert.notEqual(token(dir, 'admin'), token(dir, 'agent'));
    assert.equal(fs.statSync(path.join(dir, 'agent-token')).mode & 0o777, 0o600);
    assert.equal((await runtime.tool('status')).upvoteEnabled, false);
    assert.equal('settings' in await runtime.tool('status'), false);
    assert.equal('qrImage' in (await runtime.tool('status')).web, false);
    await assert.rejects(runtime.tool('configure_api', { accessSecret: 'must-not-be-accepted' }));
    await assert.rejects(runtime.admin('settings', { upvoteEnabled: true }), /先扫码/);
    await runtime.admin('configure_api', { accessSecret: 'fixture-package-access-secret' });
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(await runtime.tool('status')).includes('fixture-package-access-secret'));
    const gate = makeZhihuAccessGate({ stateDir: dir });
    gate.record(new ZhihuAccessError('ACCESS_DENIED', 'fixture 40362'));
    await assert.rejects(runtime.tool('home_feed'), /需要先登录/);
    assert.equal((await runtime.admin('resume_access')).access.blocked, false);
    assert.equal(calls, 1);
  } finally { await runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DSH native authorization uses the real execution identity, not model supplied session fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-native-')); initialize(dir); let calls = 0;
  try {
    savePrivateJson(path.join(dir, 'settings.json'), { allowedSessionIds: ['session-approved'] });
    const tool = nativeDefinition({ stateDir: dir, call: async () => { calls++; return { ok: true }; } });
    await assert.rejects(tool.execute({ action: 'status', sessionId: 'session-approved' }, {}), /尚未获得/);
    await assert.rejects(tool.execute({ action: 'status' }, { agent: { session: { id: 'session-other' } } }), /尚未获得/);
    assert.equal(calls, 0);
    assert.equal((await tool.execute({ action: 'status' }, { agent: { session: { id: 'session-approved' } }, signal: new AbortController().signal })).ok, true);
    savePrivateJson(path.join(dir, 'settings.json'), { allowedSessionIds: [] });
    await assert.rejects(tool.execute({ action: 'status' }, { agent: { session: { id: 'session-approved' } } }), /尚未获得/);
    assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the installed DSH defineTool API accepts the native plugin registration', () => {
  const tools = []; apply({ tools: { register: tool => tools.push(tool) } });
  assert.equal(tools.length, 1); assert.equal(tools[0].name, 'zhihu_browse');
  assert.ok(tools[0].parameters.properties.action.enum.includes('home_feed'));
  assert.equal(typeof tools[0].execute, 'function');
});

test('QQ adapter requires the live bridge gate and fails closed for unsupported bridges or other users', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-qq-')); let requests = 0, granted = false;
  try {
    fs.mkdirSync(path.join(dir, 'state'));
    savePrivateJson(path.join(dir, 'config.json'), { ownerQQ: '123', consoleToken: 'fixture-console', socialV2: { tools: { zhihuRead: true } } });
    savePrivateJson(path.join(dir, 'state/sessions.json'), { sessions: { 'private:123': 'session-real' } });
    const authorize = bridgeAuthorizer({ configPath: path.join(dir, 'config.json'), fetchImpl: async (url, init) => {
      requests++; assert.equal(new URL(url).pathname, '/api/socialV2/autonomy-auth');
      assert.equal(JSON.parse(init.body).sessionId, 'session-real');
      return new Response(JSON.stringify({ allowed: granted }), { status: granted ? 200 : 404 });
    } });
    await assert.rejects(authorize({ key: 'private:999', token: 'fixture' })); assert.equal(requests, 0);
    await assert.rejects(authorize({ key: 'private:123', token: 'fixture' }), /不会放行/);
    granted = true; await authorize({ key: 'private:123', token: 'fixture' }); assert.equal(requests, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
