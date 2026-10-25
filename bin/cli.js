#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, initialize, token } from '../lib/paths.js';
import { startServer } from '../lib/server.js';

const command = process.argv[2] || 'help', stateDir = homeDir();
if (command === 'init') { initialize(stateDir); console.log('Initialized: ' + stateDir); }
else if (command === 'admin-token') { console.log(token(stateDir, 'admin')); }
else if (command === 'serve') {
  initialize(stateDir);
  const lock = path.join(stateDir, '.daemon.lock');
  try {
    const existing = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(existing) || existing < 1) throw new Error('Invalid lock');
    try { process.kill(existing, 0); throw new Error('该数据目录已有服务在运行'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; fs.unlinkSync(lock); }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(lock, String(process.pid), { mode: 0o600, flag: 'wx' });
  const unlock = () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {} };
  process.on('exit', unlock);
  const port = Number(process.env.DSH_ZHIHU_PORT || 3120);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const app = await startServer({ port });
  console.log('Zhihu manager: ' + app.url + '\nCredentials are stored in ' + stateDir + '; use dsh-zhihu admin-token to display the management token.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
} else {
  console.log('dsh-zhihu init | serve | admin-token\nEnvironment: DSH_ZHIHU_HOME, DSH_ZHIHU_PORT, DSH_ZHIHU_CHROMIUM');
  if (command !== 'help' && command !== '--help') process.exitCode = 1;
}
