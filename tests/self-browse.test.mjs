import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeZhihuSelfBrowse, votableContent } from '../lib/core/zhihu-self-browse.js';
const url='https://www.zhihu.com/question/1/answer/2',actor='https://www.zhihu.com/people/bot-fixture';
test('content URLs are restricted to exact Zhihu answer/article targets',()=>{
  for(const raw of ['https://evil.test/answer/2','https://www.zhihu.com/question/1','http://www.zhihu.com/answer/2'])assert.throws(()=>votableContent(raw));
  assert.equal(votableContent('https://zhuanlan.zhihu.com/p/3').kind,'article');
});
async function fixture(fn){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'zhihu-self-'));
  let at=100000,text='一篇真正读过的正文。',active=false,enabled=true,actorProfile=actor,sessionId='session-a',submitted=0;
  const currentSession=()=>({saved:true,sessionId,account:{profileUrl:actorProfile}});
  const self=makeZhihuSelfBrowse({stateDir,now:()=>at,currentSession,interactionPolicy:()=>({enabled,accountProfile:actor}),
    imageLoader:async()=>({images:[],imageContent:[],imagePage:{total:0,loaded:0}}),
    answerAPI:{withSession:work=>work({},currentSession()),content:async()=>({text,title:'正文标题',alreadyUpvoted:active,canUpvote:true,transport:'website-api'}),
      upvote:async()=>{submitted++;active=true;return{confirmed:true}}}});
  try{await fn({self,clicks:()=>submitted,change:values=>{if('text'in values)text=values.text;if('active'in values)active=values.active;if('enabled'in values)enabled=values.enabled;if('at'in values)at=values.at;if('sessionId'in values)sessionId=values.sessionId;if('actorProfile'in values)actorProfile=values.actorProfile;}})}
  finally{fs.rmSync(stateDir,{recursive:true,force:true})}
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
test('a confirmed upvote is audited and a repeat never submits again', () => fixture(async ({ self, clicks }) => {
  const read = await self.read(url), args = { readToken: read.readToken, reason: '这段文字把观点讲清楚了' };
  const result = await self.upvote(args); assert.equal(result.submitted, true); assert.equal(clicks(), 1);
  await assert.rejects(self.upvote(args), /失效/);
  const readAgain = await self.read(url);
  assert.equal((await self.upvote({ ...args, readToken: readAgain.readToken })).previouslyRecorded, true); assert.equal(clicks(), 1);
}));
