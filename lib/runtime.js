import fs from 'node:fs';
import path from 'node:path';
import { makeZhihuReader } from './core/zhihu-reader.js';
import { makeZhihuActivityReader } from './core/zhihu-activity-reader.js';
import { savePrivateJson } from './core/zhihu-access.js';
import { homeDir, initialize, settings } from './paths.js';
import { validateCall } from './actions.js';

export function createRuntime({ stateDir = homeDir(), fetchImpl = fetch, requestFactory, now = Date.now } = {}) {
  initialize(stateDir);
  const web = makeZhihuActivityReader({ stateDir, now, ...(requestFactory ? { requestFactory } : {}), interactionPolicy: () => settings(stateDir).upvote || { enabled: false } });
  const api = makeZhihuReader({ credentialsPath: path.join(stateDir, 'zhihu-credentials.json'), fetchImpl, now,
    activitySourceRead: async () => {
      const profile = api.status().activityWatch.profileUrl;
      if (!profile) throw new Error('请在管理页配置目标用户主页');
      return web.read(profile);
    },
    activityCommand: (action, args) => {
      if (action === 'status') return web.status();
      if (action === 'feed') return web.self.feed();
      if (action === 'content') return web.self.read(args.contentUrl, args);
      if (action === 'upvote') return web.self.upvote(args);
      throw new Error('不支持的知乎接口动作');
    } });
  async function status() {
    return { ...api.status(), web: await web.status(), settings: settings(stateDir),
      capabilities: { homeFeed: true, answerBody: true, articleBody: true, bodyImages: true, answerArticleUpvote: true, followFeed: false, followUnfollow: false, privateFavorites: false, pinUpvote: false } };
  }
  async function tool(action, args = {}) {
    validateCall(action, args);
    if (action === 'status') {
      const { web, settings: operatorSettings, ...publicStatus } = await status();
      const { qrImage, ...publicWeb } = web;
      return { ok: true, ...publicStatus, web: publicWeb, upvoteEnabled: operatorSettings.upvote?.enabled === true };
    }
    return api.run(action, args);
  }
  async function admin(action, args = {}) {
    switch (action) {
      case 'configure_api': return { ok: true, ...await api.configure(args.accessSecret) };
      case 'configure_owner': return api.configureOwnerWatch(args);
      case 'disable_owner': return api.disableOwnerWatch();
      case 'configure_target': {
        if (!/^https:\/\/www\.zhihu\.com\/people\/[A-Za-z0-9_-]+$/.test(args.profileUrl || '')) throw new Error('请填写完整的知乎用户主页');
        const file = path.join(stateDir, 'zhihu-owner-watch.json');
        let old = {}; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (old.enabled && old.profileUrl !== args.profileUrl) throw new Error('已绑定本人创作授权，请先停用后再切换目标');
        savePrivateJson(file, { ...old, profileUrl: args.profileUrl });
        return { ok: true };
      }
      case 'login': return web.startLogin();
      case 'logout': await web.logout(); return api.activity.setEnabled(false);
      case 'pause_activity': return api.activity.setEnabled(false);
      case 'resume_activity': return api.activity.setEnabled(true);
      case 'resume_access': return web.resumeAccess();
      case 'settings': {
        if (Object.keys(args).some(k => !['upvoteEnabled', 'allowedSessionIds'].includes(k))) throw new Error('不支持的设置字段');
        const current = settings(stateDir), next = { ...current };
        if (args.upvoteEnabled !== undefined) {
          if (typeof args.upvoteEnabled !== 'boolean') throw new Error('赞同开关必须是布尔值');
          const login = await web.status();
          if (args.upvoteEnabled && !login.saved) throw new Error('请先扫码登录要用于自主赞同的账号');
          next.upvote = { enabled: args.upvoteEnabled, ...(args.upvoteEnabled ? { accountProfile: login.account.profileUrl } : {}) };
        }
        if (args.allowedSessionIds !== undefined) {
          if (!Array.isArray(args.allowedSessionIds) || args.allowedSessionIds.length > 20 || args.allowedSessionIds.some(x => typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(x))) throw new Error('请填写最多 20 个真实 DSH 会话 ID');
          next.allowedSessionIds = [...new Set(args.allowedSessionIds)];
        }
        savePrivateJson(path.join(stateDir, 'settings.json'), next);
        return { ok: true, settings: next };
      }
      default: throw new Error('不支持的管理操作');
    }
  }
  return { stateDir, status, tool, admin, close: () => web.close() };
}
