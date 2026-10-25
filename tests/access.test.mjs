import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertZhihuPage, makeZhihuAccessGate, persistZhihuSession, ZhihuAccessError } from '../lib/core/zhihu-access.js';
import { makeZhihuActivityReader } from '../lib/core/zhihu-activity-reader.js';

test('HTTP 40362 denial is distinguished from a captcha and an ordinary unloaded page', () => {
  assert.throws(() => assertZhihuPage({ httpStatus: 403, pathname: '/question/1/answer/2', contentVisible: false,
    text: JSON.stringify({ error: { code: 40362, message: '您当前请求存在异常，暂时限制本次访问。' } }) }), e => e instanceof ZhihuAccessError && e.code === 'ACCESS_DENIED' && e.detail.businessCode === 40362);
  assert.throws(() => assertZhihuPage({ httpStatus: 200, contentVisible: false, text: '请完成安全验证' }), e => e.code === 'VERIFICATION_REQUIRED');
  assert.throws(() => assertZhihuPage({ contentVisible: true, challengeVisible: true }), e => e.code === 'VERIFICATION_REQUIRED');
  assert.throws(() => assertZhihuPage({ httpStatus: 429, contentVisible: false }), e => e.code === 'RATE_LIMITED');
  assert.throws(() => assertZhihuPage({ pathname: '/signin', contentVisible: false }), e => e.code === 'LOGIN_REQUIRED');
  assert.throws(() => assertZhihuPage({ httpStatus: 200, contentVisible: false, text: '' }), e => !(e instanceof ZhihuAccessError));
  assert.doesNotThrow(() => assertZhihuPage({ httpStatus: 403, contentVisible: true, text: '一篇讨论安全验证的普通文章' }));
});

async function fixture(work) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-access-'));
  try { await work(stateDir); } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
}
test('a denial survives restart, blocks all browser entry points before launch, and requires operator recovery', () => fixture(async stateDir => {
  const gate = makeZhihuAccessGate({ stateDir, now: () => 1000 });
  gate.record(new Error('ordinary page timeout'));
  assert.equal(gate.status().blocked, false);
  gate.record(new ZhihuAccessError('ACCESS_DENIED', '知乎拒绝访问', { httpStatus: 403, businessCode: 40362 }));
  assert.throws(() => makeZhihuAccessGate({ stateDir }).assertAllowed(), /拒绝访问/);
  fs.writeFileSync(path.join(stateDir, 'zhihu-activity-login.json'), JSON.stringify({ saved: true, sessionId: 'fixture', account: { profileUrl: 'https://www.zhihu.com/people/bot-fixture' } }));
  fs.writeFileSync(path.join(stateDir, 'zhihu-activity-session.json'), '{"cookies":[],"origins":[]}');
  // An invalid executable proves denied reads never try to launch Chromium.
  const reader = makeZhihuActivityReader({ stateDir, executablePath: '/this-browser-must-not-launch', directApi: false });
  assert.equal((await reader.status()).access.blocked, true);
  await assert.rejects(reader.self.feed(), /拒绝访问/);
  await assert.rejects(reader.self.read('https://www.zhihu.com/question/1/answer/2'), /拒绝访问/);
  await assert.rejects(reader.read('https://www.zhihu.com/people/owner-fixture'), /拒绝访问/);
  assert.equal((await reader.resumeAccess()).access.blocked, false);
  assert.equal(makeZhihuAccessGate({ stateDir }).status().blocked, false);
  assert.equal(fs.statSync(path.join(stateDir, 'zhihu-web-access.json')).mode & 0o777, 0o600);
  await reader.close();
}));

test('session refresh is private, preserves the login identity, and cannot resurrect a replaced or removed login', () => fixture(async stateDir => {
  const sessionFile = path.join(stateDir, 'session.json'), metaFile = path.join(stateDir, 'meta.json');
  const meta = { sessionId: 'fixture-a', account: { profileUrl: 'https://www.zhihu.com/people/bot-fixture' } };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  const state = { cookies: [{ name: 'fixture-cookie', value: 'updated-fixture-value' }], origins: [] };
  const options = { sessionId: 'fixture-a', sessionFile, metaFile, context: { storageState: async () => state } };
  assert.equal(await persistZhihuSession(options), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile)), state);
  assert.deepEqual(JSON.parse(fs.readFileSync(metaFile)), meta);
  assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
  let release; options.context.storageState = () => new Promise(resolve => { release = resolve; });
  const pending = persistZhihuSession(options);
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, sessionId: 'fixture-b' }));
  release({ cookies: [{ name: 'must-not-be-saved' }] });
  assert.equal(await pending, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile)), state);
  fs.rmSync(metaFile); assert.equal(await persistZhihuSession(options), false);
}));

test('the actual reader persists refreshed sessions, records a blocked response, closes the browser and does not retry it', () => fixture(async stateDir => {
  fs.writeFileSync(path.join(stateDir, 'zhihu-activity-login.json'), JSON.stringify({ saved: true, sessionId: 'fixture', account: { profileUrl: 'https://www.zhihu.com/people/bot-fixture' } }));
  const sessionFile = path.join(stateDir, 'zhihu-activity-session.json');
  fs.writeFileSync(sessionFile, '{"cookies":[],"origins":[]}');
  let blocked = false, launches = 0, closes = 0;
  const state = { cookies: [{ name: 'fixture-refresh', value: 'new-fixture-value' }], origins: [] };
  const page = { goto: async () => ({ status: () => blocked ? 403 : 200 }), url: () => 'https://www.zhihu.com/',
    locator: selector => selector === 'body' ? { innerText: async () => '{"error":{"code":40362}}' } : {
      first: () => ({ waitFor: async () => { if (blocked) throw new Error('not visible'); } }),
      evaluateAll: async () => [{ title: '测试推荐', links: [{ url: 'https://www.zhihu.com/question/1/answer/2' }] }],
    } };
  const context = { routeWebSocket: async () => {}, route: async () => {}, newPage: async () => page, storageState: async () => state };
  const reader = makeZhihuActivityReader({ stateDir, directApi: false, browserType: { launch: async () => { launches++; return { newContext: async () => context, close: async () => { closes++; } }; } } });
  assert.equal((await reader.self.feed()).items.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile)), state);
  blocked = true;
  await assert.rejects(reader.self.feed(), /40362/);
  assert.equal((await reader.status()).access.code, 'ACCESS_DENIED');
  assert.equal(closes, 1);
  await assert.rejects(reader.self.feed(), /恢复前不会再次访问/);
  assert.equal(launches, 1);
  await reader.close();
}));
