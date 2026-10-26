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
test('retired browser state is preserved but cannot pause HTTP operations; active scopes persist independently',()=>fixture(async stateDir=>{
  const old=makeZhihuAccessGate({stateDir});old.record(new ZhihuAccessError('ACCESS_DENIED','old browser denial'));
  const account=makeZhihuAccessGate({stateDir,fileName:'zhihu-account-api-access.json'});account.record(new ZhihuAccessError('ACCESS_DENIED','account denied'));
  fs.writeFileSync(path.join(stateDir,'zhihu-activity-login.json'),JSON.stringify({saved:true,sessionId:'fixture',account:{profileUrl:'https://www.zhihu.com/people/bot-fixture'}}));
  fs.writeFileSync(path.join(stateDir,'zhihu-activity-session.json'),'{}');
  let requests=0;const reader=makeZhihuActivityReader({stateDir,requestFactory:{newContext:async()=>{requests++;throw new Error('must not request')}}});
  try{
    await assert.rejects(reader.self.feed(),/account denied/);await assert.rejects(reader.read('https://www.zhihu.com/people/owner-fixture'),/account denied/);assert.equal(requests,0);
    assert.equal((await reader.status()).browserRequired,false);assert.equal((await reader.status()).access.retired,true);
    await reader.resumeAccess();assert.equal(account.status().blocked,false);assert.equal(old.status().blocked,true);
  }finally{await reader.close()}
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
