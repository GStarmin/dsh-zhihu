import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeZhihuSelfBrowse, allowedUpvoteRequest, votableContent, normalizeFeed } from '../lib/core/zhihu-self-browse.js';
const url = 'https://www.zhihu.com/question/1/answer/2', actor = 'https://www.zhihu.com/people/bot-fixture';
test('the only allowed write is an upvote to the exact observed content', () => {
  const target = votableContent(url), request = { url: 'https://www.zhihu.com/api/v4/answers/2/voters', method: 'POST', body: '{"type":"up"}' };
  assert.equal(allowedUpvoteRequest(request, target), true);
  for (const bad of [{ method: 'DELETE' }, { method: 'PUT' }, { body: '{"type":"down"}' }, { body: 'null' }, { body: '{"type":"up","extra":1}' }, { url: 'https://evil.test/api/v4/answers/2/voters' }, { url: 'https://www.zhihu.com/api/v4/answers/3/voters' }, { url: request.url + '?extra=1' }]) assert.equal(allowedUpvoteRequest({ ...request, ...bad }, target), false);
  assert.equal(allowedUpvoteRequest(request), false);
  assert.throws(() => votableContent('https://www.zhihu.com/question/1'));
});
test('recommendation extraction rejects outside links and deduplicates source content', () => {
  const rows = [{ title: '原文', links: [{ url: 'https://evil.test/answer/2' }, { url }] }, { links: [{ url }] }];
  assert.deepEqual(normalizeFeed(rows).map(x => x.url), [url]);
});
test('failed navigation reports login, platform refusal, and unloaded pages without retries', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-navigation-'));
  try {
    for (const [pathname, body, expected, httpStatus] of [['/signin', '', /重新登录/, 403], ['/', '您当前请求存在异常，暂时限制本次访问', /拒绝本次访问/, 403], ['/', '', /没有正常加载/, 200]]) {
      let navigations = 0;
      const page = { goto: async () => { navigations++; return { status: () => httpStatus }; }, url: () => 'https://www.zhihu.com' + pathname, title: async () => '知乎',
        locator: selector => selector === 'body' ? { innerText: async () => body } : { first: () => ({ waitFor: async () => { throw new Error('timeout'); } }) } };
      const self = makeZhihuSelfBrowse({ stateDir, withPage: work => work(page, { account: { profileUrl: actor } }) });
      await assert.rejects(self.feed(), expected);
      assert.equal(navigations, 1);
    }
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});
async function fixture(fn) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-self-'));
  let at = 100000, text = '一篇真正读过的正文。', active = false, enabled = true, actorProfile = actor, sessionId = 'session-a', clicked = 0, resolveResponse, predicate, policy;
  const root = {
    getAttribute: async () => JSON.stringify({ itemId: '2' }),
    innerText: async () => text,
    locator: selector => selector === 'button.ContentItem-more' ? { count: async () => 0 } : selector === '.RichText' ? { first: () => ({ innerText: async () => text }) } : { first: () => button },
  };
  const button = { count: async () => 1, isVisible: async () => true,
    evaluate: async fn => fn({ classList: { contains: () => active }, getAttribute: () => null, innerText: active ? '已赞同' : '赞同' }),
    click: async () => {
      const request = { url: 'https://www.zhihu.com/api/v4/answers/2/voters', method: 'POST', body: '{"type":"up"}' };
      assert.equal(allowedUpvoteRequest(request, policy.voteTarget), true);
      clicked++; active = true;
      const response = { url: () => request.url, ok: () => true, request: () => ({ method: () => request.method, postData: () => request.body }) };
      assert.ok(predicate(response)); resolveResponse(response);
    },
  };
  const page = { url: () => url, title: async () => '正文标题', locator: selector => selector === '.AnswerItem' ? { count: async () => 1, nth: () => root } : { innerText: async () => '导航\n' + text },
    waitForResponse: fn => { predicate = fn; return new Promise(r => { resolveResponse = r; }); }, waitForTimeout: async () => {} };
  const currentSession = () => ({ saved: true, sessionId, account: { profileUrl: actorProfile } });
  const self = makeZhihuSelfBrowse({ stateDir, now: () => at, currentSession, interactionPolicy: () => ({ enabled, accountProfile: actor }),
    withPage: async (work, options = {}) => { policy = options; return work(page, currentSession()); } });
  try { await fn({ self, clicks: () => clicked, change: values => { if ('text' in values) text = values.text; if ('active' in values) active = values.active; if ('enabled' in values) enabled = values.enabled; if ('at' in values) at = values.at; if ('sessionId' in values) sessionId = values.sessionId; if ('actorProfile' in values) actorProfile = values.actorProfile; } }); }
  finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
}
test('upvote requires a current reading proof and a bound bot account', () => fixture(async ({ self, change, clicks }) => {
  await assert.rejects(self.upvote({ readToken: 'invented', reason: '认同正文' }), /先用/);
  const read = await self.read(url); assert.equal(read.content, '一篇真正读过的正文。');
  change({ enabled: false }); await assert.rejects(self.upvote({ readToken: read.readToken, reason: '认同正文' }), /尚未启用/);
  change({ enabled: true, actorProfile: 'https://www.zhihu.com/people/owner' }); await assert.rejects(self.upvote({ readToken: read.readToken, reason: '认同正文' }), /不是/);
  change({ actorProfile: actor, sessionId: 'session-b' }); await assert.rejects(self.upvote({ readToken: read.readToken, reason: '认同正文' }), /账号变化/);
  assert.equal(clicks(), 0);
}));
test('expired or changed content cannot be upvoted', () => fixture(async ({ self, change, clicks }) => {
  const read = await self.read(url);
  change({ text: '已经改变的正文' }); await assert.rejects(self.upvote({ readToken: read.readToken, reason: '认同正文' }), /正文发生变化/);
  change({ at: 2000000 }); await assert.rejects(self.upvote({ readToken: read.readToken, reason: '认同正文' }), /失效/);
  assert.equal(clicks(), 0);
}));
test('an existing upvote is never toggled off', () => fixture(async ({ self, change, clicks }) => {
  change({ active: true }); const read = await self.read(url);
  const result = await self.upvote({ readToken: read.readToken, reason: '认同正文' });
  assert.equal(result.alreadyUpvoted, true); assert.equal(result.submitted, false); assert.equal(clicks(), 0);
}));
test('a confirmed upvote is audited and a repeat never clicks again', () => fixture(async ({ self, clicks }) => {
  const read = await self.read(url), args = { readToken: read.readToken, reason: '这段文字把观点讲清楚了' };
  const result = await self.upvote(args); assert.equal(result.submitted, true); assert.equal(clicks(), 1);
  await assert.rejects(self.upvote(args), /失效/);
  const readAgain = await self.read(url);
  assert.equal((await self.upvote({ ...args, readToken: readAgain.readToken })).previouslyRecorded, true); assert.equal(clicks(), 1);
}));
