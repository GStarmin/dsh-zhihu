import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './runtime.js';
import { token } from './paths.js';

const pagePath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const scriptPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
export function trustedRequest(req) {
  let host; try { host = new URL('http://' + req.headers.host); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== host.host || new URL(req.headers.origin).protocol !== 'http:') return false; } catch { return false; }
  }
  return true;
}
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > 16384) throw new Error('请求过大'); chunks.push(part); }
  const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请求必须是 JSON 对象');
  return data;
}
export async function startServer({ port = 3120, runtime = createRuntime() } = {}) {
  const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      if (!trustedRequest(req)) return send(res, 403, { ok: false, error: '不受信任的 Host/Origin' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ['/', '/app.js'].includes(url.pathname)) {
        res.writeHead(200, { 'content-type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
        return res.end(await readFile(url.pathname === '/' ? pagePath : scriptPath));
      }
      const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const isTool = url.pathname === '/api/tool';
      if (!equal(auth, token(runtime.stateDir, isTool ? 'agent' : 'admin'))) return send(res, 401, { ok: false, error: '未授权' });
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { ok: true, ...await runtime.status() });
      if (req.method !== 'POST') return send(res, 404, { ok: false, error: '接口不存在' });
      const data = await body(req);
      if (isTool) return send(res, 200, await runtime.tool(data.action, data.args || {}));
      if (url.pathname === '/api/admin') return send(res, 200, await runtime.admin(data.action, data.args || {}));
      send(res, 404, { ok: false, error: '接口不存在' });
    } catch (e) { send(res, 400, { ok: false, error: String(e.message).split('\n')[0].slice(0, 500) }); }
  });
  server.requestTimeout = 50000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, runtime, url: 'http://127.0.0.1:' + server.address().port,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.close(); } };
}
