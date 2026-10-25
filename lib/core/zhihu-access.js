import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class ZhihuAccessError extends Error {
  constructor(code, message, detail = {}) {
    super(message); this.name = 'ZhihuAccessError'; this.code = code; this.detail = detail;
  }
}

export function assertZhihuPage({ httpStatus, pathname, contentVisible, text = '', challengeVisible = false }) {
  if (pathname?.startsWith('/signin')) throw new ZhihuAccessError('LOGIN_REQUIRED', '知乎需要重新登录，请在控制台扫码；已暂停网页读取');
  if (challengeVisible) throw new ZhihuAccessError('VERIFICATION_REQUIRED', '知乎显示了验证控件，需要本人完成验证；已暂停网页读取');
  // The initial document may be 403 while its authenticated app renders normally.
  if (contentVisible) return;
  let data; try { data = JSON.parse(text); } catch {}
  const businessCode = data?.error?.code;
  const detail = { httpStatus: httpStatus ?? null, businessCode: businessCode ?? null };
  if (httpStatus === 429 || /请求过于频繁/.test(text)) throw new ZhihuAccessError('RATE_LIMITED', '知乎限制了网页访问频率，已暂停读取，不自动重试', detail);
  if (businessCode === 40362 || businessCode === 62 || /暂时限制本次访问|网络环境存在异常|访问异常/.test(text)) {
    throw new ZhihuAccessError('ACCESS_DENIED', `知乎拒绝本次访问（HTTP ${httpStatus ?? '未知'}${businessCode ? `，错误码 ${businessCode}` : ''}），未确认出现验证码；已暂停网页读取`, detail);
  }
  if (/请完成安全验证|验证后即可|请输入验证码|安全验证/.test(text)) throw new ZhihuAccessError('VERIFICATION_REQUIRED', '知乎页面要求验证，需要本人处理；已暂停网页读取', detail);
  if (httpStatus >= 400) throw new ZhihuAccessError('ACCESS_DENIED', `知乎拒绝本次网页访问（HTTP ${httpStatus}），已暂停读取`, detail);
  throw new Error('知乎页面没有正常加载，停止本轮浏览；未把加载失败认定为验证码或没有内容');
}

export function savePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}

export function makeZhihuAccessGate({ stateDir, now = Date.now, fileName = 'zhihu-web-access.json', channel = '网页' }) {
  const file = path.join(stateDir, fileName);
  const status = () => {
    try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { blocked: s.blocked === true, code: s.code || null, message: s.message || null, at: s.at || null, detail: s.detail || {} }; }
    catch (e) { if (e.code === 'ENOENT') return { blocked: false }; throw new Error(`知乎访问状态不可读，停止${channel}访问`); }
  };
  const assertAllowed = () => { const s = status(); if (s.blocked) throw new Error(s.message + `。请在控制台查看受阻状态；恢复前不会再次访问知乎${channel}`); };
  const record = error => {
    if (!(error instanceof ZhihuAccessError)) return;
    savePrivateJson(file, { blocked: true, code: error.code, message: error.message, detail: error.detail, at: now() });
  };
  const resume = () => { savePrivateJson(file, { blocked: false, at: now() }); return { ok: true, access: status(), note: '仅恢复程序访问权限，没有向知乎请求，也不代表知乎限制已解除；再次被拒会重新暂停' }; };
  return { status, assertAllowed, record, resume };
}

export async function persistZhihuSession({ context, sessionId, sessionFile, metaFile }) {
  const current = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return null; } };
  if (!sessionId || current()?.sessionId !== sessionId) return false;
  const state = await context.storageState();
  if (current()?.sessionId !== sessionId) return false;
  savePrivateJson(sessionFile, state);
  return true;
}
