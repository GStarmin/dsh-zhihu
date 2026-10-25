import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractZhihuImages, validateZhihuImageUrl, loadZhihuImages } from '../lib/core/zhihu-images.js';
import { zhihuToolContent } from '../lib/tool-content.js';
import { makeZhihuSelfBrowse } from '../lib/core/zhihu-self-browse.js';
import { nativeDefinition } from '../lib/index.js';
import { initialize } from '../lib/paths.js';
import { savePrivateJson } from '../lib/core/zhihu-access.js';
import { createMcpServer } from '../lib/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const url = i => `https://picx.zhimg.com/v2-${String(i).padStart(32,'0')}_r.jpg`;
const sources = n => Array.from({ length:n }, (_,i) => ({ index:i+1, url:url(i+1), alt:'' }));
const load = (items, options, overrides = {}) => loadZhihuImages(items, options, { download: async (raw, max, opts) => {
  assert.equal(max, 8*1024*1024); assert.equal(opts.timeoutMs, 6000); opts.validateUrl(raw);
  return { buffer: png };
}, ...overrides });

test('body image extraction prefers lazy originals and deduplicates CDN aliases and noscript copies', () => {
  const html = `<script><img src="${url(9)}"></script><img src="data:image/svg+xml,<svg viewBox='0 0 1 1'></svg>" data-original="${url(1)}" alt="图&amp;文"><noscript><img src="${url(1).replace('picx','pica')}"></noscript><img data-actualsrc="${url(2)}"><img srcset="${url(3)} 2x, ${url(4)} 1x">`;
  const images=extractZhihuImages(html);
  assert.equal(images.length,3); assert.equal(images[0].alt,'图&文'); assert.deepEqual(images.map(x=>x.url),[url(1),url(2),url(3)]);
});
test('CDN allowlist rejects external URLs, credentials, ports, inline scripts, and private targets', () => {
  for(const raw of ['http://picx.zhimg.com/a.jpg','https://127.0.0.1/a','https://picx.zhimg.com:444/a','https://picx.zhimg.com@evil.test/a','https://picx.zhimg.com.evil.test/a','file:///etc/passwd','https:'+'//user:pw@picx.zhimg.com/a','data:image/svg+xml,<svg/>','https://zhimg.com/a']) assert.throws(()=>validateZhihuImageUrl(raw));
  assert.equal(validateZhihuImageUrl('//pica.zhimg.com/a.jpg'),'https://pica.zhimg.com/a.jpg');
  const images=extractZhihuImages('<img src="https://evil.test/private.jpg"><img src="data:image/svg+xml,placeholder">');
  assert.equal(images.length,1); assert.equal(images[0].url,undefined); assert.ok(images[0].error);
});
test('image loading delivers real binary blocks, is bounded and exposes pagination and failures', async () => {
  let inFlight=0, peak=0;
  const first=await load(sources(5),{}, { download:async () => { peak=Math.max(peak,++inFlight); await new Promise(r=>setTimeout(r,5)); inFlight--; return {buffer:png}; } });
  assert.equal(peak,2); assert.deepEqual(first.imagePage,{total:5,offset:0,attempted:3,loaded:3,nextOffset:3});
  assert.deepEqual(first.imageContent.map(x=>x.index),[1,2,3]); assert.equal(first.imageContent[0].mimeType,'image/png');
  assert.deepEqual(Buffer.from(first.imageContent[0].data,'base64'),png);
  const next=await load(sources(5),{offset:first.imagePage.nextOffset});
  assert.deepEqual(next.imageContent.map(x=>x.index),[4,5]); assert.equal(next.imagePage.nextOffset,undefined);
  const failures=await load([{index:1,url:url(1)},{index:2,error:'不支持来源'}],{}, {download:async()=>{throw new Error('HTTP 403');}});
  assert.equal(failures.imagePage.loaded,0); assert.equal(failures.images.length,2); assert.ok(failures.images.every(x=>x.loaded===false)); assert.equal(failures.imageContent.length,0);
  for(const options of [{offset:-1},{limit:4},{offset:1.5},{limit:0}]) await assert.rejects(load([],options),/offset/);
});
test('non-image bodies, excessive pixels and uncompressible payloads are never delivered', async () => {
  const html=await load(sources(1),{}, {download:async()=>({buffer:Buffer.from('<html>login</html>')})}); assert.equal(html.imagePage.loaded,0);
  const oversized=Buffer.from(png); oversized.writeUInt32BE(100000,16);
  assert.equal((await load(sources(1),{},{download:async()=>({buffer:oversized})})).imagePage.loaded,0);
  assert.equal((await load(sources(1),{},{normalize:async()=>({ok:true,buffer:Buffer.alloc(600*1024)})})).imagePage.loaded,0);
});
test('read_content carries only source-body images and never downloads images while rechecking an upvote', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zhihu-images-proof-')); let loads=0, posts=0;
  const meta={sessionId:'s1',account:{profileUrl:'https://www.zhihu.com/people/bot-fixture'}};
  const self=makeZhihuSelfBrowse({stateDir:dir,currentSession:()=>meta,interactionPolicy:()=>({enabled:true,accountProfile:meta.account.profileUrl}),
    imageLoader:async (items, options)=>{loads++; return load(items,options);},
    answerAPI:{ withSession:work=>work({},meta),content:async()=>({text:'图文正文',title:'标题',imageSources:sources(5),canUpvote:true,transport:'website-api'}),upvote:async()=>{posts++;return{};} }});
  try {
    const read=await self.read('https://www.zhihu.com/answer/2',{offset:3,limit:2});
    assert.equal(read.imagePage.loaded,2); assert.equal(read.imageContent[0].index,4); assert.ok(read.readToken); assert.equal(loads,1);
    await self.upvote({readToken:read.readToken,reason:'认同正文观点'}); assert.equal(posts,1); assert.equal(loads,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('MCP transport returns image blocks and does not spill base64 into text', async () => {
  const data={ok:true,content:'正文',...await load(sources(1),{})};
  const content=zhihuToolContent(data); assert.equal(content.filter(x=>x.type==='image').length,1); assert.ok(!content.filter(x=>x.type==='text').map(x=>x.text).join('').includes(png.toString('base64')));
  const server=createMcpServer({call:async()=>data}), client=new Client({name:'image-test',version:'1.0'}), [a,b]=InMemoryTransport.createLinkedPair();
  try {await Promise.all([server.connect(a),client.connect(b)]); const result=await client.callTool({name:'zhihu_browse',arguments:{action:'read_content',contentUrl:'https://www.zhihu.com/answer/2'}});assert.deepEqual(result.content.filter(x=>x.type==='image').map(x=>x.data),[png.toString('base64')]);}
  finally {await client.close();await server.close();}
});
test('native DSH admits durable images and reports a missing attachment service honestly', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zhihu-native-image-')); initialize(dir);savePrivateJson(path.join(dir,'settings.json'),{allowedSessionIds:['approved']});
  const data={ok:true,...await load(sources(1),{})}, exec={agent:{session:{id:'approved'}},signal:new AbortController().signal};
  const attachment={id:'fixture-durable-image'};
  try {
    const definition=nativeDefinition({stateDir:dir,call:async()=>data,attachments:{saveImages:async inputs=>{assert.equal(inputs[0].mediaType,'image/png');assert.deepEqual(Buffer.from(inputs[0].data),png);return[attachment];}}});
    const value=await definition.execute({action:'read_content'},exec);assert.equal(value.imageContent,undefined);
    const rendered=definition.output.render({},value);assert.deepEqual(rendered.find(x=>x.type==='image'),{type:'image',attachment});
    const unavailable=await nativeDefinition({stateDir:dir,call:async()=>data}).execute({action:'read_content'},exec);assert.equal(unavailable.imagePage.loaded,0);assert.equal(unavailable.imageContent,undefined);assert.equal(unavailable.images[0].loaded,false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
