import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import { makeZhihuActivityReader } from '../lib/core/zhihu-activity-reader.js';
import { makeZhihuDirectAPI } from '../lib/core/zhihu-direct-api.js';
import { savePrivateJson, makeZhihuAccessGate, ZhihuAccessError } from '../lib/core/zhihu-access.js';
const actor='https://www.zhihu.com/people/bot-fixture',profile='https://www.zhihu.com/people/owner-fixture';
async function fixture(work){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zhihu-http-activity-')),calls=[];let voting=0,deny='',badNext=false,wrongActor=false,articleVoteKnown=true;
 savePrivateJson(path.join(dir,'zhihu-activity-login.json'),{saved:true,sessionId:'session-http',account:{profileUrl:actor}});savePrivateJson(path.join(dir,'zhihu-activity-session.json'),{cookies:[],origins:[]});
 const factory={newContext:async()=>({storageState:async()=>({cookies:[],origins:[]}),dispose:async()=>{},fetch:async(raw,init)=>{
  const u=new URL(raw);calls.push({url:raw,method:init.method,data:init.data});let data,status=200;
  if(u.pathname==='/api/v4/me')data={url_token:'bot-fixture'};
  else if(u.pathname.includes('/moments/')){
   const page=Number(u.searchParams.get('page_num')||0);
   data={data:[{verb:'MEMBER_VOTEUP_ANSWER',actor:{url_token:wrongActor?'other':'owner-fixture'},created_time:1700000000,target:{type:'answer',id:String(page+2),question:{id:'1',title:'点赞的回答'},excerpt:'摘要'}}],paging:{is_end:page===2,next:badNext?'https://evil.test/':'https://www.zhihu.com/api/v3/moments/owner-fixture/activities?offset='+String(page+1)+'&page_num='+String(page+1)}};
   if(deny==='activity'){status=403;data={error:{code:40362}}}
  }else if(u.pathname.includes('/feed/'))data={data:[{target:{type:'answer',id:'2',question:{id:'1',title:'推荐问题'}}}]};
  else if(u.pathname.endsWith('/voters')){assert.deepEqual(init.data,{type:'up'});voting=1;data={success:true}}
  else if(u.hostname==='zhuanlan.zhihu.com')data={id:'2087854578842784085',type:'article',title:'文章正文',content:'<p>完整正文</p>',voting:articleVoteKnown?voting:undefined,updated:1700000000};
  else data={type:'answer',id:'2',content:'<p>回答正文</p>',question:{title:'回答'},relationship:{voting:0}};
  return {status:()=>status,headers:()=>({}),text:async()=>JSON.stringify(data)};
 }})};
 const reader=makeZhihuActivityReader({stateDir:dir,requestFactory:factory,imageLoader:async()=>({images:[],imageContent:[],imagePage:{total:0,loaded:0}}),interactionPolicy:()=>({enabled:true,accountProfile:actor}),voteConfirmation:{autoReconcile:false,sleep:async()=>{}}});
 try{await work({dir,calls,factory,reader,set:v=>{if('deny'in v)deny=v.deny;if('badNext'in v)badNext=v.badNext;if('wrongActor'in v)wrongActor=v.wrongActor;if('articleVoteKnown'in v)articleVoteKnown=v.articleVoteKnown}})}finally{await reader.close();fs.rmSync(dir,{recursive:true,force:true})}
}
test('HTTP activities page through returned cursors and preserve old browser-era deduplication IDs',()=>fixture(async({reader,calls,dir})=>{
 const old=makeZhihuAccessGate({stateDir:dir});old.record(new ZhihuAccessError('ACCESS_DENIED','retired browser denial'));
 const result=await reader.read(profile);assert.equal(result.transport,'website-api');assert.equal(result.items.length,3);assert.equal(result.sourcePaging.pages,3);assert.equal(result.sourcePaging.isEnd,true);
 assert.equal(result.items[0].id,crypto.createHash('sha256').update(profile+'\nlike\nhttps://www.zhihu.com/question/1/answer/2').digest('hex'));
 const before=calls.length;assert.equal((await reader.read(profile)).cached,true);assert.equal(calls.length,before);assert.equal(old.status().blocked,true);
 assert.ok(Object.values((await reader.status()).transports).every(x=>x==='website-api'));
}));
test('a denied activity request persists only that scope, survives restart and cannot pause recommendation or answer reading',()=>fixture(async({reader,set,dir,calls,factory})=>{
 set({deny:'activity'});await assert.rejects(reader.read(profile),/40362/);const count=calls.length;
 await assert.rejects(reader.read(profile),/恢复前/);assert.equal(calls.length,count);
 assert.equal((await reader.self.feed()).items.length,1);assert.equal((await reader.self.read('https://www.zhihu.com/answer/2')).content,'回答正文');
 assert.equal((await reader.status()).accessScopes.activity.blocked,true);assert.equal((await reader.status()).accessScopes.feed.blocked,false);
 const restarted=makeZhihuActivityReader({stateDir:dir,requestFactory:factory,voteConfirmation:{autoReconcile:false}});const now=calls.length;
 try{await assert.rejects(restarted.read(profile),/恢复前/);assert.equal(calls.length,now)}finally{await restarted.close()}
}));
test('foreign pagination and mismatched actors cannot be silently consumed as the owner activity',()=>fixture(async({reader,set,calls})=>{
 set({badNext:true});await assert.rejects(reader.read(profile),/越界/);assert.ok(calls.every(c=>new URL(c.url).hostname==='www.zhihu.com'));
 set({badNext:false,wrongActor:true});await assert.rejects(reader.read(profile),/身份不符/);
}));
test('article body and one confirmed upvote use HTTP with exact 64-bit IDs; unknown voting remains read-only',()=>fixture(async({reader,calls,set})=>{
 const url='https://zhuanlan.zhihu.com/p/2087854578842784085';const read=await reader.self.read(url);assert.equal(read.content,'完整正文');assert.ok(read.readToken);assert.equal(read.transport,'website-api');
 const result=await reader.self.upvote({readToken:read.readToken,reason:'认同文章观点'});assert.equal(result.confirmed,true);assert.equal(result.submitted,true);
 assert.deepEqual(calls.filter(x=>x.method==='POST').map(x=>x.url),['https://zhuanlan.zhihu.com/api/articles/2087854578842784085/voters']);
 set({articleVoteKnown:false});assert.equal((await reader.self.read(url)).readToken,undefined);
}));
test('HTTP write whitelist rejects downvotes, extra bodies, redirected targets and cross-scope writes before POST',()=>fixture(async({factory,dir,calls})=>{
 const api=makeZhihuDirectAPI({stateDir:dir,requestFactory:factory,autoReconcile:false});
 try{for(const [url,data]of [['/api/v4/answers/2/voters',{type:'down'}],['/api/v4/answers/2/voters',{type:'up',extra:1}],['https://evil.test/api/v4/answers/2/voters',{type:'up'}],['https://zhuanlan.zhihu.com/api/articles/2/voters',{type:'up'}]])await assert.rejects(api.withSession(c=>c.send(url,'POST',data)),/不允许/);assert.equal(calls.some(x=>x.method==='POST'),false)}finally{await api.close()}
}));
