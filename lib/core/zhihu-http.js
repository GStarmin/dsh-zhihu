// Native HTTP and RFC 6265 cookies. No browser process, redirects or retries.
import fs from 'node:fs';
import { CookieJar } from 'tough-cookie';
const HOSTS = new Set(['www.zhihu.com', 'zhuanlan.zhihu.com']);
export function assertHttpTarget(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !HOSTS.has(url.hostname)) throw new Error('不允许的知乎 HTTP 地址');
  return url;
}
export function makeHttpRequestFactory({ fetchImpl = fetch } = {}) {
  return { async newContext(options = {}) {
    const initial = typeof options.storageState === 'string' ? JSON.parse(fs.readFileSync(options.storageState, 'utf8')) : options.storageState || {};
    const jar = new CookieJar(), pending = new Set(); let closed = false;
    async function addCookies(cookies) { for (const c of cookies) {
      const host = String(c.domain || '').replace(/^\./, '');
      if (!['zhihu.com', ...HOSTS].includes(host) || !c.name || /[\r\n;]/.test(c.name + c.value)) continue;
      let text = c.name + '=' + c.value + '; Path=' + (c.path || '/');
      if (c.domain.startsWith('.')) text += '; Domain=' + c.domain;
      if (c.sameSite) text += '; SameSite=' + c.sameSite;
      if (c.secure) text += '; Secure'; if (c.httpOnly) text += '; HttpOnly';
      if (c.expires > 0) text += '; Expires=' + new Date(c.expires * 1000).toUTCString();
      await jar.setCookie(text, 'https://' + host + (c.path || '/'), { ignoreError: true });
    } }
    await addCookies(initial.cookies || []);
    async function request(raw, init = {}) {
      if (closed) throw new Error('HTTP 会话已关闭');
      const url = assertHttpTarget(raw), controller = new AbortController(); pending.add(controller);
      const timer = setTimeout(() => controller.abort(), init.timeout || options.timeout || 10000); timer.unref();
      try {
        const headers = new Headers({ ...options.extraHTTPHeaders, ...init.headers });
        headers.set('user-agent', options.userAgent || 'dsh-zhihu/0.2');
        const cookie = await jar.getCookieString(url.href); if (cookie) headers.set('cookie', cookie); else headers.delete('cookie');
        let body; if (init.data !== undefined) { body = JSON.stringify(init.data); headers.set('content-type', 'application/json'); }
        const response = await fetchImpl(url.href, { method: init.method || 'GET', headers, body, redirect: 'manual', signal: controller.signal });
        for (const value of response.headers.getSetCookie()) await jar.setCookie(value, url.href, { ignoreError: true });
        const limit = 4 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('知乎 HTTP 响应过大'); }
        const chunks = []; let size = 0;
        if (response.body) for await (const part of response.body) {
          size += part.length; if (size > limit) { controller.abort(); throw new Error('知乎 HTTP 响应过大'); } chunks.push(part);
        }
        const buffer = Buffer.concat(chunks), text = buffer.toString('utf8');
        return { status: () => response.status, headers: () => Object.fromEntries(response.headers), text: async () => text, json: async () => JSON.parse(text), body: async () => buffer };
      } finally { clearTimeout(timer); pending.delete(controller); }
    }
    return { addCookies, fetch: request, get: (url, init) => request(url, { ...init, method: 'GET' }), post: (url, init) => request(url, { ...init, method: 'POST' }),
      storageState: async () => ({ cookies: (await jar.serialize()).cookies.map(c => ({ name: c.key, value: c.value, domain: (c.hostOnly ? '' : '.') + c.domain, path: c.path || '/', expires: c.expires && c.expires !== 'Infinity' ? Date.parse(c.expires) / 1000 : -1, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite ? c.sameSite[0].toUpperCase() + c.sameSite.slice(1) : 'Lax' })), origins: initial.origins || [] }),
      dispose: async () => { closed = true; for (const c of pending) c.abort(); pending.clear(); } };
  } };
}
export const http = makeHttpRequestFactory();
