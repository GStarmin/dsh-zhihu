import { homeDir, token } from './paths.js';

export function serviceUrl(raw = process.env.DSH_ZHIHU_URL || 'http://127.0.0.1:3120') {
  const u = new URL(raw);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('知乎服务地址必须是本机 HTTP 根地址');
  return u.origin;
}
export function createClient({ stateDir = homeDir(), url = serviceUrl(), agentToken, fetchImpl = fetch } = {}) {
  const base = serviceUrl(url);
  return async (action, args = {}, signal) => {
    const response = await fetchImpl(base + '/api/tool', { method: 'POST', redirect: 'error',
      headers: { authorization: 'Bearer ' + (agentToken || token(stateDir, 'agent')), 'content-type': 'application/json' },
      body: JSON.stringify({ action, args }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(48000)]) : AbortSignal.timeout(48000) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `知乎服务返回 HTTP ${response.status}`);
    return result;
  };
}
