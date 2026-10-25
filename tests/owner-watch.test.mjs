import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeZhihuReader } from '../lib/core/zhihu-reader.js';
import { canonicalZhihuContent } from '../lib/core/zhihu-owner-watch.js';

const profileUrl = 'https://www.zhihu.com/people/owner-fixture';
const botSecret = 'bot-fixture-access-secret', ownerSecret = 'owner-fixture-access-secret';
const item = (id, CreatedAt = 1_800_000_001) => ({ ContentType: 'pin', Url: `https://www.zhihu.com/pin/${id}`, CreatedAt, Title: '新想法', Summary: '一段公开摘要' });
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-owner-watch-'));
  let items = [item(1, 1_799_000_000)], fail = false, gate;
  const calls = [];
  const options = { credentialsPath: path.join(root, 'zhihu-credentials.json'), now: () => 1_800_000_000_000,
    fetchImpl: async (raw, init) => {
      const url = new URL(raw); calls.push({ url, auth: init.headers.authorization });
      if (gate) await gate;
      if (fail) return new Response('private credential must not appear: ' + ownerSecret, { status: 403 });
      return new Response(JSON.stringify({ Code: 0, Data: url.pathname.endsWith('/contents') ? { Items: items, Paging: { IsEnd: true } } : {} }));
    } };
  const reader = makeZhihuReader(options);
  const setup = async () => { await reader.configure(botSecret); return reader.configureOwnerWatch({ accessSecret: ownerSecret, profileUrl, confirmAccount: true }); };
  try { await fn({ reader, root, options, calls, setup, setItems: v => { items = v; }, setFail: v => { fail = v; }, setGate: v => { gate = v; } }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('separate owner credentials, baseline and private files; no credential is returned', () => fixture(async ({ reader, root, calls, setup }) => {
  const result = await setup();
  assert.equal(result.enabled, true); assert.equal(result.baselineItems, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'zhihu-credentials.json'))).accessSecret, botSecret);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'zhihu-owner-credentials.json'))).accessSecret, ownerSecret);
  assert.equal(fs.statSync(path.join(root, 'zhihu-owner-credentials.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, 'zhihu-owner-watch.json')).mode & 0o777, 0o600);
  assert.equal(calls.at(-1).auth, 'Bearer ' + ownerSecret);
  assert.equal(JSON.stringify(result).includes(ownerSecret), false);
  assert.equal(JSON.stringify(reader.status()).includes(ownerSecret), false);
  await reader.run('my_contents'); assert.equal(calls.at(-1).auth, 'Bearer ' + botSecret);
}));
test('new discoveries remain pending until acknowledged and stay deduplicated after reload', () => fixture(async ({ reader, setup, setItems, options }) => {
  await setup(); setItems([item(2), item(1, 1_799_000_000), item(3, 1_799_999_999)]);
  assert.deepEqual((await reader.run('owner_updates')).items.map(x => x.Url), [item(2).Url]);
  assert.equal((await reader.run('owner_updates')).items.length, 1, 'unsent item must survive retries');
  await assert.rejects(reader.run('owner_updates_ack', { urls: [item(99).Url] }), /未发现/);
  assert.equal((await reader.run('owner_updates')).items.length, 1);
  await reader.run('owner_updates_ack', { urls: [item(2).Url] });
  assert.equal((await makeZhihuReader(options).run('owner_updates')).items.length, 0);
  assert.equal((await reader.run('owner_updates_ack', { urls: [item(2).Url] })).ok, true, 'ack is idempotent');
}));
test('explicit account confirmation and valid separate credentials are required before any request', () => fixture(async ({ reader, calls, setup }) => {
  await assert.rejects(reader.configureOwnerWatch({ accessSecret: ownerSecret, profileUrl }), /确认/);
  assert.equal(calls.length, 0);
  await setup(); const count = calls.length;
  await assert.rejects(reader.configureOwnerWatch({ accessSecret: botSecret, profileUrl, confirmAccount: true }), /她现有/);
  assert.equal(calls.length, count);
}));
test('upstream failure and malformed content never advance the saved watch state', () => fixture(async ({ reader, root, setup, setFail, setItems }) => {
  await setup(); const file = path.join(root, 'zhihu-owner-watch.json'), before = fs.readFileSync(file, 'utf8');
  setFail(true); await assert.rejects(reader.run('owner_updates'), e => !e.message.includes(ownerSecret));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  setFail(false); setItems([{ ...item(2), Url: 'https://evil.test/pin/2' }]);
  await assert.rejects(reader.run('owner_updates'), /链接不合法/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
}));
test('disabling during an in-flight read cancels it and removes only owner credentials', () => fixture(async ({ reader, root, setup, setGate }) => {
  await setup(); let release; setGate(new Promise(resolve => { release = resolve; }));
  const pending = reader.run('owner_updates');
  await new Promise(resolve => setImmediate(resolve));
  reader.disableOwnerWatch(); release();
  await assert.rejects(pending, /尚未启用/);
  assert.equal(reader.status().ownerWatch.enabled, false);
  assert.equal(fs.existsSync(path.join(root, 'zhihu-owner-credentials.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'zhihu-credentials.json'))).accessSecret, botSecret);
}));
test('changing owner credential file invalidates binding without fetching or returning pending content', () => fixture(async ({ reader, root, setup, calls }) => {
  await setup(); const count = calls.length;
  fs.writeFileSync(path.join(root, 'zhihu-owner-credentials.json'), JSON.stringify({ accessSecret: 'different-owner-secret' }));
  assert.equal(reader.status().ownerWatch.enabled, false);
  await assert.rejects(reader.run('owner_updates'), /尚未启用/); assert.equal(calls.length, count);
}));
test('concurrent reads merge discoveries once instead of duplicating pending items', () => fixture(async ({ reader, setup, setItems }) => {
  await setup(); setItems([item(2), item(2)]);
  const rows = await Promise.all([reader.run('owner_updates'), reader.run('owner_updates')]);
  assert.deepEqual(rows.map(row => row.pendingCount), [1, 1]);
}));
test('content links only accept fixed Zhihu content paths', () => {
  const credentialUrl = new URL('https://www.zhihu.com/pin/2');
  credentialUrl.username = 'fixture'; credentialUrl.password = 'fixture';
  for (const url of ['file:///etc/passwd', 'https://www.zhihu.com.evil.test/pin/2', credentialUrl.href, 'https://www.zhihu.com/people/owner']) assert.throws(() => canonicalZhihuContent(url));
  assert.equal(canonicalZhihuContent('https://www.zhihu.com/pin/2?tracking=3'), 'https://www.zhihu.com/pin/2');
});
