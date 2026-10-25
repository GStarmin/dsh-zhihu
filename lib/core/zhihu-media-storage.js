// Only this plugin's private temporary workspaces may be removed. Shared DSH
// attachments are measured read-only, never deleted by this plugin.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadZhihuImages } from './zhihu-images.js';
import { normalizeImageForModel } from './media-normalize.js';
const DAY = 24 * 60 * 60 * 1000, HOUR = 60 * 60 * 1000;
const isMissing = error => error.code === 'ENOENT';
export function storageUsage(root, maxEntries = 10000) {
  const usage = { available: false, files: 0, bytes: 0, partial: false };
  let first; try { first = fs.lstatSync(root); } catch (error) { if (isMissing(error)) return usage; return { ...usage, error: '存储占用暂不可读取' }; }
  if (!first.isDirectory() || first.isSymbolicLink()) return { ...usage, error: '存储根目录不是普通目录，未跟随链接' };
  usage.available = true;
  const stack = [root]; let inspected = 0;
  while (stack.length && !usage.partial) {
    const directory = stack.pop();
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { usage.partial = true; break; }
    for (const entry of entries) {
      if (++inspected > maxEntries) { usage.partial = true; break; }
      const full = path.join(directory, entry.name);
      try {
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) stack.push(full);
        else if (stat.isFile()) { usage.files++; usage.bytes += stat.size; }
      } catch { usage.partial = true; }
    }
  }
  return usage;
}
export function makeZhihuMediaStorage({ stateDir, now = Date.now,
  attachmentDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'attachments'), normalize = normalizeImageForModel, download } = {}) {
  const temporaryRoot = path.join(path.resolve(stateDir), 'zhihu-media-tmp');
  let cleanupAt = null, lastCleanup = null, cached = null;
  function assertRoot(create = false) {
    if (create) fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
    let stat; try { stat = fs.lstatSync(temporaryRoot); } catch (error) { if (isMissing(error) && !create) return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('知乎临时目录必须是当前用户独占的普通目录');
    return true;
  }
  function cleanup() {
    const result = { at: now(), removedWorkspaces: 0, removedBytes: 0 };
    try {
      if (assertRoot()) {
        for (const name of fs.readdirSync(temporaryRoot)) {
          if (result.removedWorkspaces >= 100) break;
          if (!/^qqb-media-[A-Za-z0-9_-]{6,}$/.test(name)) continue;
          const full = path.join(temporaryRoot, name), stat = fs.lstatSync(full);
          if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.mtimeMs > now() - DAY) continue;
          const usage = storageUsage(full);
          if (!usage.available || usage.partial) continue;
          fs.rmSync(full, { recursive: true, force: false });
          result.removedWorkspaces++; result.removedBytes += usage.bytes;
        }
      }
    } catch { result.error = '知乎临时目录清理未完成，请检查目录权限或链接；未清理聊天附件'; }
    cleanupAt = now(); lastCleanup = result; cached = null; return result;
  }
  function status() {
    if (cached && now() - cached.at >= 0 && now() - cached.at < 60000) return cached.value;
    let temporary;
    try { assertRoot(); temporary = storageUsage(temporaryRoot); } catch { temporary = { available: false, files: 0, bytes: 0, partial: false, error: '临时目录权限或类型不符合要求，未清理' }; }
    const value = { temporary: { ...temporary, cleanupAfterHours: 24, ...(lastCleanup ? { lastCleanup } : {}) },
      attachments: { ...storageUsage(attachmentDir), shared: true, autoDeletion: false },
      limits: { maxImagesPerRead: 3, maxSourceBytes: 8 * 1024 * 1024, maxModelBytesPerImage: 512 * 1024 },
      note: '下载原图不长期归档；正常缩图结束即删除临时文件。启动及后续图片读取时清理超过 24 小时的知乎专属遗留工作目录。DSH 共享附件仅统计、不删除；它们可能仍被聊天历史引用，新图会继续占用空间。占用为文件逻辑字节数，partial=true 表示仅完成部分扫描。' };
    cached = { at: now(), value }; return value;
  }
  async function loadImages(sources, options) {
    if (cleanupAt === null || now() - cleanupAt >= HOUR || now() < cleanupAt) cleanup();
    try {
      return await loadZhihuImages(sources, options, { ...(download ? { download } : {}), normalize: (buffer, mime, limits) => {
        assertRoot(true);
        return normalize(buffer, mime, { ...limits, tmpDir: temporaryRoot });
      } });
    } finally { cached = null; }
  }
  cleanup();
  return { status, loadImages, cleanup };
}
