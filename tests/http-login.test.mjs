import { test } from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { makeZhihuActivityReader } from '../lib/core/zhihu-activity-reader.js';
import { savePrivateJson, makeZhihuAccessGate, ZhihuAccessError } from '../lib/core/zhihu-access.js';
async function fixture(work){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zhihu-http-login-'));let at=10000,confirmed=false,deny=false;const calls=[];
 savePrivateJson(path.join(dir,'zhihu-activity-login.json'),{saved:true,sessionId:'old',account:{profileUrl:'https://www.zhihu.com/people/old'}});
 savePrivateJson(path.join(dir,'zhihu-activity-session.json'),{cookies:[{name:'old-cookie',value:'old'}],origins:[]});
 const factory={newContext:async()=>({dispose:async()=>{},storageState:async()=>({cookies:confirmed?[{name:'z_c0',value:'fixture-login-cookie',domain:'.zhihu.com'}]:[],origins:[]}),fetch:async(url,init)=>{
  calls.push({path:new URL(url).pathname,method:init.method});let data={};const status=deny?403:200;
  if(url.endsWith('/qrcode'))data={token:'fixture-qr-token',link:'https://www.zhihu.com/account/scan/login/fixture-qr-token'};
  else if(url.endsWith('/scan_info'))data={status:confirmed?2:0};else if(url.endsWith('/me'))data={name:'测试账号',url_token:'bot-fixture'};
  return{status:()=>status,text:async()=>JSON.stringify(deny?{error:{code:40362}}:data)};
 }})};
 const reader=makeZhihuActivityReader({stateDir:dir,now:()=>at,requestFactory:factory,voteConfirmation:{autoReconcile:false}});
 try{await work({reader,dir,calls,set:v=>{if('confirmed'in v)confirmed=v.confirmed;if('at'in v)at=v.at;if('deny'in v)deny=v.deny}})}finally{await reader.close();fs.rmSync(dir,{recursive:true,force:true})}
}
async function ready(reader){for(let i=0;i<30;i++){const status=await reader.status();if(status.loginState!=='starting')return status;await new Promise(r=>setTimeout(r,5))}throw new Error('QR timeout')}
test('QR login is HTTP-only, keeps the old session until confirmed, throttles polling and verifies the account before saving',()=>fixture(async({reader,dir,calls,set})=>{
 const auth=makeZhihuAccessGate({stateDir:dir,fileName:'zhihu-account-api-access.json'});auth.record(new ZhihuAccessError('LOGIN_REQUIRED','old expired login'));
 await reader.startLogin();const status=await ready(reader);assert.equal(status.loginState,'waiting_for_scan');assert.match(status.qrImage,/^data:image\/png;base64,/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'zhihu-activity-login.json'))).sessionId,'old');
 const scans=calls.filter(c=>c.path.endsWith('/scan_info')).length;await reader.status();await reader.status();assert.equal(calls.filter(c=>c.path.endsWith('/scan_info')).length,scans);
 set({at:14000,confirmed:true});const saved=await reader.status();assert.equal(saved.loginState,'idle');assert.equal(auth.status().blocked,false);assert.equal(saved.account.profileUrl,'https://www.zhihu.com/people/bot-fixture');
 assert.notEqual(JSON.parse(fs.readFileSync(path.join(dir,'zhihu-activity-login.json'))).sessionId,'old');assert.equal(fs.statSync(path.join(dir,'zhihu-activity-session.json')).mode&0o777,0o600);
 assert.deepEqual(calls.filter(c=>c.method==='POST').map(c=>c.path),['/udid','/api/v3/account/api/login/qrcode']);
}));
test('QR denial is persisted without repeated requests or replacing an existing usable login',()=>fixture(async({reader,dir,calls,set})=>{
 set({deny:true});await reader.startLogin();const status=await ready(reader);assert.equal(status.loginState,'failed');assert.equal(status.accessScopes.login.blocked,true);const count=calls.length;
 await reader.status();await assert.rejects(reader.startLogin(),/恢复前/);assert.equal(calls.length,count);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'zhihu-activity-login.json'))).sessionId,'old');
}));
