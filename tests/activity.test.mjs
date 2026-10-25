import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeActivityRows, assertActivityPageReadable } from '../lib/core/zhihu-activity-reader.js';
import { makeZhihuActivityWatch } from '../lib/core/zhihu-activity-watch.js';
const profileUrl = 'https://www.zhihu.com/people/owner-fixture';
const accountProfile = 'https://www.zhihu.com/people/bot-fixture';
const row = (id, time = '2026-10-25 10:00') => ({ meta: '赞同了回答\n' + time, time,
  title: '旧文章也可以是刚点赞', summary: '公开摘要', links: [{ url: `https://www.zhihu.com/question/1/answer/${id}`, title: '来源' }] });
const event = id => normalizeActivityRows([row(id)], profileUrl)[0];
test('readability follows rendered profile and actual challenge UI, not the initial HTTP status', () => {
  const loaded = { httpStatus: 403, pathname: '/people/owner-fixture', profileVisible: true, cardCount: 14, empty: false, chromeText: '关注 推荐 热榜' };
  assert.doesNotThrow(() => assertActivityPageReadable(loaded));
  assert.doesNotThrow(() => assertActivityPageReadable({ ...loaded, cardCount: 0, empty: true }));
  assert.throws(() => assertActivityPageReadable({ ...loaded, profileVisible: false, cardCount: 0 }), /HTTP 403/);
  assert.throws(() => assertActivityPageReadable({ ...loaded, chromeText: '请完成安全验证' }), /验证控件/);
  assert.throws(() => assertActivityPageReadable({ ...loaded, httpStatus: 200, pathname: '/signin' }), /重新登录/);
  assert.throws(() => assertActivityPageReadable({ ...loaded, httpStatus: 200, cardCount: 0 }), /未加载/);
});
async function fixture(fn) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-activity-'));
  const write = (name, obj) => fs.writeFileSync(path.join(stateDir, name), JSON.stringify(obj));
  write('zhihu-owner-watch.json', { profileUrl });
  write('zhihu-activity-login.json', { saved: true, sessionId: 'test-session', account: { profileUrl: accountProfile } });
  write('zhihu-activity-session.json', { cookies: [] });
  let items = [event(1)], fail = false, gate;
  const options = { stateDir, sourceRead: async () => {
    if (gate) await gate; if (fail) throw new Error('HTTP 403: requires verification');
    return { ok: true, profileUrl, accountProfile, sessionId: 'test-session', items, inspectedCards: items.length };
  } };
  const watch = makeZhihuActivityWatch(options);
  try { await fn({ watch, stateDir, write, options, setItems: x => { items = x; }, setFail: x => { fail = x; }, setGate: x => { gate = x; } }); }
  finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
}
test('like detection uses action metadata, stable IDs and real source links', () => {
  const first = normalizeActivityRows([row(1), row(1, '刚刚'), { ...row(2), meta: '回答了问题' }, { ...row(3), meta: '关注了问题' }], profileUrl);
  assert.equal(first.length, 1); assert.equal(first[0].action, '赞同'); assert.equal(first[0].url, row(1).links[0].url);
  assert.equal(first[0].id, normalizeActivityRows([row(1, '10分钟前')], profileUrl)[0].id);
  assert.equal(normalizeActivityRows([{ ...row(1), links: [{ url: 'https://evil.test/question/1/answer/1' }] }], profileUrl).length, 0);
  assert.equal(normalizeActivityRows([{ ...row(1), meta: '发布了想法，获得了100个点赞' }], profileUrl).length, 0);
});
test('baseline excludes old likes; newly discovered likes on old content remain pending until actual send acknowledgement', () => fixture(async ({ watch, setItems, options }) => {
  const baseline = await watch.check(); assert.equal(baseline.initialized, true); assert.equal(baseline.items.length, 0);
  setItems([event(2), event(1)]);
  assert.equal((await watch.check()).items[0].id, event(2).id);
  assert.equal((await makeZhihuActivityWatch(options).check()).pendingCount, 1);
  await assert.rejects(watch.acknowledge([event(99).id]), /未发现/);
  await watch.acknowledge([event(2).id]);
  assert.equal((await watch.check()).pendingCount, 0);
  assert.equal((await watch.acknowledge([event(2).id])).ok, true);
}));
test('recent view reports existing likes without consuming pending updates', () => fixture(async ({ watch, setItems }) => {
  await watch.check(); setItems([event(2), event(1)]);
  assert.equal((await watch.recent()).items.length, 2);
  assert.equal((await watch.check()).pendingCount, 1);
}));
test('recent likes page through all loaded cards without changing baseline or pending items', () => fixture(async ({ watch, setItems, stateDir, setFail }) => {
  setItems(Array.from({ length: 13 }, (_, i) => event(i + 1))); await watch.check();
  const before = fs.readFileSync(path.join(stateDir, 'zhihu-activity-watch.json'), 'utf8');
  const first = await watch.recent({ offset: 0, limit: 10 });
  assert.equal(first.items.length, 10); assert.equal(first.loadedLikes, 13);
  assert.equal(first.Paging.IsEnd, false); assert.equal(first.Paging.NextOffset, '10');
  const next = await watch.recent({ offset: Number(first.Paging.NextOffset), limit: 10 });
  assert.equal(next.items.length, 3); assert.equal(next.Paging.IsEnd, true); assert.equal(next.Paging.NextOffset, undefined);
  assert.equal(new Set([...first.items, ...next.items].map(x => x.id)).size, 13);
  assert.equal(fs.readFileSync(path.join(stateDir, 'zhihu-activity-watch.json'), 'utf8'), before);
  setFail(true);
  for (const args of [{ limit: 0 }, { limit: 11 }, { offset: -1 }, { offset: 0.5 }]) await assert.rejects(watch.recent(args), /分页参数/);
}));
test('failed website read preserves baseline and pending state', () => fixture(async ({ watch, stateDir, setFail }) => {
  await watch.check(); const before = fs.readFileSync(path.join(stateDir, 'zhihu-activity-watch.json'), 'utf8');
  setFail(true); await assert.rejects(watch.check(), /verification/);
  assert.equal(fs.readFileSync(path.join(stateDir, 'zhihu-activity-watch.json'), 'utf8'), before);
}));
test('pause and target changes revoke an in-flight check without overwriting state', () => fixture(async ({ watch, setGate, write }) => {
  await watch.check(); let release;
  setGate(new Promise(resolve => { release = resolve; }));
  const pending = watch.check(); await new Promise(resolve => setImmediate(resolve));
  watch.setEnabled(false); release(); await assert.rejects(pending, /暂停/);
  watch.setEnabled(true); setGate(null);
  write('zhihu-owner-watch.json', { profileUrl: 'https://www.zhihu.com/people/changed-fixture' });
  await assert.rejects(watch.check(), /配置已变化/);
}));
test('missing browser login fails clearly and cannot acknowledge old content', () => fixture(async ({ watch, stateDir }) => {
  await watch.check(); fs.rmSync(path.join(stateDir, 'zhihu-activity-login.json'));
  assert.equal(watch.status().ready, false);
  await assert.rejects(watch.check(), /扫码登录/);
  await assert.rejects(watch.acknowledge([event(1).id]), /账号或配置/);
}));
