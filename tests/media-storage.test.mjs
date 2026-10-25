import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeZhihuMediaStorage, storageUsage } from '../lib/core/zhihu-media-storage.js';
import { normalizeImageForModel } from '../lib/core/media-normalize.js';
const DAY = 86400000, at = 1900000000000;
function fixture(fn) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zhihu-media-storage-')),stateDir=path.join(dir,'state'),attachmentDir=path.join(dir,'attachments'),temporary=path.join(stateDir,'zhihu-media-tmp');
  fs.mkdirSync(temporary,{recursive:true,mode:0o700});fs.mkdirSync(attachmentDir,{mode:0o700});
  const workspace=(name,age=DAY+1,data='raw-image')=>{const p=path.join(temporary,name);fs.mkdirSync(p,{mode:0o700});fs.writeFileSync(path.join(p,'input.jpg'),data);fs.utimesSync(p,(at-age)/1000,(at-age)/1000);return p;};
  return Promise.resolve().then(()=>fn({dir,stateDir,attachmentDir,temporary,workspace})).finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
}
test('only stale plugin-owned workspaces are removed; recent, unknown and shared attachments survive',()=>fixture(({stateDir,attachmentDir,temporary,workspace})=>{
  const old=workspace('qqb-media-Ab1234'),recent=workspace('qqb-media-Cd5678',1000),unknown=workspace('user-workspace-old');
  fs.writeFileSync(path.join(attachmentDir,'old-chat-image.jpg'),'keep-chat-image');fs.utimesSync(attachmentDir,1,1);
  const media=makeZhihuMediaStorage({stateDir,attachmentDir,now:()=>at}),status=media.status();
  assert.equal(fs.existsSync(old),false);assert.ok(fs.existsSync(recent));assert.ok(fs.existsSync(unknown));
  assert.equal(fs.readFileSync(path.join(attachmentDir,'old-chat-image.jpg'),'utf8'),'keep-chat-image');
  assert.equal(status.temporary.lastCleanup.removedWorkspaces,1);assert.equal(status.temporary.lastCleanup.removedBytes,9);
  assert.equal(status.attachments.autoDeletion,false);assert.equal(status.attachments.shared,true);assert.equal(status.attachments.bytes,15);
  assert.equal(JSON.stringify(status).includes(temporary),false);
}));
test('symbolic workspace links and links inside a removed workspace never delete their targets',()=>fixture(({dir,stateDir,attachmentDir,temporary,workspace})=>{
  const outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep.txt'),'outside');
  fs.symlinkSync(outside,path.join(temporary,'qqb-media-Symlink'));
  const old=workspace('qqb-media-Delete1');fs.symlinkSync(outside,path.join(old,'linked-folder'));fs.utimesSync(old,(at-DAY-1)/1000,(at-DAY-1)/1000);
  const media=makeZhihuMediaStorage({stateDir,attachmentDir,now:()=>at});
  assert.equal(fs.existsSync(old),false);assert.equal(fs.lstatSync(path.join(temporary,'qqb-media-Symlink')).isSymbolicLink(),true);assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'outside');
  assert.equal(media.status().temporary.lastCleanup.removedWorkspaces,1);
}));
test('a symlinked or non-private temporary root fails closed without deleting external directories',()=>fixture(({dir,stateDir,attachmentDir,temporary})=>{
  fs.rmdirSync(temporary);const outside=path.join(dir,'outside');fs.mkdirSync(outside);const external=path.join(outside,'qqb-media-Old123');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'keep'),'x');fs.utimesSync(external,1,1);fs.symlinkSync(outside,temporary);
  let media=makeZhihuMediaStorage({stateDir,attachmentDir,now:()=>at});assert.ok(media.status().temporary.error);assert.ok(fs.existsSync(external));assert.equal(media.status().temporary.lastCleanup.removedWorkspaces,0);
  fs.unlinkSync(temporary);fs.mkdirSync(temporary,{mode:0o755});media=makeZhihuMediaStorage({stateDir,attachmentDir,now:()=>at});assert.ok(media.status().temporary.error);
}));
test('storage statistics are bounded, skip symlinks and never return file names or contents',()=>fixture(({dir,attachmentDir})=>{
  fs.writeFileSync(path.join(attachmentDir,'a'),'abc');fs.writeFileSync(path.join(attachmentDir,'b'),'defg');fs.writeFileSync(path.join(attachmentDir,'c'),'hijkl');
  fs.symlinkSync(dir,path.join(attachmentDir,'linked-parent'));
  assert.deepEqual(storageUsage(attachmentDir),{available:true,files:3,bytes:12,partial:false});
  const partial=storageUsage(attachmentDir,2);assert.equal(partial.partial,true);assert.ok(partial.files<=2);assert.ok(partial.bytes<=12);
  assert.equal(storageUsage(path.join(dir,'absent')).available,false);
  assert.equal(storageUsage(path.join(attachmentDir,'linked-parent')).available,false);
}));
test('regular reads route normalization to the private plugin directory and leave no raw image archive',()=>fixture(async({stateDir,attachmentDir,temporary})=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');let seen;
  const media=makeZhihuMediaStorage({stateDir,attachmentDir,now:()=>at,download:async()=>({buffer:png}),normalize:async(buffer,mime,limits)=>{seen=limits.tmpDir;return normalizeImageForModel(buffer,mime,limits);}});
  const images=await media.loadImages([{index:1,url:'https://picx.zhimg.com/v2-12345678901234567890123456789012_r.jpg'}],{});
  assert.equal(images.imagePage.loaded,1);assert.equal(seen,temporary);assert.equal(fs.statSync(temporary).mode&0o777,0o700);assert.equal(media.status().temporary.files,0);assert.equal(media.status().attachments.files,0);
}));
test('stale cleanup runs again on later reads while usage caching remains bounded to one minute',()=>fixture(async({stateDir,attachmentDir,workspace})=>{
  let clock=at;const media=makeZhihuMediaStorage({stateDir,attachmentDir,now:()=>clock});const first=media.status();
  fs.writeFileSync(path.join(attachmentDir,'new-chat'),'new');assert.equal(media.status().attachments.files,first.attachments.files);
  clock+=60001;assert.equal(media.status().attachments.files,1);
  const abandoned=workspace('qqb-media-Later1');await media.loadImages([],{});assert.ok(fs.existsSync(abandoned));
  clock+=3600000;await media.loadImages([],{});assert.equal(fs.existsSync(abandoned),false);assert.equal(fs.readFileSync(path.join(attachmentDir,'new-chat'),'utf8'),'new');
}));
