import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { savePrivateJson } from './core/zhihu-access.js';

export function homeDir(env = process.env) {
  return path.resolve(env.DSH_ZHIHU_HOME || path.join(env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zhihu'));
}
export function settings(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'settings.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('知乎设置不可读取'); return { upvote: { enabled: false }, allowedSessionIds: [] }; }
}
export function initialize(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const name of ['admin-token', 'agent-token']) {
    const file = path.join(stateDir, name);
    try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (!fs.existsSync(path.join(stateDir, 'settings.json'))) savePrivateJson(path.join(stateDir, 'settings.json'), settings(stateDir));
}
export function token(stateDir, kind) {
  if (!['agent', 'admin'].includes(kind)) throw new Error('Invalid credential kind');
  return fs.readFileSync(path.join(stateDir, kind + '-token'), 'utf8').trim();
}
