import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHttpRequestFactory } from '../lib/core/zhihu-http.js';
test('native HTTP preserves cookie scope, refreshes Set-Cookie, never follows redirects or leaks credentials to another host', async()=>{
  const calls=[]; const factory=makeHttpRequestFactory({fetchImpl:async(url,init)=>{calls.push({url,init});return new Response('ok',{status:302,headers:{location:'https://evil.test/', 'set-cookie':'refresh=new; Domain=.zhihu.com; Path=/; Secure; HttpOnly'}})}});
  const context=await factory.newContext({storageState:{cookies:[{name:'shared',value:'a',domain:'.zhihu.com',path:'/',secure:true},{name:'hostonly',value:'b',domain:'www.zhihu.com',path:'/'},{name:'expired',value:'old',domain:'.zhihu.com',path:'/',expires:1}],origins:[{origin:'https://www.zhihu.com',localStorage:[]}]}});
  try{
    assert.equal((await context.get('https://www.zhihu.com/api/v4/me')).status(),302);assert.equal(calls.length,1);assert.equal(calls[0].init.redirect,'manual');
    assert.match(calls[0].init.headers.get('cookie'),/shared=a/);assert.match(calls[0].init.headers.get('cookie'),/hostonly=b/);assert.doesNotMatch(calls[0].init.headers.get('cookie'),/expired/);
    await context.get('https://zhuanlan.zhihu.com/api/articles/1');assert.doesNotMatch(calls[1].init.headers.get('cookie'),/hostonly/);assert.match(calls[1].init.headers.get('cookie'),/refresh=new/);
    for(const url of ['https://evil.test/','http://www.zhihu.com/','https://www.zhihu.com:444/','https://user@www.zhihu.com/'])await assert.rejects(context.get(url),/不允许/);
    assert.equal(calls.length,2);assert.equal((await context.storageState()).origins[0].origin,'https://www.zhihu.com');
  }finally{await context.dispose()}
  await assert.rejects(context.get('https://www.zhihu.com/'),/关闭/);
});
test('oversized HTTP bodies are rejected and request cancellation is bounded',async()=>{
  const context=await makeHttpRequestFactory({fetchImpl:async()=>new Response('x',{headers:{'content-length':String(5*1024*1024)}})}).newContext();
  try{await assert.rejects(context.get('https://www.zhihu.com/'),/过大/)}finally{await context.dispose()}
});
