import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeZhihuActivityReader } from '../lib/core/zhihu-activity-reader.js';
import { htmlText, normalizeApiFeed } from '../lib/core/zhihu-direct-api.js';
import { makeZhihuAccessGate, savePrivateJson, ZhihuAccessError } from '../lib/core/zhihu-access.js';

const actor = 'https://www.zhihu.com/people/bot-fixture', url = 'https://www.zhihu.com/question/1/answer/2';
async function fixture(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-direct-'));
  const metaFile = path.join(dir, 'zhihu-activity-login.json'), sessionFile = path.join(dir, 'zhihu-activity-session.json');
  const meta = { saved: true, sessionId: 'fixture-a', account: { profileUrl: actor } };
  savePrivateJson(metaFile, meta);
  savePrivateJson(sessionFile, { cookies: [{ name: '_xsrf', value: 'fixture-xsrf', domain: '.zhihu.com' }], origins: [{ origin: 'https://www.zhihu.com', localStorage: [{ name: 'fixture', value: 'preserved' }] }] });
  let html = '<p>完整的正文 &amp; 观点。</p>', voting = 0, enabled = true, account = 'bot-fixture', truncated = false, status = 200, throwPost = false, confirm = true, beforePost, afterRead, launches = 0;
  const calls = [];
  const requestFactory = { newContext: async options => {
    assert.equal(options.maxRedirects, 0);
    return {
      storageState: async () => ({ cookies: [...options.storageState.cookies, { name: 'fixture-refresh', value: 'refreshed', domain: '.zhihu.com' }], origins: [] }), dispose: async () => {},
      fetch: async (raw, init) => {
        const u = new URL(raw); calls.push({ path: u.pathname, method: init.method, data: init.data });
        assert.equal(u.origin, 'https://www.zhihu.com'); assert.equal(init.maxRetries, 0); assert.equal(init.maxRedirects, 0);
        let data;
        if (init.method === 'POST') {
          beforePost?.(); if (throwPost) throw new Error('sensitive headers must not be reflected');
          assert.deepEqual(init.data, { type: 'up' }); if (confirm) voting = 1; data = { success: true };
        } else if (u.pathname === '/api/v4/me') data = { url_token: account };
        else if (u.pathname.includes('/feed/')) data = { data: [{ target: { type: 'answer', id: '2', url: 'https://api.zhihu.com/answers/2', question: { id: '1', title: '测试问题' }, excerpt: '摘要' } }] };
        else { data = { type: 'answer', id: '2', url: 'https://www.zhihu.com/api/v4/answers/2', question: { title: '测试问题' }, content: html, relationship: { voting }, content_need_truncated: truncated }; afterRead?.(); }
        return { status: () => status, headers: () => ({}), text: async () => JSON.stringify(status === 403 ? { error: { code: 40362, message: 'secret must not be reflected' } } : data) };
      },
    };
  } };
  const reader = makeZhihuActivityReader({ stateDir: dir, requestFactory, browserType: { launch: async () => { launches++; throw new Error('must not launch'); } }, interactionPolicy: () => ({ enabled, accountProfile: actor }) });
  const change = values => {
    if ('html' in values) html = values.html; if ('voting' in values) voting = values.voting;
    if ('enabled' in values) enabled = values.enabled; if ('account' in values) account = values.account;
    if ('truncated' in values) truncated = values.truncated; if ('status' in values) status = values.status;
    if ('throwPost' in values) throwPost = values.throwPost; if ('confirm' in values) confirm = values.confirm;
    if ('afterRead' in values) afterRead = values.afterRead; if ('beforePost' in values) beforePost = values.beforePost;
  };
  try { await work({ reader, dir, calls, change, meta, metaFile, sessionFile, launches: () => launches }); }
  finally { await reader.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
test('HTML is returned as text and exact large answer/question IDs survive recommendation extraction', () => {
  assert.equal(htmlText('<script>bad()</script><p>A &amp; B &#x1f40b;</p><p>&lt;literal&gt;<img src="x"></p>'), 'A & B 🐋\n<literal>[图片]');
  const result = normalizeApiFeed({ data: [{ target: { type: 'answer', id: 2087854578842784000, url: 'https://api.zhihu.com/answers/2087854578842784085', question: { id: 1898614853867930000, url: 'https://www.zhihu.com/api/v4/questions/1898614853867929931', title: '问题' } } }] });
  assert.equal(result[0].url, 'https://www.zhihu.com/question/1898614853867929931/answer/2087854578842784085');
});
test('recommendations and complete answer reading use HTTP with no Chromium, preserving cookies and browser localStorage', () => fixture(async ({ reader, dir, sessionFile, launches }) => {
  makeZhihuAccessGate({ stateDir: dir }).record(new ZhihuAccessError('ACCESS_DENIED', 'browser-only denied'));
  const feed = await reader.self.feed(), read = await reader.self.read(feed.items[0].url);
  assert.equal(read.transport, 'website-api'); assert.equal(read.content, '完整的正文 & 观点。'); assert.ok(read.readToken);
  assert.equal(launches(), 0);
  const saved = JSON.parse(fs.readFileSync(sessionFile));
  assert.ok(saved.cookies.some(c => c.name === 'fixture-refresh')); assert.equal(saved.origins[0].localStorage[0].value, 'preserved');
  assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
  assert.equal((await reader.status()).access.blocked, true); assert.equal((await reader.status()).apiAccess.blocked, false);
}));
test('new upvote requires a read proof, rechecks body, sends exactly one POST and confirms state before audit', () => fixture(async ({ reader, dir, calls, launches }) => {
  await assert.rejects(reader.self.upvote({ readToken: 'invented', reason: '同意' }), /先用/);
  const read = await reader.self.read(url);
  const result = await reader.self.upvote({ readToken: read.readToken, reason: '认同正文的观点' });
  assert.equal(result.submitted, true); assert.equal(result.transport, 'website-api'); assert.equal(launches(), 0);
  assert.deepEqual(calls.filter(c => c.method === 'POST'), [{ path: '/api/v4/answers/2/voters', method: 'POST', data: { type: 'up' } }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'zhihu-self-upvotes.json'))).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'zhihu-api-vote-attempts.json')))[0].status, 'confirmed');
  await assert.rejects(reader.self.upvote({ readToken: read.readToken, reason: '同意' }), /失效/);
}));
test('already-upvoted answers never POST, and truncated/unknown/downvote states never receive a proof', () => fixture(async ({ reader, calls, change }) => {
  change({ voting: 1 }); const read = await reader.self.read(url);
  assert.equal((await reader.self.upvote({ readToken: read.readToken, reason: '同意' })).submitted, false);
  assert.equal(calls.some(x => x.method === 'POST'), false);
  for (const state of [{ voting: 0, truncated: true }, { truncated: false, voting: null }, { voting: -1 }]) {
    change(state); assert.equal((await reader.self.read(url)).readToken, undefined);
  }
}));
test('changed source HTML and revoked interaction policy are checked before sending a vote', () => fixture(async ({ reader, change, calls }) => {
  const read = await reader.self.read(url);
  change({ html: '<p>changed</p>' }); await assert.rejects(reader.self.upvote({ readToken: read.readToken, reason: '同意' }), /正文发生变化/);
  change({ html: '<p>完整的正文 &amp; 观点。</p>', enabled: false });
  await assert.rejects(reader.self.upvote({ readToken: read.readToken, reason: '同意' }), /尚未启用/);
  assert.equal(calls.some(x => x.method === 'POST'), false);
}));
test('wrong HTTP account and session replacement stop before a vote and never overwrite the replacement', () => fixture(async ({ reader, change, metaFile, meta, sessionFile, calls }) => {
  change({ account: 'another-account' }); await assert.rejects(reader.self.read(url), /账号不符/);
  await reader.resumeAccess(); change({ account: 'bot-fixture' });
  const read = await reader.self.read(url), before = fs.readFileSync(sessionFile, 'utf8');
  change({ afterRead: () => savePrivateJson(metaFile, { ...meta, sessionId: 'fixture-b' }) });
  await assert.rejects(reader.self.upvote({ readToken: read.readToken, reason: '同意' }), /会话已变化/);
  assert.equal(calls.some(x => x.method === 'POST'), false); assert.equal(fs.readFileSync(sessionFile, 'utf8'), before);
}));
test('API denial is persisted separately, never falls back to the browser, and never retries on later calls', () => fixture(async ({ reader, dir, change, calls, launches }) => {
  change({ status: 403 }); await assert.rejects(reader.self.feed(), /40362/);
  const count = calls.length;
  await assert.rejects(reader.self.read(url), /恢复前不会再次访问知乎接口/);
  assert.equal(calls.length, count); assert.equal(launches(), 0);
  assert.equal((await reader.status()).apiAccess.blocked, true); assert.equal((await reader.status()).access.blocked, false);
  assert.equal(fs.statSync(path.join(dir, 'zhihu-api-access.json')).mode & 0o777, 0o600);
}));
test('an interrupted POST is not retried, and a pending attempt blocks future resubmission even with a fresh proof', () => fixture(async ({ reader, change, calls }) => {
  const read = await reader.self.read(url); change({ throwPost: true });
  await assert.rejects(reader.self.upvote({ readToken: read.readToken, reason: '同意' }), /结果未确认/);
  assert.equal(calls.filter(x => x.method === 'POST').length, 1);
  change({ throwPost: false }); const again = await reader.self.read(url);
  await assert.rejects(reader.self.upvote({ readToken: again.readToken, reason: '同意' }), /上次赞同结果尚未确认/);
  assert.equal(calls.filter(x => x.method === 'POST').length, 1);
}));
test('HTTP success without confirmed voting state is not reported as a successful upvote', () => fixture(async ({ reader, change, dir }) => {
  change({ confirm: false }); const read = await reader.self.read(url);
  await assert.rejects(reader.self.upvote({ readToken: read.readToken, reason: '同意' }), /接口状态未确认/);
  assert.equal(fs.existsSync(path.join(dir, 'zhihu-self-upvotes.json')), false);
}));
