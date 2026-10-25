import fs from 'node:fs';
import path from 'node:path';
import { serviceUrl } from './client.js';

// This adapter deliberately requires the bridge's live owner/session gate.
// It never falls back to trusting a QQ ID supplied by the model.
export function bridgeAuthorizer({ configPath = process.env.QQ_BRIDGE_CONFIG, url = process.env.QQ_BRIDGE_URL || 'http://127.0.0.1:3100', fetchImpl = fetch } = {}) {
  if (!configPath || !path.isAbsolute(configPath)) throw new Error('QQ_BRIDGE_CONFIG 必须指向管理员指定的绝对配置路径');
  const base = serviceUrl(url);
  return async ({ key, token }) => {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!/^\d+$/.test(String(cfg.ownerQQ)) || key !== 'private:' + cfg.ownerQQ || !token || typeof token !== 'string' || cfg.socialV2?.tools?.zhihuRead === false) throw new Error('知乎只向已授权的管理员私聊开放');
    const sessionId = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), 'state/sessions.json'), 'utf8')).sessions?.[key];
    if (!sessionId || !cfg.consoleToken) throw new Error('桥接会话或管理凭据不可用');
    const response = await fetchImpl(base + '/api/socialV2/autonomy-auth', { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-console-token': cfg.consoleToken, 'x-agent-token': token, 'x-agent-call': '1' },
      body: JSON.stringify({ key, sessionId }), signal: AbortSignal.timeout(4000) });
    if (!response.ok || (await response.json()).allowed !== true) throw new Error('桥接未授予当前管理员会话权限；原版桥接若没有 autonomy-auth 接口，本适配器不会放行');
  };
}
